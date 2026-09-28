//! Ties the reserve estimator, the clock fit and the segment bookkeeping
//! together for one speaker, the way the monitor uses them.
//!
//! The monitor feeds every answered poll to [`ReserveTracker::observe`] and
//! asks for an estimate every 30 s with [`ReserveTracker::estimate`]. The
//! tracker decides segment breaks, clears the windows they invalidate, and
//! keeps the per-connection figures the end-of-connection summary reports.

use super::bounds::PollObservation;
use super::clock_fit::{ClockEstimate, ClockFit};
use super::reserve::{ReserveEstimate, ReserveEstimator};
use super::segment::{Segment, SegmentBreak};

/// How many standard errors from zero a drain must be before a time to
/// empty is projected from it, when its error is known exactly. An error
/// estimated from few blocks is itself uncertain, so the bar is raised to
/// Student's t at the same one-sided tail (see [`drain_threshold_sigmas`]).
pub const DRAIN_MIN_SIGMA: f64 = 3.0;

/// Student's t at the one-sided tail of [`DRAIN_MIN_SIGMA`] normal standard
/// errors (p ≈ 0.00135), by degrees of freedom.
const DRAIN_T_TABLE: [(usize, f64); 14] = [
    (2, 19.21),
    (3, 9.22),
    (4, 6.62),
    (5, 5.51),
    (6, 4.90),
    (7, 4.53),
    (8, 4.28),
    (10, 3.96),
    (12, 3.76),
    (15, 3.59),
    (20, 3.42),
    (30, 3.27),
    (60, 3.13),
    (120, 3.06),
];

/// How many standard errors from zero a clock rate estimated with `dof`
/// degrees of freedom must be to count as draining: [`DRAIN_MIN_SIGMA`]
/// widened to Student's t, interpolated in `1/dof`. With a single segment
/// of four blocks (two degrees of freedom) that is about 19; it falls to
/// about 4 by ten.
pub fn drain_threshold_sigmas(dof: usize) -> f64 {
    let inv = |d: usize| 1.0 / d as f64;
    let (first, last) = (DRAIN_T_TABLE[0], DRAIN_T_TABLE[DRAIN_T_TABLE.len() - 1]);
    if dof <= first.0 {
        return first.1;
    }
    if dof >= last.0 {
        // Towards the normal value as 1/dof goes to zero.
        return DRAIN_MIN_SIGMA + (last.1 - DRAIN_MIN_SIGMA) * inv(dof) / inv(last.0);
    }
    let i = DRAIN_T_TABLE.partition_point(|(d, _)| *d <= dof);
    let ((d0, t0), (d1, t1)) = (DRAIN_T_TABLE[i - 1], DRAIN_T_TABLE[i]);
    t0 + (t1 - t0) * (inv(dof) - inv(d0)) / (inv(d1) - inv(d0))
}

/// Projected time to an empty reserve below which the speaker is reported
/// as draining.
pub const DRAINING_WARN_SECS: f64 = 20.0 * 60.0;

/// The monitor's view of one speaker, for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorState {
    /// Measuring, but the estimate is not yet precise or settled.
    Locking,
    /// The estimate is locked.
    Ok,
    /// The estimate is locked and the reserve is projected to run out
    /// within [`DRAINING_WARN_SECS`].
    Draining,
    /// The speaker is known not to be playing.
    Paused,
    /// The speaker has stopped answering.
    Stale,
    /// The speaker is playing something else and is not polled.
    Dormant,
}

impl MonitorState {
    /// The state as a log token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Locking => "locking",
            Self::Ok => "ok",
            Self::Draining => "draining",
            Self::Paused => "paused",
            Self::Stale => "stale",
            Self::Dormant => "dormant",
        }
    }
}

impl std::fmt::Display for MonitorState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What one connection saw, for its summary.
#[derive(Debug, Clone, Default)]
pub struct ConnectionStats {
    /// Polls measured (answered, about the stream, not paused).
    pub polls: u64,
    /// The first locked reserve estimate.
    pub reserve_start_ms: Option<f64>,
    /// The latest locked reserve estimate.
    pub reserve_end_ms: Option<f64>,
    /// The lowest locked reserve estimate.
    pub reserve_min_ms: Option<f64>,
    /// Segment breaks by reason, as counted when the connection started.
    breaks_before: [u32; 5],
    /// Reserve estimates made and how many were inconsistent, as counted
    /// when the connection started.
    estimates_before: (u64, u64),
}

/// Reserve and clock tracking for one speaker, across its connections.
#[derive(Debug, Clone, Default)]
pub struct ReserveTracker {
    reserve: ReserveEstimator,
    clock: ClockFit,
    segment: Segment,
    /// Whether the current connection's reserve can be measured (PCM).
    pcm: bool,
    /// Whether any connection has started yet.
    started: bool,
    last: Option<ReserveEstimate>,
    connection: ConnectionStats,
}

impl ReserveTracker {
    /// A tracker that has seen nothing.
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts tracking a new connection. `pcm` is whether its delivered
    /// audio can be counted in milliseconds; a compressed connection only
    /// gets a clock fit. Every connection after the first ends a segment.
    pub fn start_connection(&mut self, pcm: bool) {
        if self.started {
            self.segment.start(SegmentBreak::NewConnection);
            self.clear();
        }
        self.started = true;
        self.pcm = pcm;
        self.last = None;
        self.connection = ConnectionStats {
            breaks_before: SegmentBreak::ALL.map(|r| self.segment.count(r)),
            estimates_before: self.reserve.counts(),
            ..ConnectionStats::default()
        };
    }

    /// Clears what a segment break invalidates.
    fn clear(&mut self) {
        self.reserve.clear();
        self.clock.break_segment();
    }

    /// Feeds one answered poll about the stream. `not_playing` is whether
    /// the speaker is positively known not to be playing, in which case the
    /// poll is not measured. Returns the segment break it caused, if any.
    pub fn observe(
        &mut self,
        obs: &PollObservation,
        track_uri: &str,
        not_playing: bool,
    ) -> Option<SegmentBreak> {
        let brk = self
            .segment
            .observe_poll(obs.rel_ms, track_uri, not_playing);
        if brk.is_some() {
            self.clear();
        }
        if not_playing {
            return brk;
        }
        if self.pcm {
            self.reserve.add(obs);
        }
        self.clock.add(obs, self.reserve.jitter_ms());
        self.connection.polls += 1;
        brk
    }

    /// Estimates the reserve at `now` (PCM only) and checks it for an offset
    /// step. An estimate that reveals a step is not returned: it mixes the
    /// two sides of the step.
    pub fn estimate(&mut self, now: f64) -> (Option<ReserveEstimate>, Option<SegmentBreak>) {
        if !self.pcm || self.segment.paused() {
            return (None, None);
        }
        // Shrunk, so a rate from a few short segments (whose error can be
        // hundreds of ppm) cannot drag the older bounds, or the step
        // baseline, far.
        let ppm = self.clock.estimate().map_or(0.0, |c| c.shrunk_ppm());
        let Some(est) = self.reserve.estimate(now, ppm) else {
            return (None, None);
        };
        if let Some(brk) = self.segment.observe_estimate(&est, ppm) {
            self.clear();
            self.last = None;
            return (None, Some(brk));
        }
        self.last = Some(est);
        if est.locked {
            let c = &mut self.connection;
            c.reserve_start_ms.get_or_insert(est.reserve_ms);
            c.reserve_end_ms = Some(est.reserve_ms);
            c.reserve_min_ms = Some(
                c.reserve_min_ms
                    .map_or(est.reserve_ms, |m| m.min(est.reserve_ms)),
            );
        }
        (Some(est), None)
    }

    /// The latest reserve estimate of the current segment.
    pub fn last_estimate(&self) -> Option<&ReserveEstimate> {
        self.last.as_ref()
    }

    /// The clock rate, pooled over every segment so far.
    pub fn clock(&self) -> Option<ClockEstimate> {
        self.clock.estimate()
    }

    /// The jitter allowance currently applied.
    pub fn jitter_ms(&self) -> f64 {
        self.reserve.jitter_ms()
    }

    /// Reserve estimates made during the current connection and how many
    /// were inconsistent.
    pub fn connection_estimate_counts(&self) -> (u64, u64) {
        let (total, inconsistent) = self.reserve.counts();
        let (total_before, inconsistent_before) = self.connection.estimates_before;
        (total - total_before, inconsistent - inconsistent_before)
    }

    /// Whether the speaker is known not to be playing.
    pub fn paused(&self) -> bool {
        self.segment.paused()
    }

    /// Whether the current connection's reserve is measured.
    pub fn is_pcm(&self) -> bool {
        self.pcm
    }

    /// What the current connection has seen.
    pub fn connection(&self) -> &ConnectionStats {
        &self.connection
    }

    /// Segment breaks for `reason` during the current connection.
    pub fn connection_breaks(&self, reason: SegmentBreak) -> u32 {
        let idx = SegmentBreak::ALL
            .iter()
            .position(|r| *r == reason)
            .unwrap_or(0);
        self.segment.count(reason) - self.connection.breaks_before[idx]
    }

    /// Seconds until the reserve runs out at the measured clock rate, when
    /// the estimate is locked and the speaker is draining it by more than
    /// [`drain_threshold_sigmas`] standard errors.
    ///
    /// The reserve's absolute zero is not known exactly (the speaker holds
    /// some audio of its own past the playhead it reports), so this is an
    /// approximation that errs towards warning early.
    pub fn time_to_empty_s(&self) -> Option<f64> {
        let est = self.last.filter(|e| e.locked)?;
        let clock = self.clock().filter(|_| self.clock_drains())?;
        // ppm·1e-6 ms per ms is ppm·1e-3 ms per second.
        Some((est.reserve_ms.max(0.0)) / (clock.ppm * 1e-3))
    }

    /// Whether the speaker plays faster than we deliver by more than
    /// [`drain_threshold_sigmas`] standard errors, whatever the reserve
    /// estimate is doing.
    pub fn clock_drains(&self) -> bool {
        self.clock()
            .is_some_and(|c| c.ppm > 0.0 && c.ppm > drain_threshold_sigmas(c.dof) * c.se_ppm)
    }

    /// The state to report, given what the monitor knows beyond the polls.
    pub fn state(&self, dormant: bool, stale: bool) -> MonitorState {
        if dormant {
            MonitorState::Dormant
        } else if stale {
            MonitorState::Stale
        } else if self.paused() {
            MonitorState::Paused
        } else if self.last.is_some_and(|e| e.locked) {
            if self
                .time_to_empty_s()
                .is_some_and(|s| s < DRAINING_WARN_SECS)
            {
                MonitorState::Draining
            } else {
                MonitorState::Ok
            }
        } else {
            MonitorState::Locking
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::test_support::PollGen;
    use super::*;

    const URI: &str = "http://10.0.0.1:49400/stream/s/live.wav";

    /// Polls and estimates every 30 s from `from` to `to`, and returns the
    /// shortest time to empty projected meanwhile.
    fn run(tracker: &mut ReserveTracker, gen: &mut PollGen, from: f64, to: f64) -> Option<f64> {
        let mut shortest: Option<f64> = None;
        let mut t = from;
        while t < to {
            t += 30_000.0;
            gen.run_until(t, |p| {
                tracker.observe(p, URI, false);
            });
            tracker.estimate(t);
            if let Some(s) = tracker.time_to_empty_s() {
                shortest = Some(shortest.map_or(s, |m| m.min(s)));
            }
        }
        shortest
    }

    #[test]
    fn a_draining_speaker_projects_a_time_to_empty() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true);
        let mut gen = PollGen::new(41);
        gen.ppm = 300.0;
        run(&mut tracker, &mut gen, 0.0, 20.0 * 60_000.0);
        assert_eq!(tracker.state(false, false), MonitorState::Draining);
        assert!(tracker.clock_drains());
        let tte = tracker.time_to_empty_s().expect("draining");
        let truth = gen.reserve(20.0 * 60_000.0) / 0.3;
        assert!(
            (tte - truth).abs() < 0.2 * truth,
            "{tte:.0}s vs {truth:.0}s"
        );
        let c = tracker.connection();
        assert!(c.reserve_min_ms.unwrap() < c.reserve_start_ms.unwrap());
    }

    #[test]
    fn a_steady_speaker_projects_nothing() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true);
        let mut gen = PollGen::new(43);
        run(&mut tracker, &mut gen, 0.0, 30.0 * 60_000.0);
        assert_eq!(tracker.time_to_empty_s(), None);
        assert!(!tracker.clock_drains());
        assert_eq!(tracker.state(false, false), MonitorState::Ok);
    }

    #[test]
    fn a_new_connection_breaks_the_segment_and_resets_its_stats() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true);
        let mut gen = PollGen::new(47);
        run(&mut tracker, &mut gen, 0.0, 10.0 * 60_000.0);
        assert!(tracker.connection().polls > 0);
        assert_eq!(tracker.connection_breaks(SegmentBreak::NewConnection), 0);
        assert!(tracker.connection_estimate_counts().0 > 0);
        tracker.start_connection(true);
        assert_eq!(tracker.connection().polls, 0);
        assert_eq!(tracker.connection_estimate_counts(), (0, 0));
        assert_eq!(tracker.last_estimate(), None);
        assert!(
            tracker.clock().is_some(),
            "the clock is pooled across connections"
        );
    }

    #[test]
    fn a_compressed_connection_is_clock_fitted_but_not_reserve_estimated() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(false);
        let mut gen = PollGen::new(53);
        gen.ppm = -40.0;
        run(&mut tracker, &mut gen, 0.0, 10.0 * 60_000.0);
        assert_eq!(tracker.last_estimate(), None);
        assert!(tracker.clock().is_some());
    }

    #[test]
    fn a_paused_speaker_is_not_measured() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true);
        let mut gen = PollGen::new(59);
        run(&mut tracker, &mut gen, 0.0, 5.0 * 60_000.0);
        let polls = tracker.connection().polls;
        let p = gen.next_poll();
        assert_eq!(
            tracker.observe(&p, URI, true),
            Some(SegmentBreak::NotPlaying)
        );
        assert_eq!(tracker.connection().polls, polls);
        assert_eq!(tracker.state(false, false), MonitorState::Paused);
        assert_eq!(tracker.estimate(p.tr), (None, None));
    }

    /// A speaker at `ppm` with `tick_jitter_ms` of RelTime jitter that
    /// fetches the stream afresh every `every_min` minutes, `connections`
    /// times, estimated every 30 s. Returns the pooled clock at the end and
    /// the shortest time to empty ever projected.
    fn reconnecting(
        seed: u64,
        ppm: f64,
        tick_jitter_ms: f64,
        every_min: f64,
        connections: u64,
    ) -> (Option<ClockEstimate>, Option<f64>) {
        let mut tracker = ReserveTracker::new();
        let mut shortest: Option<f64> = None;
        for i in 0..connections {
            tracker.start_connection(true);
            let mut gen = PollGen::new(seed * 1000 + i);
            gen.ppm = ppm;
            gen.tick_jitter_ms = tick_jitter_ms;
            if let Some(s) = run(&mut tracker, &mut gen, 0.0, every_min * 60_000.0) {
                shortest = Some(shortest.map_or(s, |m| m.min(s)));
            }
        }
        (tracker.clock(), shortest)
    }

    #[test]
    fn reconnects_every_5min_pool_into_an_honest_clock() {
        // Twelve segments of four or five blocks each, as a speaker that
        // refetches every 300 s leaves. Pooling each segment's rate by its
        // own error let the one that happened to scatter least take over,
        // reporting e.g. -842±6 ppm for a +40 ppm speaker.
        for ppm in [40.0, -40.0] {
            let mut outside = Vec::new();
            for seed in 0..40 {
                let (clock, shortest) = reconnecting(seed, ppm, 50.0, 5.0, 12);
                let c = clock.expect("pooled clock");
                if (c.ppm - ppm).abs() > 3.0 * c.se_ppm {
                    outside.push((seed, c));
                }
                assert!(c.dof >= 30, "seed {seed}: {c:?}");
                // +40 ppm drains a 600 ms reserve in about four hours: it
                // must never be projected inside the 20 minutes the monitor
                // warns at.
                assert!(
                    shortest.map_or(true, |s| s > 20.0 * 60.0),
                    "seed {seed} at {ppm} ppm: projected empty in {shortest:?}s"
                );
            }
            assert!(outside.len() <= 2, "{ppm} ppm, outside 3 SE: {outside:?}");
        }
    }

    #[test]
    fn a_steady_reconnecting_speaker_is_not_projected_to_drain() {
        let mut projected = Vec::new();
        for seed in 0..40 {
            if let (_, Some(s)) = reconnecting(seed, 0.0, 50.0, 5.0, 12) {
                assert!(s > 20.0 * 60.0, "seed {seed}: projected empty in {s:.0}s");
                projected.push((seed, s));
            }
        }
        assert!(projected.len() <= 1, "{projected:?}");
    }

    #[test]
    fn the_drain_threshold_widens_for_few_degrees_of_freedom() {
        assert_eq!(drain_threshold_sigmas(1), 19.21);
        assert_eq!(drain_threshold_sigmas(2), 19.21);
        assert_eq!(drain_threshold_sigmas(8), 4.28);
        let nine = drain_threshold_sigmas(9);
        assert!(nine < 4.28 && nine > 3.96, "{nine}");
        assert!((drain_threshold_sigmas(1_000_000) - DRAIN_MIN_SIGMA).abs() < 1e-3);
        let mut last = f64::INFINITY;
        for dof in 2..500 {
            let t = drain_threshold_sigmas(dof);
            assert!(t <= last && t > DRAIN_MIN_SIGMA, "dof {dof}: {t}");
            last = t;
        }
    }

    /// Runs `seeds` speakers at +40 ppm with `tick_jitter_ms` for an hour,
    /// with the playhead stepping by `step_ms` half an hour in. Returns how
    /// many saw the step within six minutes of it and how many breaks came
    /// anywhere else.
    fn steps_seen(step_ms: f64, tick_jitter_ms: f64, seeds: u64) -> (usize, usize) {
        let (mut seen, mut spurious) = (0, 0);
        for seed in 0..seeds {
            let mut gen = PollGen::new(500 + seed);
            gen.ppm = 40.0;
            gen.tick_jitter_ms = tick_jitter_ms;
            if step_ms != 0.0 {
                gen.steps = vec![(30.0 * 60_000.0, step_ms)];
            }
            let mut tracker = ReserveTracker::new();
            tracker.start_connection(true);
            let mut t = 0.0;
            while t < 60.0 * 60_000.0 {
                t += 30_000.0;
                gen.run_until(t, |p| {
                    tracker.observe(p, URI, false);
                });
                if tracker.estimate(t).1 == Some(SegmentBreak::OffsetStep) {
                    let expected = step_ms != 0.0 && t > 30.0 * 60_000.0 && t <= 36.0 * 60_000.0;
                    if expected {
                        seen += 1;
                    } else {
                        spurious += 1;
                    }
                }
            }
        }
        (seen, spurious)
    }

    #[test]
    fn a_300ms_underrun_is_suspected_either_way() {
        // Compared with the estimate just before, a step arrived as two
        // half-steps while the reserve window straddled it, and a 300 ms one
        // was seen by only a few speakers in forty.
        for step in [-300.0, 300.0] {
            for jitter in [0.0, 100.0] {
                let (seen, spurious) = steps_seen(step, jitter, 20);
                assert_eq!((seen, spurious), (20, 0), "{step} ms at ±{jitter} ms");
            }
        }
    }

    #[test]
    fn most_200ms_underruns_are_suspected() {
        let (seen, spurious) = steps_seen(-200.0, 50.0, 20);
        assert!(seen >= 15, "{seen} of 20");
        assert_eq!(spurious, 0);
    }

    #[test]
    fn measured_tick_jitter_suspects_no_underrun() {
        for jitter in [0.0, 50.0, 100.0] {
            assert_eq!(steps_seen(0.0, jitter, 20), (0, 0), "±{jitter} ms");
        }
    }
}
