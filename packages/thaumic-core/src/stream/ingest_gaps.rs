//! Decides when audio reaching this machine late deserves a notice.
//!
//! A PCM connection's cadence plays silence when its queue, the stream's
//! smoothing (jitter buffer), runs dry, and holds playback afterwards until
//! the queue refills. Every connection of the stream draws on the same
//! audio, so a gap in its arrival reaches every speaker at once: that is
//! the one fault more smoothing fixes, unlike a single speaker cutting out,
//! which needs a longer speaker head start.
//!
//! [`IngestGapWindow`] counts the gaps a connection saw over the last
//! minute and reports once two of them fall in it. Gaps of
//! [`INGEST_GAP_MAX_MS`] or more are left out: that is the source pausing
//! or the browser stopping, which no smoothing covers and nothing needs
//! telling about. [`IngestGapLimiter`] then lets a stream raise at most one
//! notice every [`INGEST_NOTICE_INTERVAL`], however many of its connections
//! saw the same gaps.
//!
//! The extension's own capture-health alert explains some gaps (frames the
//! capture dropped before they were ever sent); this machine cannot see
//! those reports, so the popup holds this notice back while that alert
//! shows.

use std::collections::VecDeque;
use std::time::{Duration, Instant};

use crate::protocol_constants::PCM_SMOOTHING_OPTIONS_MS;

/// How far back gaps count.
pub const INGEST_GAP_WINDOW: Duration = Duration::from_secs(60);

/// Gaps within [`INGEST_GAP_WINDOW`] that raise a notice.
pub const INGEST_GAPS_FOR_NOTICE: usize = 2;

/// A gap in the audio's arrival at least this long is not counted: the
/// source paused or stopped.
pub const INGEST_GAP_MAX_MS: u64 = 2000;

/// Room the suggested smoothing leaves above the worst gap, in ms.
pub const INGEST_GAP_MARGIN_MS: u64 = 50;

/// Shortest time between two ingest-gap notices for one stream.
pub const INGEST_NOTICE_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// What a connection's gaps over the last minute came to, once they call
/// for a notice.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IngestGapsReport {
    /// Gaps counted in the last minute.
    pub gaps_last_minute: u32,
    /// The longest of them, in ms of the audio's arrival.
    pub worst_gap_ms: u32,
    /// The smoothing the stream runs with, in ms.
    pub smoothing_ms: u32,
    /// The smoothing step that would cover the worst gap (see
    /// [`suggest_smoothing_ms`]).
    pub suggested_smoothing_ms: Option<u32>,
}

/// The gaps one connection saw over the last [`INGEST_GAP_WINDOW`].
#[derive(Debug, Default)]
pub struct IngestGapWindow {
    gaps: VecDeque<(Instant, u64)>,
}

impl IngestGapWindow {
    /// An empty window.
    pub fn new() -> Self {
        Self::default()
    }

    /// Records a gap of `gap_ms` in the audio's arrival that ended at `now`,
    /// on a stream smoothing `smoothing_ms`. Returns a report when the
    /// window now holds [`INGEST_GAPS_FOR_NOTICE`] counted gaps.
    pub fn record(
        &mut self,
        now: Instant,
        gap_ms: u64,
        smoothing_ms: u64,
    ) -> Option<IngestGapsReport> {
        while let Some((at, _)) = self.gaps.front() {
            if now.saturating_duration_since(*at) > INGEST_GAP_WINDOW {
                self.gaps.pop_front();
            } else {
                break;
            }
        }
        if gap_ms >= INGEST_GAP_MAX_MS {
            return None;
        }
        self.gaps.push_back((now, gap_ms));
        if self.gaps.len() < INGEST_GAPS_FOR_NOTICE {
            return None;
        }
        let worst = self.gaps.iter().map(|(_, g)| *g).max().unwrap_or(gap_ms);
        let ms = |v: u64| u32::try_from(v).unwrap_or(u32::MAX);
        Some(IngestGapsReport {
            gaps_last_minute: ms(self.gaps.len() as u64),
            worst_gap_ms: ms(worst),
            smoothing_ms: ms(smoothing_ms),
            suggested_smoothing_ms: suggest_smoothing_ms(worst, smoothing_ms),
        })
    }
}

/// The smallest smoothing step offered ([`PCM_SMOOTHING_OPTIONS_MS`]) that
/// is at least `worst_gap_ms` plus [`INGEST_GAP_MARGIN_MS`] and above
/// `smoothing_ms`, or `None` when no step is: the gap is more than
/// smoothing can cover.
pub fn suggest_smoothing_ms(worst_gap_ms: u64, smoothing_ms: u64) -> Option<u32> {
    let needed = worst_gap_ms + INGEST_GAP_MARGIN_MS;
    PCM_SMOOTHING_OPTIONS_MS
        .iter()
        .copied()
        .find(|&step| u64::from(step) >= needed && u64::from(step) > smoothing_ms)
}

/// Lets one stream raise at most one ingest-gap notice every
/// [`INGEST_NOTICE_INTERVAL`], shared by all its connections.
#[derive(Debug, Default)]
pub struct IngestGapLimiter {
    last: parking_lot::Mutex<Option<Instant>>,
}

impl IngestGapLimiter {
    /// Claims the right to raise a notice at `now`: `true` at most once
    /// every [`INGEST_NOTICE_INTERVAL`].
    pub fn claim(&self, now: Instant) -> bool {
        let mut last = self.last.lock();
        let due = last.map_or(true, |at| {
            now.saturating_duration_since(at) >= INGEST_NOTICE_INTERVAL
        });
        if due {
            *last = Some(now);
        }
        due
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_gap_is_not_a_notice_and_two_in_a_minute_are() {
        let mut window = IngestGapWindow::new();
        let t0 = Instant::now();
        assert_eq!(window.record(t0, 260, 200), None);
        let report = window
            .record(t0 + Duration::from_secs(20), 280, 200)
            .expect("second gap within the minute");
        assert_eq!(
            report,
            IngestGapsReport {
                gaps_last_minute: 2,
                worst_gap_ms: 280,
                smoothing_ms: 200,
                // 280 + 50 needs 330: the next step up is 500.
                suggested_smoothing_ms: Some(500),
            }
        );
    }

    #[test]
    fn gaps_more_than_a_minute_apart_do_not_add_up() {
        let mut window = IngestGapWindow::new();
        let t0 = Instant::now();
        assert_eq!(window.record(t0, 260, 200), None);
        assert_eq!(window.record(t0 + Duration::from_secs(61), 260, 200), None);
        assert!(window
            .record(t0 + Duration::from_secs(90), 260, 200)
            .is_some());
    }

    #[test]
    fn ingest_gaps_ignore_long_and_capture_explained_gaps() {
        // A gap of two seconds or more is the source pausing, not late audio.
        // (Gaps the capture itself explains are held back by the popup, which
        // alone sees the capture-health reports.)
        let mut window = IngestGapWindow::new();
        let t0 = Instant::now();
        assert_eq!(window.record(t0, 2_000, 200), None);
        assert_eq!(window.record(t0 + Duration::from_secs(5), 5_000, 200), None);
        assert_eq!(window.record(t0 + Duration::from_secs(10), 250, 200), None);
        let report = window
            .record(t0 + Duration::from_secs(15), 1_999, 200)
            .expect("two short gaps");
        assert_eq!(report.gaps_last_minute, 2);
        assert_eq!(report.worst_gap_ms, 1_999);
    }

    #[test]
    fn ingest_no_suggestion_above_500() {
        assert_eq!(suggest_smoothing_ms(120, 100), Some(200));
        assert_eq!(
            suggest_smoothing_ms(150, 100),
            Some(200),
            "ties go to the step"
        );
        assert_eq!(suggest_smoothing_ms(200, 200), Some(300));
        assert_eq!(suggest_smoothing_ms(450, 300), Some(500));
        assert_eq!(
            suggest_smoothing_ms(451, 300),
            None,
            "501 is past the last step"
        );
        // A gap the current smoothing already covers still asks for more:
        // it ran dry, so the gap was longer than it by the silence played.
        assert_eq!(suggest_smoothing_ms(100, 300), Some(500));
        assert_eq!(
            suggest_smoothing_ms(100, 500),
            None,
            "already at the last step"
        );
    }

    #[test]
    fn ingest_gaps_rate_limited() {
        let limiter = IngestGapLimiter::default();
        let t0 = Instant::now();
        assert!(limiter.claim(t0));
        assert!(
            !limiter.claim(t0),
            "a second connection seeing the same gaps"
        );
        assert!(!limiter.claim(t0 + Duration::from_secs(9 * 60)));
        assert!(limiter.claim(t0 + INGEST_NOTICE_INTERVAL));
        assert!(!limiter.claim(t0 + INGEST_NOTICE_INTERVAL + Duration::from_secs(1)));
    }
}
