//! Decides when a speaker's measurements stop being continuous.
//!
//! The reserve and clock estimators assume the speaker's playhead and our
//! delivery count from the same start and move smoothly. Some events break
//! that, and measurements from either side of one must not be mixed: a new
//! connection restarts both counts, RelTime going backwards or another track
//! restarts the playhead, a pause stops it, and an underrun or skip shifts it
//! by a step. Each of these ends a *segment*; the estimators' windows are
//! cleared and measurement starts afresh.

use super::reserve::ReserveEstimate;

/// RelTime going back by more than this is a restart, not jitter.
pub const RELTIME_BACKWARDS_TOLERANCE_MS: u64 = 100;

/// Smallest jump of the reserve estimate that counts as an offset step.
pub const OFFSET_STEP_MIN_MS: f64 = 150.0;

/// A jump must also exceed this many half-widths of the estimate before it.
pub const OFFSET_STEP_HALF_WIDTHS: f64 = 4.0;

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
    /// Reserve estimate the next ones are compared with, and its half-width.
    step_baseline: Option<(f64, f64)>,
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
        self.step_baseline = None;
        self.step_pending = 0;
    }

    /// How many segments have ended for `reason`.
    pub fn count(&self, reason: SegmentBreak) -> u32 {
        self.counts[reason.index()]
    }

    /// Whether the speaker is known not to be playing.
    pub fn paused(&self) -> bool {
        self.paused
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
    /// half-width)` from the last locked estimate, persisting for
    /// [`OFFSET_STEP_PERSIST`] estimates in a row.
    ///
    /// A step in the offset is the signal, rather than how many bounds
    /// disagree, because under tick jitter some always do.
    pub fn observe_estimate(&mut self, est: &ReserveEstimate) -> Option<SegmentBreak> {
        let Some((baseline, half_width)) = self.step_baseline else {
            if est.locked {
                self.step_baseline = Some((est.reserve_ms, est.half_width_ms));
            }
            return None;
        };
        let threshold = OFFSET_STEP_MIN_MS.max(OFFSET_STEP_HALF_WIDTHS * half_width);
        if (est.reserve_ms - baseline).abs() > threshold {
            self.step_pending += 1;
            if self.step_pending >= OFFSET_STEP_PERSIST {
                self.record(SegmentBreak::OffsetStep);
                return Some(SegmentBreak::OffsetStep);
            }
            return None;
        }
        self.step_pending = 0;
        if est.locked {
            // Follow the slow drift, so only a jump stands out.
            self.step_baseline = Some((est.reserve_ms, est.half_width_ms));
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const URI: &str = "http://10.0.0.1:49400/stream/s/live.wav";

    fn estimate(reserve_ms: f64, locked: bool) -> ReserveEstimate {
        ReserveEstimate {
            at: 0.0,
            reserve_ms,
            half_width_ms: 30.0,
            inconsistent: false,
            jitter_ms: 25.0,
            polls: 72,
            locked,
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

    #[test]
    fn an_offset_step_must_persist_to_break_segment() {
        let mut seg = Segment::new();
        assert_eq!(seg.observe_estimate(&estimate(500.0, true)), None);
        // Slow drift is followed.
        assert_eq!(seg.observe_estimate(&estimate(490.0, true)), None);
        // A single jumped estimate is not enough.
        assert_eq!(seg.observe_estimate(&estimate(800.0, false)), None);
        assert_eq!(seg.observe_estimate(&estimate(495.0, true)), None);
        // Two in a row are.
        assert_eq!(seg.observe_estimate(&estimate(800.0, false)), None);
        assert_eq!(
            seg.observe_estimate(&estimate(820.0, false)),
            Some(SegmentBreak::OffsetStep)
        );
        assert_eq!(seg.count(SegmentBreak::OffsetStep), 1);
        // The next segment needs a fresh locked baseline.
        assert_eq!(seg.observe_estimate(&estimate(100.0, false)), None);
        assert_eq!(seg.observe_estimate(&estimate(900.0, false)), None);
    }

    #[test]
    fn a_new_connection_forgets_the_old_playhead() {
        let mut seg = Segment::new();
        seg.observe_poll(600_000, URI, false);
        seg.start(SegmentBreak::NewConnection);
        assert_eq!(seg.observe_poll(1_000, URI, false), None);
        assert_eq!(seg.count(SegmentBreak::NewConnection), 1);
    }
}
