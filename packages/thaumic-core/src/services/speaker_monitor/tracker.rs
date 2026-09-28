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
/// empty is projected from it.
pub const DRAIN_MIN_SIGMA: f64 = 3.0;

/// The monitor's view of one speaker, for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorState {
    /// Measuring, but the estimate is not yet precise or settled.
    Locking,
    /// The estimate is locked.
    Ok,
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
        let ppm = self.clock.estimate().map_or(0.0, |c| c.ppm);
        let Some(est) = self.reserve.estimate(now, ppm) else {
            return (None, None);
        };
        if let Some(brk) = self.segment.observe_estimate(&est) {
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

    /// Reserve estimates made and how many were inconsistent, over the
    /// tracker's life.
    pub fn estimate_counts(&self) -> (u64, u64) {
        self.reserve.counts()
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
    /// [`DRAIN_MIN_SIGMA`] standard errors.
    ///
    /// The reserve's absolute zero is not known exactly (the speaker holds
    /// some audio of its own past the playhead it reports), so this is an
    /// approximation that errs towards warning early.
    pub fn time_to_empty_s(&self) -> Option<f64> {
        let est = self.last.filter(|e| e.locked)?;
        let clock = self.clock()?;
        if clock.ppm <= DRAIN_MIN_SIGMA * clock.se_ppm || clock.ppm <= 0.0 {
            return None;
        }
        // ppm·1e-6 ms per ms is ppm·1e-3 ms per second.
        Some((est.reserve_ms.max(0.0)) / (clock.ppm * 1e-3))
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
            MonitorState::Ok
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

    fn run(tracker: &mut ReserveTracker, gen: &mut PollGen, from: f64, to: f64) {
        let mut t = from;
        while t < to {
            t += 30_000.0;
            gen.run_until(t, |p| {
                tracker.observe(p, URI, false);
            });
            tracker.estimate(t);
        }
    }

    #[test]
    fn a_draining_speaker_projects_a_time_to_empty() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true);
        let mut gen = PollGen::new(41);
        gen.ppm = 300.0;
        run(&mut tracker, &mut gen, 0.0, 20.0 * 60_000.0);
        assert_eq!(tracker.state(false, false), MonitorState::Ok);
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
    }

    #[test]
    fn a_new_connection_breaks_the_segment_and_resets_its_stats() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true);
        let mut gen = PollGen::new(47);
        run(&mut tracker, &mut gen, 0.0, 10.0 * 60_000.0);
        assert!(tracker.connection().polls > 0);
        assert_eq!(tracker.connection_breaks(SegmentBreak::NewConnection), 0);
        tracker.start_connection(true);
        assert_eq!(tracker.connection().polls, 0);
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
}
