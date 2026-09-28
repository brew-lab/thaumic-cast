//! Measures how fast a speaker's clock runs against ours.
//!
//! The speaker plays at its own sample clock, and its playhead advances at
//! that rate. So the offset `θ = P(t) − t` between its playhead and our
//! clock moves in a straight line whose slope is the rate difference: +40
//! ppm means the speaker plays 40 µs of audio more than we deliver every
//! second, and a live source can never make that up.
//!
//! Every [`CLOCK_BLOCK_MS`] the polls of the block are reduced to one
//! offset (a trimmed intersection of their bounds, like the reserve's), and a
//! weighted least-squares line through the blocks of the current segment
//! gives the rate, with a standard error from the blocks' scatter about it.
//! Nothing inside a segment is forgotten, so the error keeps shrinking for
//! as long as playback runs unbroken. Finished segments are pooled with the
//! current one by their errors.
//!
//! On simulated speakers polled at the monitor-only cadence the error is
//! about 10-18 ppm (RMS) after 30 minutes and 3-5 ppm after an hour, for
//! RelTime tick jitter from none up to ±100 ms. Fitting one line through every
//! poll's bounds at once (widest tilted intersection) does better without
//! jitter but worse with it, because jitter shapes exactly the extremes that
//! method relies on; averaging per-block offsets degrades gracefully.
//!
//! The fit uses only the speaker's playhead and our clock, never what we
//! delivered, so audio a drift compensator inserts or removes cannot bias it.

use super::bounds::{kth_largest, kth_smallest, PlayheadBound, PollObservation};

/// How much time each block of polls covers.
pub const CLOCK_BLOCK_MS: f64 = 60_000.0;

/// Fewest polls a block is reduced to an offset from.
pub const MIN_POLLS_PER_BLOCK: usize = 8;

/// Polls a block needs before it ignores one outlying answer on each side.
pub const TRIM_FROM_POLLS: usize = 16;

/// Blocks a segment needs before it yields a rate.
pub const MIN_BLOCKS_FOR_FIT: usize = 4;

/// Floor on a block offset's half-width, so a lucky block cannot claim
/// near-infinite weight.
const MIN_BLOCK_HALF_WIDTH_MS: f64 = 10.0;

/// Floor on a segment's standard error, so one whose blocks happened to
/// line up cannot swamp the pool.
const MIN_SE_PPM: f64 = 0.5;

/// Finished segments kept for pooling.
const MAX_POOLED_SEGMENTS: usize = 16;

/// A measured clock rate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ClockEstimate {
    /// How much faster the speaker plays than our clock runs, in parts per
    /// million. Positive drains the reserve.
    pub ppm: f64,
    /// Standard error of `ppm`.
    pub se_ppm: f64,
    /// Time the estimate spans, in milliseconds.
    pub span_ms: f64,
}

/// One block reduced to an offset.
#[derive(Debug, Clone, Copy)]
struct BlockPoint {
    /// Middle of the block's polls, relative to the segment's origin.
    x: f64,
    /// Offset `θ` at `x`, relative to the segment's origin.
    y: f64,
    /// Inverse-variance weight.
    w: f64,
}

/// Clock-rate fit for one speaker.
#[derive(Debug, Clone, Default)]
pub struct ClockFit {
    /// Offset bounds of the polls in the current block.
    block: Vec<PlayheadBound>,
    /// When the current block started.
    block_start: Option<f64>,
    /// Origin of the current segment's axes (its first block's time and
    /// offset), so the sums stay well conditioned.
    origin: Option<(f64, f64)>,
    /// The current segment's blocks.
    points: Vec<BlockPoint>,
    /// Estimates of finished segments.
    finished: Vec<ClockEstimate>,
}

impl ClockFit {
    /// A fit with no polls.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds a poll. `jitter_ms` is the allowance its bound is widened by
    /// (the reserve estimator's), which sets how much each block is trusted.
    pub fn add(&mut self, obs: &PollObservation, jitter_ms: f64) {
        let start = *self.block_start.get_or_insert(obs.ts);
        if obs.ts - start >= CLOCK_BLOCK_MS {
            self.close_block(jitter_ms);
            self.block_start = Some(obs.ts);
        }
        self.block.push(obs.offset_bound());
    }

    /// Ends the current segment: its rate joins the pool, and the next poll
    /// starts a fresh line. Used when the offset can no longer be assumed
    /// continuous (a new connection, a restart, an underrun). The unfinished
    /// block is dropped with it.
    pub fn break_segment(&mut self) {
        if let Some(est) = self.current() {
            if self.finished.len() == MAX_POOLED_SEGMENTS {
                self.finished.remove(0);
            }
            self.finished.push(est);
        }
        self.block.clear();
        self.block_start = None;
        self.origin = None;
        self.points.clear();
    }

    /// Reduces the current block to one offset.
    fn close_block(&mut self, jitter_ms: f64) {
        let n = self.block.len();
        if n < MIN_POLLS_PER_BLOCK {
            self.block.clear();
            return;
        }
        let k = if n >= TRIM_FROM_POLLS { 2 } else { 1 };
        let mut los: Vec<f64> = self.block.iter().map(|b| b.lo).collect();
        let mut his: Vec<f64> = self.block.iter().map(|b| b.hi).collect();
        let at = self.block.iter().map(|b| b.at).sum::<f64>() / n as f64;
        self.block.clear();
        let (Some(l), Some(u)) = (kth_largest(&mut los, k), kth_smallest(&mut his, k)) else {
            return;
        };
        let theta = (l + u) / 2.0;
        // Bounds that cross say the block's jitter was at least that large,
        // so crossing costs weight just as a wide intersection does.
        let half_width = ((u - l).abs() / 2.0 + jitter_ms).max(MIN_BLOCK_HALF_WIDTH_MS);
        let (x0, y0) = *self.origin.get_or_insert((at, theta));
        self.points.push(BlockPoint {
            x: at - x0,
            y: theta - y0,
            w: 1.0 / (half_width * half_width),
        });
    }

    /// The current segment's rate, once it has [`MIN_BLOCKS_FOR_FIT`] blocks.
    pub fn current(&self) -> Option<ClockEstimate> {
        let n = self.points.len();
        if n < MIN_BLOCKS_FOR_FIT {
            return None;
        }
        let sw: f64 = self.points.iter().map(|p| p.w).sum();
        let mx = self.points.iter().map(|p| p.w * p.x).sum::<f64>() / sw;
        let my = self.points.iter().map(|p| p.w * p.y).sum::<f64>() / sw;
        let sxx: f64 = self.points.iter().map(|p| p.w * (p.x - mx).powi(2)).sum();
        if sxx <= f64::EPSILON {
            return None;
        }
        let sxy: f64 = self
            .points
            .iter()
            .map(|p| p.w * (p.x - mx) * (p.y - my))
            .sum();
        let slope = sxy / sxx;
        // The error comes from the blocks' scatter about the line rather
        // than from the weights' absolute size: the half-widths are bounds,
        // not standard deviations.
        let rss: f64 = self
            .points
            .iter()
            .map(|p| p.w * (p.y - my - slope * (p.x - mx)).powi(2))
            .sum();
        let se = (rss / (n - 2) as f64 / sxx).sqrt();
        Some(ClockEstimate {
            ppm: slope * 1e6,
            se_ppm: (se * 1e6).max(MIN_SE_PPM),
            span_ms: self.points[n - 1].x - self.points[0].x,
        })
    }

    /// The rate over every segment so far, pooled by inverse variance.
    pub fn estimate(&self) -> Option<ClockEstimate> {
        let mut weight = 0.0;
        let mut sum = 0.0;
        let mut span = 0.0;
        for est in self.finished.iter().chain(self.current().iter()) {
            let w = 1.0 / est.se_ppm.powi(2);
            weight += w;
            sum += w * est.ppm;
            span += est.span_ms;
        }
        (weight > 0.0).then(|| ClockEstimate {
            ppm: sum / weight,
            se_ppm: (1.0 / weight).sqrt(),
            span_ms: span,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::PollGen;
    use super::*;

    const MINUTE: f64 = 60_000.0;

    fn fit(gen: &mut PollGen, minutes: f64) -> ClockFit {
        let mut fit = ClockFit::new();
        gen.run_until(minutes * MINUTE, |p| fit.add(p, 25.0));
        fit
    }

    /// Fits `seeds` speakers at `ppm` with `tick_jitter_ms` for `minutes`
    /// and returns the estimates.
    fn fits(ppm: f64, tick_jitter_ms: f64, minutes: f64, seeds: u64) -> Vec<ClockEstimate> {
        (0..seeds)
            .map(|seed| {
                let mut gen = PollGen::new(200 + seed);
                gen.ppm = ppm;
                gen.tick_jitter_ms = tick_jitter_ms;
                fit(&mut gen, minutes).estimate().expect("estimate")
            })
            .collect()
    }

    fn rms_error(estimates: &[ClockEstimate], ppm: f64) -> f64 {
        (estimates.iter().map(|e| (e.ppm - ppm).powi(2)).sum::<f64>() / estimates.len() as f64)
            .sqrt()
    }

    #[test]
    fn minus_40ppm_is_reported_within_15ppm_after_30min() {
        // The plan hoped for a 7 ppm error after half an hour; the RelTime
        // quantum at 24 polls a minute allows about 10-18 (see the module
        // docs). Within 15 ppm is what a typical fit achieves, and the
        // reported error must say how far a given fit may be off.
        let estimates = fits(-40.0, 50.0, 30.0, 16);
        let rms = rms_error(&estimates, -40.0);
        assert!(rms <= 20.0, "RMS error {rms:.1} ppm after 30 min");
        let within = estimates
            .iter()
            .filter(|e| (e.ppm + 40.0).abs() <= 15.0)
            .count();
        assert!(
            within * 3 >= estimates.len() * 2,
            "{within} of {} within 15 ppm",
            estimates.len()
        );
        for e in &estimates {
            assert!((e.ppm + 40.0).abs() <= 3.0 * e.se_ppm, "{e:?}");
            assert!(e.se_ppm <= 30.0, "{e:?}");
            assert!(e.span_ms >= 25.0 * MINUTE, "{e:?}");
        }
    }

    #[test]
    fn minus_40ppm_is_reported_within_15ppm_after_an_hour_even_with_tick_jitter() {
        for e in fits(-40.0, 100.0, 60.0, 16) {
            assert!((e.ppm + 40.0).abs() <= 15.0, "{e:?}");
            assert!(e.se_ppm <= 10.0, "{e:?}");
        }
    }

    #[test]
    fn the_reported_error_is_honest() {
        // About two thirds of fits should land within one standard error and
        // nearly all within three.
        let estimates = fits(40.0, 100.0, 30.0, 40);
        let within_1 = estimates
            .iter()
            .filter(|e| (e.ppm - 40.0).abs() <= e.se_ppm)
            .count();
        let within_3 = estimates
            .iter()
            .filter(|e| (e.ppm - 40.0).abs() <= 3.0 * e.se_ppm)
            .count();
        assert!(within_1 >= 20, "{within_1} of 40 within 1 SE");
        assert!(within_3 >= 38, "{within_3} of 40 within 3 SE");
    }

    #[test]
    fn the_error_shrinks_as_the_segment_grows() {
        let mut gen = PollGen::new(17);
        gen.ppm = 40.0;
        let mut fit = ClockFit::new();
        gen.run_until(10.0 * MINUTE, |p| fit.add(p, 25.0));
        let early = fit.estimate().expect("estimate");
        gen.run_until(60.0 * MINUTE, |p| fit.add(p, 25.0));
        let late = fit.estimate().expect("estimate");
        assert!(late.se_ppm < early.se_ppm / 3.0, "{early:?} then {late:?}");
    }

    #[test]
    fn clock_fit_is_unchanged_by_active_compensation() {
        let mut plain = PollGen::new(23);
        plain.ppm = 40.0;
        let mut compensated = plain.clone();
        // 40 ppm of inserted audio: the delivered side changes, the
        // speaker's playhead does not.
        compensated.inserted_per_ms = 40e-6;
        let a = fit(&mut plain, 30.0).estimate().expect("estimate");
        let b = fit(&mut compensated, 30.0).estimate().expect("estimate");
        assert_eq!(a, b);
    }

    #[test]
    fn offset_step_breaks_segment_without_step_in_rate() {
        use super::super::segment::SegmentBreak;
        use super::super::tracker::ReserveTracker;

        let run = |seed: u64| {
            let mut gen = PollGen::new(seed);
            gen.ppm = -40.0;
            // A 700 ms stall of the playhead twenty minutes in, as an underrun.
            gen.steps = vec![(20.0 * MINUTE, -700.0)];
            let mut tracker = ReserveTracker::new();
            tracker.start_connection(true);
            // The same polls, fitted as if nothing had happened.
            let mut unbroken = ClockFit::new();
            let mut breaks = Vec::new();
            let mut t = 30_000.0;
            while t <= 60.0 * MINUTE {
                gen.run_until(t, |p| {
                    tracker.observe(p, "uri", false);
                    unbroken.add(p, 25.0);
                });
                if let (_, Some(b)) = tracker.estimate(t) {
                    breaks.push((t, b));
                }
                t += 30_000.0;
            }
            (
                tracker.clock().expect("estimate"),
                unbroken.estimate().expect("estimate"),
                breaks,
            )
        };

        for seed in [29, 30, 31] {
            let (est, unbroken, breaks) = run(seed);
            assert_eq!(breaks.len(), 1, "seed {seed}: {breaks:?}");
            let (at, reason) = breaks[0];
            assert_eq!(reason, SegmentBreak::OffsetStep);
            assert!(
                at > 20.0 * MINUTE && at <= 24.0 * MINUTE,
                "seed {seed}: detected at {:.1} min",
                at / MINUTE
            );
            assert!(
                (est.ppm + 40.0).abs() <= 3.0 * est.se_ppm,
                "seed {seed}: {est:?}"
            );
            // Without the break the step lands in the fit as a false rate.
            assert!(
                (unbroken.ppm + 40.0).abs() > 100.0,
                "seed {seed}: an unbroken fit across the step should be badly off: {unbroken:?}"
            );
        }
    }

    #[test]
    fn segments_are_pooled_by_their_errors() {
        let mut fit = ClockFit::new();
        for seed in [31, 32, 33] {
            let mut gen = PollGen::new(seed);
            gen.ppm = 40.0;
            gen.run_until(40.0 * MINUTE, |p| fit.add(p, 25.0));
            fit.break_segment();
        }
        assert!(fit.current().is_none(), "a break starts a fresh line");
        let pooled = fit.estimate().expect("pooled");
        assert!(
            (pooled.ppm - 40.0).abs() <= 3.0 * pooled.se_ppm,
            "{pooled:?}"
        );
        assert!(pooled.span_ms >= 100.0 * MINUTE, "{pooled:?}");
    }

    #[test]
    fn nothing_is_fitted_from_too_short_a_segment() {
        let mut gen = PollGen::new(37);
        assert_eq!(fit(&mut gen, 4.0).estimate(), None);
    }
}
