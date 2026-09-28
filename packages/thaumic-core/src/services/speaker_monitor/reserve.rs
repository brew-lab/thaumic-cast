//! Estimates how much audio a speaker holds ahead of its playhead.
//!
//! The reserve is `R = D − P`: audio delivered to the speaker's connection
//! minus audio it has played. Each poll bounds it to an interval about a
//! second wide (see [`PollObservation::reserve_bound`]). Over the last
//! [`RESERVE_WINDOW_MS`] of polls, with their phase against the speaker's
//! second dithered, the intersection of those intervals is a few tens of
//! milliseconds wide.
//!
//! A plain intersection is broken by a single bad answer, and a speaker's
//! second does not tick over at exactly the same point every time (about
//! ±50-100 ms per reading was measured). So the estimator takes the
//! [`TRIM_RANK`]th largest lower bound and the [`TRIM_RANK`]th smallest
//! upper bound, and widens every bound by a jitter allowance learnt from how
//! badly the un-widened bounds disagree.

use std::collections::VecDeque;

use super::bounds::{kth_largest, kth_smallest, PlayheadBound, PollObservation};

/// How far back polls count towards an estimate: about 72 polls at the
/// monitor-only cadence.
pub const RESERVE_WINDOW_MS: f64 = 180_000.0;

/// Which order statistic each side uses. The third extreme ignores up to two
/// outlying answers on each side.
pub const TRIM_RANK: usize = 3;

/// Fewest polls an estimate is made from.
pub const MIN_POLLS_FOR_ESTIMATE: usize = 2 * TRIM_RANK + 2;

/// Jitter allowance before anything has been learnt: the top of the
/// measured tick jitter.
pub const INITIAL_JITTER_MS: f64 = 100.0;

/// Bounds on the jitter allowance.
pub const MIN_JITTER_MS: f64 = 25.0;
/// Upper bound on the jitter allowance.
pub const MAX_JITTER_MS: f64 = 200.0;

/// Margin kept on top of the learnt disagreement, so a speaker whose jitter
/// is exactly what was learnt is not reported inconsistent half the time.
/// It is also the allowance for a speaker that shows no jitter at all.
pub const JITTER_MARGIN_MS: f64 = MIN_JITTER_MS;

/// Smoothing of the learnt disagreement, per estimate.
pub const JITTER_EMA_ALPHA: f64 = 0.3;

/// Span of polls a segment must cover before its estimate can lock.
pub const LOCK_MIN_SPAN_MS: f64 = 90_000.0;

/// Half-width an estimate may have and still lock, before jitter widens it.
///
/// The third extreme of ~72 phases spread over a 1000 ms quantum sits about
/// 41 ms inside the quantum on each side; the round trip adds up to its own
/// length on the upper side and delivery moves in 10 ms frames. With the
/// minimum jitter allowance, a jitter-free speaker's half-width is therefore
/// 75-85 ms, and no floor below that can ever be met.
pub const LOCK_HALF_WIDTH_FLOOR_MS: f64 = 110.0;

/// Multiple of the jitter allowance an estimate's half-width may reach and
/// still lock, for a speaker whose jitter dominates.
pub const LOCK_HALF_WIDTH_JITTER_FACTOR: f64 = 1.5;

/// Inconsistent estimates allowed among the last [`LOCK_RECENT_ESTIMATES`].
pub const LOCK_MAX_RECENT_INCONSISTENT: usize = 1;

/// How many recent estimates the consistency condition looks at.
pub const LOCK_RECENT_ESTIMATES: usize = 3;

/// One reserve estimate.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReserveEstimate {
    /// The moment the estimate describes.
    pub at: f64,
    /// Best estimate of the reserve, in milliseconds.
    pub reserve_ms: f64,
    /// Half the width of the interval the reserve is known to lie in,
    /// jitter allowance included, and never less than the jitter allowance.
    pub half_width_ms: f64,
    /// Whether the widened bounds still did not overlap.
    pub inconsistent: bool,
    /// The jitter allowance the bounds were widened by.
    pub jitter_ms: f64,
    /// Polls the estimate was made from.
    pub polls: usize,
    /// Whether the estimate is precise and settled enough to act on.
    pub locked: bool,
}

/// Rolling reserve estimator for one speaker.
#[derive(Debug, Clone)]
pub struct ReserveEstimator {
    /// Un-widened reserve bounds of the polls in the window, oldest first.
    window: VecDeque<PlayheadBound>,
    /// When the current segment's first poll was taken.
    segment_start: Option<f64>,
    /// Smoothed disagreement between the un-widened bounds.
    disagreement_ms: f64,
    /// Whether each of the last few estimates was inconsistent.
    recent: VecDeque<bool>,
    /// Estimates made and how many were inconsistent, since creation.
    estimates: u64,
    inconsistent: u64,
}

impl Default for ReserveEstimator {
    fn default() -> Self {
        Self::new()
    }
}

impl ReserveEstimator {
    /// An estimator with no polls.
    pub fn new() -> Self {
        Self {
            window: VecDeque::with_capacity(96),
            segment_start: None,
            disagreement_ms: INITIAL_JITTER_MS - JITTER_MARGIN_MS,
            recent: VecDeque::with_capacity(LOCK_RECENT_ESTIMATES + 1),
            estimates: 0,
            inconsistent: 0,
        }
    }

    /// Adds a poll.
    pub fn add(&mut self, obs: &PollObservation) {
        self.segment_start.get_or_insert(obs.ts);
        self.window.push_back(obs.reserve_bound());
    }

    /// Forgets every poll: the reserve is measured afresh from the next one.
    /// The learnt jitter is kept, since it belongs to the speaker.
    pub fn clear(&mut self) {
        self.window.clear();
        self.segment_start = None;
        self.recent.clear();
    }

    /// The jitter allowance currently applied.
    pub fn jitter_ms(&self) -> f64 {
        (self.disagreement_ms + JITTER_MARGIN_MS).clamp(MIN_JITTER_MS, MAX_JITTER_MS)
    }

    /// Estimates made and how many of them were inconsistent.
    pub fn counts(&self) -> (u64, u64) {
        (self.estimates, self.inconsistent)
    }

    /// Polls in the window.
    pub fn polls(&self) -> usize {
        self.window.len()
    }

    /// Estimates the reserve at `now`.
    ///
    /// `clock_ppm` is how much faster the speaker plays than our clock runs
    /// (see [`super::ClockFit`]); each bound is moved from its poll to `now`
    /// along the reserve's drift that implies. The shift is taken from the
    /// clock fit rather than from the reserve's own slope so that anything
    /// done to the delivered audio cannot feed back into it.
    ///
    /// Returns `None` until the window holds [`MIN_POLLS_FOR_ESTIMATE`] polls.
    pub fn estimate(&mut self, now: f64, clock_ppm: f64) -> Option<ReserveEstimate> {
        while self
            .window
            .front()
            .is_some_and(|b| now - b.at > RESERVE_WINDOW_MS)
        {
            self.window.pop_front();
        }
        let n = self.window.len();
        if n < MIN_POLLS_FOR_ESTIMATE {
            return None;
        }
        // Delivery runs at our clock and the playhead at the speaker's, so
        // the reserve changes by −ppm·1e-6 ms per ms.
        let rate = -clock_ppm * 1e-6;
        let (mut los, mut his): (Vec<f64>, Vec<f64>) = self
            .window
            .iter()
            .map(|b| {
                let s = b.shifted_to(now, rate);
                (s.lo, s.hi)
            })
            .unzip();
        let l0 = kth_largest(&mut los, TRIM_RANK)?;
        let u0 = kth_smallest(&mut his, TRIM_RANK)?;

        // How far the un-widened bounds overshoot each other says how much
        // jitter the speaker has; bounds that overlap say it has none.
        let needed = ((l0 - u0) / 2.0).max(0.0);
        self.disagreement_ms += JITTER_EMA_ALPHA * (needed - self.disagreement_ms);
        let jitter = self.jitter_ms();

        let (lo, hi) = (l0 - jitter, u0 + jitter);
        let inconsistent = lo > hi;
        // Under jitter the un-widened bounds cross, and how well the widened
        // ones then agree says nothing about where inside the jitter the
        // reserve lies: the estimate is never claimed to be better than the
        // jitter allowance.
        let half_width_ms = ((hi - lo) / 2.0).max(jitter);

        self.estimates += 1;
        if inconsistent {
            self.inconsistent += 1;
        }
        self.recent.push_back(inconsistent);
        while self.recent.len() > LOCK_RECENT_ESTIMATES {
            self.recent.pop_front();
        }

        let span = self.segment_start.map_or(0.0, |start| now - start);
        let recent_inconsistent = self.recent.iter().filter(|i| **i).count();
        let locked = span >= LOCK_MIN_SPAN_MS
            && half_width_ms
                <= LOCK_HALF_WIDTH_FLOOR_MS.max(LOCK_HALF_WIDTH_JITTER_FACTOR * jitter)
            && recent_inconsistent <= LOCK_MAX_RECENT_INCONSISTENT;

        Some(ReserveEstimate {
            at: now,
            // The widening is symmetric, so the midpoint does not depend on it.
            reserve_ms: (l0 + u0) / 2.0,
            half_width_ms,
            inconsistent,
            jitter_ms: jitter,
            polls: n,
            locked,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::PollGen;
    use super::*;

    /// Runs `gen` for `minutes`, estimating every 30 s, and returns every
    /// estimate with the true reserve at its moment.
    fn run(gen: &mut PollGen, minutes: f64) -> (ReserveEstimator, Vec<(ReserveEstimate, f64)>) {
        let mut est = ReserveEstimator::new();
        let mut out = Vec::new();
        let mut next_estimate = 30_000.0;
        let end = minutes * 60_000.0;
        while next_estimate <= end {
            gen.run_until(next_estimate, |p| est.add(p));
            if let Some(e) = est.estimate(next_estimate, gen.ppm) {
                out.push((e, gen.reserve(next_estimate)));
            }
            next_estimate += 30_000.0;
        }
        (est, out)
    }

    #[test]
    fn converges_within_50ms_after_72_dithered_polls() {
        for seed in 0..8 {
            let mut gen = PollGen::new(seed);
            let (_, estimates) = run(&mut gen, 10.0);
            let (last, truth) = estimates.last().copied().expect("estimates");
            assert!(last.polls >= 70, "{last:?}");
            assert!(
                (last.reserve_ms - truth).abs() <= 50.0,
                "seed {seed}: estimated {:.1} vs true {truth:.1}",
                last.reserve_ms
            );
            assert!(last.locked, "seed {seed}: {last:?}");
            assert!(!last.inconsistent);
            assert!(
                last.reserve_ms - last.half_width_ms <= truth
                    && truth <= last.reserve_ms + last.half_width_ms,
                "seed {seed}: the interval must contain the truth: {last:?} vs {truth}"
            );
        }
    }

    #[test]
    fn tick_jitter_of_100ms_widens_but_does_not_break_the_estimate() {
        let mut half_widths = Vec::new();
        let mut errors = Vec::new();
        let (mut incons, mut total) = (0u64, 0u64);
        for seed in 0..8 {
            let mut gen = PollGen::new(100 + seed);
            gen.tick_jitter_ms = 100.0;
            let (est, estimates) = run(&mut gen, 20.0);
            for (e, truth) in estimates.iter().filter(|(e, _)| e.polls >= 70) {
                half_widths.push(e.half_width_ms);
                errors.push((e.reserve_ms - truth).abs());
            }
            let (n, i) = est.counts();
            total += n;
            incons += i;
        }
        half_widths.sort_by(f64::total_cmp);
        errors.sort_by(f64::total_cmp);
        let median_half_width = half_widths[half_widths.len() / 2];
        assert!(
            median_half_width <= 70.0,
            "median half-width {median_half_width:.1} ms"
        );
        assert!(
            *half_widths.last().unwrap() <= LOCK_HALF_WIDTH_FLOOR_MS + 60.0,
            "worst half-width {:.1} ms",
            half_widths.last().unwrap()
        );
        assert!(
            errors[errors.len() / 2] <= 25.0,
            "median error {:.1}",
            errors[errors.len() / 2]
        );
        assert!(
            *errors.last().unwrap() <= 100.0,
            "worst error {:.1}",
            errors.last().unwrap()
        );
        assert!(
            incons * 20 <= total,
            "{incons} of {total} estimates inconsistent"
        );
    }

    #[test]
    fn jitter_estimate_tracks_injected_jitter() {
        // The allowance moves with every estimate, so compare its average
        // over the last ten minutes of each run.
        let jitter_after = |tick_jitter_ms: f64| {
            let mut gen = PollGen::new(7);
            gen.tick_jitter_ms = tick_jitter_ms;
            let (_, estimates) = run(&mut gen, 20.0);
            let tail = &estimates[estimates.len() - 20..];
            tail.iter().map(|(e, _)| e.jitter_ms).sum::<f64>() / tail.len() as f64
        };
        let calm = jitter_after(0.0);
        let rough = jitter_after(300.0);
        assert!(
            calm < MIN_JITTER_MS + 1.0,
            "no jitter learns the minimum: {calm:.1}"
        );
        assert!(
            rough > calm + 25.0 && rough < MAX_JITTER_MS,
            "300 ms of tick jitter learnt as {rough:.1} ms"
        );
    }

    #[test]
    fn two_outlier_polls_do_not_move_the_estimate() {
        let baseline = {
            let mut gen = PollGen::new(3);
            run(&mut gen, 6.0).1.last().copied().unwrap().0
        };
        let mut gen = PollGen::new(3);
        // Two answers a whole second early and two a whole second late, all
        // inside the last window.
        gen.outliers = vec![(100, -1), (110, -1), (105, 1), (115, 1)];
        let (_, estimates) = run(&mut gen, 6.0);
        let with_outliers = estimates.last().copied().unwrap().0;
        // The outliers push the good polls' extremes one rank inward on each
        // side, which moves the estimate by a few milliseconds; a plain
        // intersection would have moved by half a second, or broken.
        assert!(
            (with_outliers.reserve_ms - baseline.reserve_ms).abs() <= 25.0,
            "{with_outliers:?} vs {baseline:?}"
        );
        assert!(!with_outliers.inconsistent);
    }

    #[test]
    fn rounding_reltime_is_a_constant_offset_not_a_drift() {
        let mut gen = PollGen::new(11);
        gen.round = true;
        gen.ppm = 40.0;
        let (_, estimates) = run(&mut gen, 60.0);
        let offsets: Vec<f64> = estimates
            .iter()
            .filter(|(e, _)| e.locked)
            .map(|(e, truth)| e.reserve_ms - truth)
            .collect();
        let first = offsets[..10].iter().sum::<f64>() / 10.0;
        let last = offsets[offsets.len() - 10..].iter().sum::<f64>() / 10.0;
        assert!(
            (first + 500.0).abs() < 60.0,
            "rounding reads the reserve about half a quantum low: {first:.1}"
        );
        assert!(
            (last - first).abs() < 30.0,
            "the offset must not drift: {first:.1} then {last:.1}"
        );
    }

    #[test]
    fn nothing_is_estimated_from_too_few_polls_or_before_the_lock_span() {
        let mut gen = PollGen::new(5);
        let mut est = ReserveEstimator::new();
        gen.run_until(20_000.0, |p| est.add(p));
        assert!(est.estimate(20_000.0, 0.0).is_none());
        gen.run_until(60_000.0, |p| est.add(p));
        let e = est.estimate(60_000.0, 0.0).expect("estimate");
        assert!(!e.locked, "under the lock span: {e:?}");
    }

    #[test]
    fn clearing_starts_the_segment_afresh_but_keeps_the_jitter() {
        let mut gen = PollGen::new(9);
        gen.tick_jitter_ms = 300.0;
        let (mut est, _) = run(&mut gen, 10.0);
        let learnt = est.jitter_ms();
        est.clear();
        assert_eq!(est.polls(), 0);
        assert_eq!(est.jitter_ms(), learnt);
    }
}
