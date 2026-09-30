//! Decides when a speaker's measurements stop being continuous.
//!
//! The reserve and clock estimators assume the speaker's playhead and our
//! delivery count from the same start and move smoothly. Some events break
//! that, and measurements from either side of one must not be mixed: a new
//! connection restarts both counts, RelTime going backwards or another track
//! restarts the playhead, a pause stops it, and an underrun or skip shifts it
//! by a step. Each of these ends a *segment*; the estimators' windows are
//! cleared and measurement starts afresh.

use std::collections::VecDeque;

use super::reserve::{acquire_half_width_ms, ReserveEstimate, RESERVE_WINDOW_MS};

/// RelTime going back by more than this is a restart, not jitter.
pub const RELTIME_BACKWARDS_TOLERANCE_MS: u64 = 100;

/// Smallest jump of the reserve estimate that counts as an offset step.
pub const OFFSET_STEP_MIN_MS: f64 = 150.0;

/// A jump must also exceed this many half-widths of the estimate it is
/// measured from (never counting more of that half-width than acquiring a
/// lock allows).
pub const OFFSET_STEP_HALF_WIDTHS: f64 = 2.0;

/// How long before an estimate the one it is compared with was made.
///
/// The reserve is a trimmed intersection over [`RESERVE_WINDOW_MS`] of polls,
/// so for that long after a step the window straddles it: the bounds from
/// either side cross, the midpoint shows only half the step, and the learnt
/// jitter swells to cover the rest. Compared with the estimate just before,
/// a step therefore arrives as two half-steps, each of which can pass under
/// the threshold. Compared with one made before the window turned over, it
/// shows in full. The extra minute leaves room for two estimates in a row
/// to see it.
pub const OFFSET_STEP_LAG_MS: f64 = RESERVE_WINDOW_MS + 60_000.0;

/// Consecutive estimates a jump must persist for.
pub const OFFSET_STEP_PERSIST: u32 = 2;

/// Why a segment ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SegmentBreak {
    /// The speaker fetched the stream again, which restarts both counts.
    NewConnection,
    /// RelTime went backwards.
    RelTimeBackwards,
    /// The speaker reported a different track URI.
    TrackUriChanged,
    /// The speaker was positively known not to be playing.
    NotPlaying,
    /// The reserve jumped and stayed jumped: an underrun or a skip.
    OffsetStep,
}

impl SegmentBreak {
    /// Every reason, in a fixed order, for counters and logs.
    pub const ALL: [SegmentBreak; 5] = [
        Self::NewConnection,
        Self::RelTimeBackwards,
        Self::TrackUriChanged,
        Self::NotPlaying,
        Self::OffsetStep,
    ];

    /// The reason as a log token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::NewConnection => "new_connection",
            Self::RelTimeBackwards => "reltime_backwards",
            Self::TrackUriChanged => "track_uri_changed",
            Self::NotPlaying => "not_playing",
            Self::OffsetStep => "offset_step",
        }
    }

    fn index(self) -> usize {
        match self {
            Self::NewConnection => 0,
            Self::RelTimeBackwards => 1,
            Self::TrackUriChanged => 2,
            Self::NotPlaying => 3,
            Self::OffsetStep => 4,
        }
    }
}

impl std::fmt::Display for SegmentBreak {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Segment bookkeeping for one speaker.
#[derive(Debug, Clone, Default)]
pub struct Segment {
    /// The last RelTime reported.
    last_rel_ms: Option<u64>,
    /// The track URI the segment is measuring.
    track_uri: Option<String>,
    /// Whether the speaker is known not to be playing (the break for it has
    /// been reported; playing again starts the next segment).
    paused: bool,
    /// Recent tight estimates the next ones are compared with, oldest
    /// first: when each was made, the reserve and its half-width.
    step_history: VecDeque<(f64, f64, f64)>,
    /// Consecutive estimates that have jumped away from the baseline.
    step_pending: u32,
    /// Breaks so far, by reason.
    counts: [u32; 5],
}

impl Segment {
    /// Bookkeeping with no history.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a break decided elsewhere (a new connection) and forgets what
    /// the old segment saw.
    pub fn start(&mut self, reason: SegmentBreak) {
        self.record(reason);
        self.last_rel_ms = None;
        self.track_uri = None;
        self.paused = false;
    }

    fn record(&mut self, reason: SegmentBreak) {
        self.counts[reason.index()] += 1;
        self.step_history.clear();
        self.step_pending = 0;
    }

    /// How many segments have ended for `reason`.
    pub fn count(&self, reason: SegmentBreak) -> u32 {
        self.counts[reason.index()]
    }

    /// Records a break for `reason` decided elsewhere without forgetting the
    /// playhead: an offset step found by comparing two stretches of polls
    /// rather than by [`Self::observe_estimate`].
    pub fn record_break(&mut self, reason: SegmentBreak) {
        self.record(reason);
    }

    /// Whether the speaker is known not to be playing.
    pub fn paused(&self) -> bool {
        self.paused
    }

    /// Whether the latest estimate jumped from its baseline and the jump has
    /// yet to persist, or fade, before an offset step is decided.
    pub fn step_pending(&self) -> bool {
        self.step_pending > 0
    }

    /// Checks one answered poll. `not_playing` is whether the speaker is
    /// positively known not to be playing; not knowing is not a break.
    pub fn observe_poll(
        &mut self,
        rel_ms: u64,
        track_uri: &str,
        not_playing: bool,
    ) -> Option<SegmentBreak> {
        if not_playing {
            if self.paused {
                return None;
            }
            self.paused = true;
            self.last_rel_ms = None;
            self.record(SegmentBreak::NotPlaying);
            return Some(SegmentBreak::NotPlaying);
        }
        self.paused = false;

        let uri_changed = self.track_uri.as_deref().is_some_and(|u| u != track_uri);
        if self.track_uri.as_deref() != Some(track_uri) {
            self.track_uri = Some(track_uri.to_string());
        }
        let went_back = self
            .last_rel_ms
            .is_some_and(|last| rel_ms + RELTIME_BACKWARDS_TOLERANCE_MS < last);
        self.last_rel_ms = Some(rel_ms);

        let reason = if uri_changed {
            SegmentBreak::TrackUriChanged
        } else if went_back {
            SegmentBreak::RelTimeBackwards
        } else {
            return None;
        };
        self.record(reason);
        Some(reason)
    }

    /// Checks one reserve estimate for an offset step: a jump of more than
    /// `max(`[`OFFSET_STEP_MIN_MS`]`, `[`OFFSET_STEP_HALF_WIDTHS`]` ×
    /// min(half-width, acquire width))` from a tight estimate made
    /// [`OFFSET_STEP_LAG_MS`] before (or the oldest one of the segment,
    /// until there is one that old), persisting for [`OFFSET_STEP_PERSIST`]
    /// estimates in a row. `clock_ppm` carries that earlier estimate forward
    /// along the drift, so only a jump stands out.
    ///
    /// Only a tight estimate becomes a baseline, and the threshold never
    /// counts more half-width than acquiring allows (at the estimate's own
    /// jitter), so a lock held through widening cannot raise the threshold
    /// until a real step hides under it.
    ///
    /// A step in the offset is the signal, rather than how many bounds
    /// disagree, because under tick jitter some always do.
    pub fn observe_estimate(
        &mut self,
        est: &ReserveEstimate,
        clock_ppm: f64,
    ) -> Option<SegmentBreak> {
        // Only the newest estimate at least the lag old is ever needed.
        while self
            .step_history
            .get(1)
            .is_some_and(|(at, _, _)| est.at - at >= OFFSET_STEP_LAG_MS)
        {
            self.step_history.pop_front();
        }
        let Some(&(at, baseline, half_width)) = self.step_history.front() else {
            if est.tight() {
                self.step_history
                    .push_back((est.at, est.reserve_ms, est.half_width_ms));
            }
            return None;
        };
        // Delivery runs at our clock and the playhead at the speaker's.
        let expected = baseline - clock_ppm * 1e-6 * (est.at - at);
        let width = half_width.min(acquire_half_width_ms(est.jitter_ms));
        let threshold = OFFSET_STEP_MIN_MS.max(OFFSET_STEP_HALF_WIDTHS * width);
        if (est.reserve_ms - expected).abs() > threshold {
            self.step_pending += 1;
            if self.step_pending >= OFFSET_STEP_PERSIST {
                self.record(SegmentBreak::OffsetStep);
                return Some(SegmentBreak::OffsetStep);
            }
            return None;
        }
        self.step_pending = 0;
        if est.tight() {
            self.step_history
                .push_back((est.at, est.reserve_ms, est.half_width_ms));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::super::reserve::LockReason;
    use super::*;

    const URI: &str = "http://10.0.0.1:49400/stream/s/live.wav";

    fn estimate(at: f64, reserve_ms: f64, locked: bool) -> ReserveEstimate {
        ReserveEstimate {
            at,
            reserve_ms,
            half_width_ms: 30.0,
            inconsistent: false,
            jitter_ms: 25.0,
            polls: 72,
            lock_reason: if locked {
                LockReason::Tight
            } else {
                LockReason::Unlocked
            },
        }
    }

    /// A locked estimate held through widening to `half_width_ms`.
    fn held(at: f64, reserve_ms: f64, half_width_ms: f64) -> ReserveEstimate {
        ReserveEstimate {
            half_width_ms,
            lock_reason: LockReason::Held,
            ..estimate(at, reserve_ms, true)
        }
    }

    #[test]
    fn reltime_backwards_breaks_segment() {
        let mut seg = Segment::new();
        assert_eq!(seg.observe_poll(10_000, URI, false), None);
        assert_eq!(
            seg.observe_poll(9_950, URI, false),
            None,
            "within the tolerance is jitter"
        );
        assert_eq!(
            seg.observe_poll(2_000, URI, false),
            Some(SegmentBreak::RelTimeBackwards)
        );
        assert_eq!(seg.observe_poll(3_000, URI, false), None);
        assert_eq!(seg.count(SegmentBreak::RelTimeBackwards), 1);
    }

    #[test]
    fn a_different_track_breaks_segment() {
        let mut seg = Segment::new();
        seg.observe_poll(10_000, URI, false);
        assert_eq!(
            seg.observe_poll(11_000, "http://10.0.0.1:49400/stream/s/live.wav?x", false),
            Some(SegmentBreak::TrackUriChanged)
        );
    }

    #[test]
    fn a_pause_breaks_segment_once() {
        let mut seg = Segment::new();
        seg.observe_poll(10_000, URI, false);
        assert_eq!(
            seg.observe_poll(10_000, URI, true),
            Some(SegmentBreak::NotPlaying)
        );
        assert!(seg.paused());
        assert_eq!(seg.observe_poll(10_000, URI, true), None);
        // Resuming at the same position is not also a restart.
        assert_eq!(seg.observe_poll(9_000, URI, false), None);
        assert!(!seg.paused());
        assert_eq!(seg.count(SegmentBreak::NotPlaying), 1);
    }

    /// Feeds `reserves` as estimates 30 s apart from `from`, returning what
    /// each one decided.
    fn feed(seg: &mut Segment, from: f64, reserves: &[(f64, bool)]) -> Vec<Option<SegmentBreak>> {
        reserves
            .iter()
            .enumerate()
            .map(|(i, (r, locked))| {
                seg.observe_estimate(&estimate(from + 30_000.0 * i as f64, *r, *locked), 0.0)
            })
            .collect()
    }

    #[test]
    fn an_offset_step_must_persist_to_break_segment() {
        let mut seg = Segment::new();
        // Slow drift and a single jumped estimate are not enough.
        let decided = feed(
            &mut seg,
            0.0,
            &[(500.0, true), (490.0, true), (800.0, false), (495.0, true)],
        );
        assert!(decided.iter().all(Option::is_none), "{decided:?}");
        // Two in a row are.
        let decided = feed(&mut seg, 120_000.0, &[(800.0, false), (820.0, false)]);
        assert_eq!(decided, [None, Some(SegmentBreak::OffsetStep)]);
        assert_eq!(seg.count(SegmentBreak::OffsetStep), 1);
        // The next segment needs a fresh locked baseline.
        let decided = feed(&mut seg, 180_000.0, &[(100.0, false), (900.0, false)]);
        assert_eq!(decided, [None, None]);
    }

    #[test]
    fn a_step_that_arrives_in_two_halves_is_still_seen() {
        // While the reserve window straddles a 200 ms step its estimate
        // shows half of it, under the threshold; once the window has turned
        // over it shows the rest. Following the latest estimate would take
        // each half in its stride.
        let mut seg = Segment::new();
        let mut reserves = vec![(500.0, true); 10];
        reserves.extend([(600.0, true); 6]);
        reserves.extend([(700.0, true); 4]);
        let decided = feed(&mut seg, 0.0, &reserves);
        let at = decided.iter().position(Option::is_some);
        assert_eq!(at, Some(17), "{decided:?}");
    }

    #[test]
    fn drift_at_the_measured_clock_rate_is_not_a_step() {
        // 300 ppm drains 9 ms every 30 s: 180 ms over the 10 minutes, but
        // never more than about 70 ms between an estimate and its baseline,
        // and none of it once the clock rate is allowed for.
        let mut seg = Segment::new();
        for i in 0..40 {
            let at = 30_000.0 * f64::from(i);
            let est = estimate(at, 700.0 - 300e-6 * at, true);
            assert_eq!(seg.observe_estimate(&est, 300.0), None, "at {at}");
        }
    }

    #[test]
    fn a_new_connection_forgets_the_old_playhead() {
        let mut seg = Segment::new();
        seg.observe_poll(600_000, URI, false);
        seg.start(SegmentBreak::NewConnection);
        assert_eq!(seg.observe_poll(1_000, URI, false), None);
        assert_eq!(seg.count(SegmentBreak::NewConnection), 1);
    }
    #[test]
    fn held_estimates_do_not_record_step_baselines() {
        let mut seg = Segment::new();
        // A segment whose only locked estimates are held has no baseline, so
        // even a large jump between them is not a step.
        for (i, r) in [500.0, 500.0, 900.0, 900.0, 900.0].iter().enumerate() {
            let est = held(30_000.0 * i as f64, *r, 180.0);
            assert_eq!(seg.observe_estimate(&est, 0.0), None, "estimate {i}");
        }
        // Once a tight estimate sets one, a jump from it counts.
        let decided = feed(
            &mut seg,
            150_000.0,
            &[(900.0, true), (1_300.0, false), (1_300.0, false)],
        );
        assert_eq!(decided, [None, None, Some(SegmentBreak::OffsetStep)]);
    }

    #[test]
    fn a_200ms_step_while_held_still_breaks_the_segment() {
        // A tight baseline at 30 ms half-width, then estimates held through
        // widening to the hold limit and with jitter swollen by the window
        // straddling the step. The threshold stays at the floor, so a 200 ms
        // step is seen.
        let mut seg = Segment::new();
        let decided = feed(&mut seg, 0.0, &[(500.0, true), (500.0, true)]);
        assert_eq!(decided, [None, None]);
        let mut brk = None;
        for i in 2..10 {
            let est = ReserveEstimate {
                jitter_ms: 150.0,
                ..held(30_000.0 * f64::from(i), 700.0, 200.0)
            };
            brk = brk.or(seg.observe_estimate(&est, 0.0));
        }
        assert_eq!(brk, Some(SegmentBreak::OffsetStep));
    }

    #[test]
    fn a_wide_baseline_cannot_raise_the_threshold_past_the_acquire_width() {
        // A baseline that was tight only because the jitter was large at the
        // time is counted at most at the acquire width the current jitter
        // allows: 2 × 110 ms, not 2 × 180 ms.
        let mut seg = Segment::new();
        let wide = ReserveEstimate {
            half_width_ms: 180.0,
            jitter_ms: 130.0,
            ..estimate(0.0, 500.0, true)
        };
        assert_eq!(seg.observe_estimate(&wide, 0.0), None);
        let decided = feed(&mut seg, 30_000.0, &[(750.0, false), (750.0, false)]);
        assert_eq!(decided, [None, Some(SegmentBreak::OffsetStep)]);
    }
}
