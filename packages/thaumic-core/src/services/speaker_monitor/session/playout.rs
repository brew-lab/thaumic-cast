//! The playout latency estimate that video sync plays the sound early by.
//!
//! The companion's share of the delay between the browser's audio and the
//! speaker's sound is the time audio waits in the cadence queue here (Q)
//! plus the speaker's reserve (R): the audio delivered to it that it has not
//! played yet. Both are already measured, so the estimate only reads them:
//!
//! - Q is the median cadence queue over the last [`QUEUE_WINDOW`], from the
//!   playout's pipeline snapshots, in frames times the frame length.
//! - R is the tracker's reserve estimate once it is locked
//!   (`source = reserve`) and made since the latest segment break. Until
//!   then it is the prior (`source = prior`):
//!   the head start the connection was sent, which is what the reserve
//!   starts from, plus where the speaker's past connections settled
//!   relative to it (the drift controller's calibration history), or
//!   [`PRIOR_CALIB_MS`] with no history.
//!
//! While a continuation switch is being measured the tracker's estimate is
//! the one from before the switch, carried along the clock and the
//! correction, and held locked. It stays the reserve here: in simulation it
//! moves by at most about 25 ms at the switch, where falling back to the
//! prior moved the estimate by up to 60 ms and stepped its epoch twice.
//!
//! Only a PCM connection's reserve is measured, so only a PCM connection
//! gets an estimate.
//!
//! The reserve is in the tracker's reading of the speaker's position, not
//! physical time: on a speaker that reports its position ahead of what it
//! plays, it reads low by that offset (about 200 ms on the simulated
//! Play:1), and the hand-off from the prior steps by as much. The epoch
//! marks the step; the speaker's output delay and the trim absorb the
//! constant.
//!
//! The estimate's `epoch` steps only when the estimate may have stepped: a
//! new connection, a change of source, or a segment break in the tracker's
//! measurements. Routine wobble is left to the client's own threshold.
//!
//! A break the tracker finds between reports (the speaker stopped playing,
//! its position went backwards, the track changed) leaves its latest
//! estimate standing until the next report, which is 30 s off, or longer
//! while the speaker is paused. That estimate was made before the break, so
//! the source falls back to the prior until a locked estimate is made after
//! it. An epoch step alone therefore never means the figure is fresh.

use std::time::{Duration, Instant};

use crate::events::{PlayoutLatency, PlayoutSource};
use crate::services::speaker_monitor::session::SpeakerSession;
use crate::services::speaker_monitor::{ReserveEstimate, SegmentBreak};
use crate::stream::HeadStart;

/// Where a speaker with no past connection is expected to settle relative to
/// the head start it was sent, in ms, for the prior. The middle of the field
/// tally of connections' `target − H` (8, 10, 15, 20, 32 and 42 ms).
///
/// Not the drift controller's own first-connection bias, which is a guess
/// for its outlier test and sits on the other side of zero.
pub(crate) const PRIOR_CALIB_MS: f64 = 20.0;

/// The prior's uncertainty, in ms: wide enough to cover the field tally's
/// spread and the head start's own share of the reserve.
pub(crate) const PRIOR_UNCERTAINTY_MS: f64 = 60.0;

/// How far back the cadence queue is read: about ten pipeline snapshots at
/// the default frame length.
pub(crate) const QUEUE_WINDOW: Duration = Duration::from_secs(5);

/// How often a video-sync session writes its playout estimate to the debug
/// log.
const PLAYOUT_LOG_INTERVAL: Duration = Duration::from_secs(30);

/// What the estimate is made from, all read from state the monitor keeps.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PlayoutInputs<'a> {
    /// Whether the connection is PCM, whose reserve is measured.
    pub pcm: bool,
    /// The head start the connection was sent, once known.
    pub head_start: Option<HeadStart>,
    /// The tracker's latest reserve estimate of the current segment
    /// (carried across a continuation switch while it is measured).
    pub estimate: Option<ReserveEstimate>,
    /// Whether `estimate` was made before the latest segment break, so says
    /// nothing about the reserve now.
    pub stale: bool,
    /// The median of the speaker's past connections' `target − H`, if any.
    pub bias_ms: Option<f64>,
    /// Cadence queue lengths over [`QUEUE_WINDOW`], in frames.
    pub queue_frames: &'a [usize],
    /// The stream's frame length, in ms.
    pub frame_ms: u32,
}

/// One playout estimate, before it is given an epoch.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct PlayoutFigures {
    /// Q + R, in ms.
    pub companion_ms: f64,
    /// `sqrt(u_R² + u_Q²)`, in ms: a spread figure, not a standard
    /// deviation (see [`PlayoutLatency::uncertainty_ms`]).
    pub uncertainty_ms: f64,
    /// Where R came from.
    pub source: PlayoutSource,
    /// Q, in ms.
    pub queue_ms: f64,
    /// R, in ms.
    pub reserve_ms: f64,
    /// The head start sent, in ms.
    pub head_start_ms: u32,
    /// The calibration the prior adds (or would add) to the head start.
    pub calib_ms: f64,
}

/// The playout estimate from `inputs`, or `None` when the connection is not
/// PCM, its head start is not known yet or there are no queue samples.
pub(crate) fn estimate(inputs: &PlayoutInputs<'_>) -> Option<PlayoutFigures> {
    if !inputs.pcm || inputs.queue_frames.is_empty() {
        return None;
    }
    let head_start = inputs.head_start?;
    let frame_ms = f64::from(inputs.frame_ms);
    let mut queue: Vec<f64> = inputs
        .queue_frames
        .iter()
        .map(|&n| n as f64 * frame_ms)
        .collect();
    queue.sort_unstable_by(f64::total_cmp);
    let queue_ms = percentile(&queue, 0.5);
    let u_queue = frame_ms + (percentile(&queue, 0.9) - percentile(&queue, 0.1)) / 2.0;

    let calib_ms = inputs.bias_ms.unwrap_or(PRIOR_CALIB_MS);
    let (source, reserve_ms, u_reserve) = match inputs.estimate {
        Some(e) if e.locked() && !inputs.stale => {
            (PlayoutSource::Reserve, e.reserve_ms, e.half_width_ms)
        }
        _ => (
            PlayoutSource::Prior,
            f64::from(head_start.sent_ms) + calib_ms,
            PRIOR_UNCERTAINTY_MS,
        ),
    };
    Some(PlayoutFigures {
        companion_ms: queue_ms + reserve_ms,
        uncertainty_ms: u_reserve.hypot(u_queue),
        source,
        queue_ms,
        reserve_ms,
        head_start_ms: head_start.sent_ms,
        calib_ms,
    })
}

/// The `p` quantile of `sorted` (ascending, not empty), interpolated
/// linearly between ranks.
fn percentile(sorted: &[f64], p: f64) -> f64 {
    let rank = p * (sorted.len() - 1) as f64;
    let lo = rank.floor() as usize;
    let hi = rank.ceil() as usize;
    sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo as f64)
}

/// Gives each playout estimate its epoch, which steps only when the estimate
/// may have stepped.
#[derive(Debug, Clone, Default)]
pub(crate) struct PlayoutTracker {
    /// The epoch last given; 0 before the first estimate.
    epoch: u32,
    /// The connection epoch, source and segment breaks the last estimate was
    /// made under.
    seen: Option<(u64, PlayoutSource, u32)>,
    /// The connection epoch and segment breaks last looked at by
    /// [`Self::stale`].
    breaks_seen: Option<(u64, u32)>,
    /// When the tracker's estimate standing at the latest segment break seen
    /// was made: estimates made no later than this are from before it.
    stale_at: Option<f64>,
    /// When the estimate was last written to the debug log.
    last_log: Option<Instant>,
}

impl PlayoutTracker {
    /// Gives `figures`, measured under connection epoch `connection_epoch`
    /// after `breaks` segment breaks in that connection, its epoch, and
    /// returns the estimate as sent to clients.
    pub(crate) fn step(
        &mut self,
        connection_epoch: u64,
        breaks: u32,
        figures: &PlayoutFigures,
    ) -> PlayoutLatency {
        let now = (connection_epoch, figures.source, breaks);
        if self.seen != Some(now) {
            self.epoch = self.epoch.saturating_add(1);
            self.seen = Some(now);
        }
        PlayoutLatency {
            companion_ms: whole_ms(figures.companion_ms),
            uncertainty_ms: whole_ms(figures.uncertainty_ms),
            source: figures.source,
            epoch: self.epoch,
            queue_ms: whole_ms(figures.queue_ms),
            reserve_ms: whole_ms(figures.reserve_ms),
            head_start_ms: figures.head_start_ms,
            calib_ms: figures.calib_ms.round() as i32,
        }
    }

    /// Whether `estimate`, the tracker's latest, was made before a segment
    /// break seen under connection epoch `connection_epoch` (`breaks` is
    /// that connection's break count so far).
    ///
    /// A break raised between reports does not clear the tracker's estimate,
    /// so the estimate standing when the count is first seen to move is from
    /// before it, and so is any no newer. Only a break within a connection
    /// counts: a new connection starts with no estimate. Looked at about once
    /// a second, against reports every 30 s, so a report made after a break
    /// is not mistaken for one from before it unless events stopped for a
    /// whole report, and then only until the next report.
    pub(crate) fn stale(
        &mut self,
        connection_epoch: u64,
        breaks: u32,
        estimate: Option<&ReserveEstimate>,
    ) -> bool {
        let now = (connection_epoch, breaks);
        if self.breaks_seen != Some(now) {
            let same_connection = self
                .breaks_seen
                .is_some_and(|(epoch, _)| epoch == connection_epoch);
            self.stale_at = if same_connection {
                estimate.map(|e| e.at)
            } else {
                None
            };
            self.breaks_seen = Some(now);
        }
        match (self.stale_at, estimate) {
            (Some(at), Some(e)) => e.at <= at,
            _ => false,
        }
    }

    /// Whether the estimate is due in the debug log, marking it written if
    /// so.
    fn take_log_due(&mut self, now: Instant) -> bool {
        let due = self.last_log.map_or(true, |at| {
            now.saturating_duration_since(at) >= PLAYOUT_LOG_INTERVAL
        });
        if due {
            self.last_log = Some(now);
        }
        due
    }
}

/// `ms` rounded to a whole, non-negative `u32`.
fn whole_ms(ms: f64) -> u32 {
    ms.round().clamp(0.0, f64::from(u32::MAX)) as u32
}

impl SpeakerSession {
    /// The playout estimate for this speaker's current connection, with its
    /// epoch, or `None` when there is none (see [`estimate`]).
    ///
    /// Copies the last [`QUEUE_WINDOW`] of pipeline snapshots out under the
    /// lock the cadence takes every 500 ms (about ten entries), so it is
    /// called only when an event is about to be sent, at most once a second.
    pub(crate) fn playout_latency(&mut self) -> Option<PlayoutLatency> {
        if !self.pcm {
            return None;
        }
        let frame_ms = self.frame_duration_ms?;
        let tap = self.live_tap()?;
        let queue_frames: Vec<usize> = tap
            .recent_pipeline(QUEUE_WINDOW)
            .iter()
            .map(|s| s.queue_len)
            .collect();
        let connection_epoch = self.last_epoch_id();
        let breaks = segment_breaks(|r| self.tracker.connection_breaks(r));
        let last = self.tracker.last_estimate().copied();
        // The tracker's own mark (cleared by the next locked estimate) is
        // kept only when the report before the break had an acknowledged
        // reserve; the break count catches the rest.
        let stale = self.tracker.pre_break().is_some()
            | self
                .playout_tracker
                .stale(connection_epoch, breaks, last.as_ref());
        let figures = estimate(&PlayoutInputs {
            pcm: self.pcm,
            head_start: tap.head_start(),
            estimate: last,
            stale,
            bias_ms: self.drift.state().bias_ms(),
            queue_frames: &queue_frames,
            frame_ms,
        })?;
        Some(
            self.playout_tracker
                .step(connection_epoch, breaks, &figures),
        )
    }

    /// Writes `playout` to the debug log every [`PLAYOUT_LOG_INTERVAL`].
    pub(crate) fn log_playout(
        &mut self,
        stream_id: &str,
        speaker_ip: &str,
        playout: &PlayoutLatency,
    ) {
        if !log::log_enabled!(log::Level::Debug)
            || !self.playout_tracker.take_log_due(Instant::now())
        {
            return;
        }
        log::debug!(
            "[VideoSync] stream={}, speaker={}: playout {}\u{b1}{}ms source={:?} epoch={} \
             queue={}ms reserve={}ms head_start={}ms calib={:+}ms",
            stream_id,
            speaker_ip,
            playout.companion_ms,
            playout.uncertainty_ms,
            playout.source,
            playout.epoch,
            playout.queue_ms,
            playout.reserve_ms,
            playout.head_start_ms,
            playout.calib_ms
        );
    }
}

/// Segment breaks in the current connection, all reasons but the connection
/// itself starting, counted by `count`.
pub(crate) fn segment_breaks(count: impl Fn(SegmentBreak) -> u32) -> u32 {
    SegmentBreak::ALL
        .iter()
        .filter(|r| **r != SegmentBreak::NewConnection)
        .map(|r| count(*r))
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::speaker_monitor::LockReason;

    const QUEUE: [usize; 10] = [19, 19, 20, 20, 20, 20, 20, 21, 21, 20];

    fn inputs(queue: &[usize]) -> PlayoutInputs<'_> {
        PlayoutInputs {
            pcm: true,
            head_start: Some(HeadStart::new(500, 500)),
            estimate: None,
            stale: false,
            bias_ms: None,
            queue_frames: queue,
            frame_ms: 10,
        }
    }

    fn reserve(reserve_ms: f64, half_width_ms: f64, lock_reason: LockReason) -> ReserveEstimate {
        ReserveEstimate {
            at: 0.0,
            reserve_ms,
            half_width_ms,
            inconsistent: false,
            jitter_ms: 20.0,
            polls: 60,
            lock_reason,
        }
    }

    #[test]
    fn prior_with_no_history_uses_the_default_calibration() {
        let f = estimate(&inputs(&QUEUE)).expect("estimate");
        assert_eq!(f.source, PlayoutSource::Prior);
        assert_eq!(f.calib_ms, PRIOR_CALIB_MS);
        assert_eq!(f.reserve_ms, 520.0);
        assert_eq!(f.queue_ms, 200.0);
        assert_eq!(f.companion_ms, 720.0);
        assert_eq!(f.head_start_ms, 500);
    }

    #[test]
    fn prior_with_history_uses_the_median_calibration() {
        let f = estimate(&PlayoutInputs {
            bias_ms: Some(32.0),
            ..inputs(&QUEUE)
        })
        .expect("estimate");
        assert_eq!(f.source, PlayoutSource::Prior);
        assert_eq!(f.calib_ms, 32.0);
        assert_eq!(f.reserve_ms, 532.0);
        // One frame plus half the p10..p90 spread (190..210 ms).
        assert!((f.uncertainty_ms - PRIOR_UNCERTAINTY_MS.hypot(20.0)).abs() < 1e-9);
    }

    #[test]
    fn a_locked_estimate_is_the_reserve() {
        let f = estimate(&PlayoutInputs {
            estimate: Some(reserve(547.0, 28.0, LockReason::Tight)),
            bias_ms: Some(32.0),
            ..inputs(&QUEUE)
        })
        .expect("estimate");
        assert_eq!(f.source, PlayoutSource::Reserve);
        assert_eq!(f.reserve_ms, 547.0);
        assert_eq!(f.companion_ms, 747.0);
        assert!((f.uncertainty_ms - 28.0f64.hypot(20.0)).abs() < 1e-9);
        // Reported for the log, though the reserve does not use it.
        assert_eq!(f.calib_ms, 32.0);
    }

    /// Held is locked, as the estimate carried across a continuation
    /// switch is while the switch is measured.
    #[test]
    fn a_held_estimate_counts_as_locked() {
        let f = estimate(&PlayoutInputs {
            estimate: Some(reserve(547.0, 70.0, LockReason::Held)),
            ..inputs(&QUEUE)
        })
        .expect("estimate");
        assert_eq!(f.source, PlayoutSource::Reserve);
        assert_eq!(f.reserve_ms, 547.0);
    }

    #[test]
    fn an_unlocked_estimate_falls_back_to_the_prior() {
        let f = estimate(&PlayoutInputs {
            estimate: Some(reserve(547.0, 140.0, LockReason::Unlocked)),
            ..inputs(&QUEUE)
        })
        .expect("estimate");
        assert_eq!(f.source, PlayoutSource::Prior);
        assert_eq!(f.reserve_ms, 520.0);
    }

    #[test]
    fn a_locked_estimate_from_before_a_break_falls_back_to_the_prior() {
        let f = estimate(&PlayoutInputs {
            estimate: Some(reserve(547.0, 28.0, LockReason::Tight)),
            stale: true,
            ..inputs(&QUEUE)
        })
        .expect("estimate");
        assert_eq!(f.source, PlayoutSource::Prior);
        assert_eq!(f.reserve_ms, 520.0);
    }

    fn reserve_at(at: f64) -> ReserveEstimate {
        ReserveEstimate {
            at,
            ..reserve(547.0, 28.0, LockReason::Tight)
        }
    }

    #[test]
    fn an_estimate_standing_at_a_break_is_stale_until_the_next_report() {
        let mut t = PlayoutTracker::default();
        let before = reserve_at(30_000.0);
        assert!(!t.stale(3, 0, Some(&before)), "no break yet");
        assert!(!t.stale(3, 0, Some(&before)));
        // A break between reports: the estimate standing is from before it.
        assert!(t.stale(3, 1, Some(&before)));
        assert!(t.stale(3, 1, Some(&before)), "while paused, say");
        // The next report is from after it.
        assert!(!t.stale(3, 1, Some(&reserve_at(60_000.0))));
        // A break found by a report clears the estimate.
        assert!(!t.stale(3, 2, None));
        assert!(!t.stale(3, 2, Some(&reserve_at(90_000.0))));
    }

    #[test]
    fn a_new_connection_is_never_stale() {
        let mut t = PlayoutTracker::default();
        assert!(!t.stale(3, 0, Some(&reserve_at(30_000.0))));
        // A connection first looked at after breaks of its own, and the
        // next connection, start from whatever the tracker holds.
        assert!(!t.stale(4, 2, Some(&reserve_at(10_000.0))));
        assert!(!t.stale(4, 2, Some(&reserve_at(10_000.0))));
        assert!(t.stale(4, 3, Some(&reserve_at(10_000.0))));
        assert!(!t.stale(5, 0, Some(&reserve_at(10_000.0))));
    }

    #[test]
    fn a_compressed_connection_has_no_estimate() {
        assert!(estimate(&PlayoutInputs {
            pcm: false,
            ..inputs(&QUEUE)
        })
        .is_none());
    }

    #[test]
    fn no_head_start_means_no_estimate() {
        assert!(estimate(&PlayoutInputs {
            head_start: None,
            ..inputs(&QUEUE)
        })
        .is_none());
    }

    #[test]
    fn no_queue_samples_means_no_estimate() {
        assert!(estimate(&inputs(&[])).is_none());
    }

    #[test]
    fn the_queue_is_the_median_and_its_uncertainty_the_spread() {
        // 10 ms frames: 120..300 ms around a median of 200.
        let queue = [12, 30, 20, 20, 20, 20, 20, 20, 20, 18];
        let f = estimate(&inputs(&queue)).expect("estimate");
        let mut sorted: Vec<f64> = queue.iter().map(|&n| n as f64 * 10.0).collect();
        sorted.sort_unstable_by(f64::total_cmp);
        assert_eq!(f.queue_ms, 200.0);
        let u_q = 10.0 + (percentile(&sorted, 0.9) - percentile(&sorted, 0.1)) / 2.0;
        assert!((f.uncertainty_ms - PRIOR_UNCERTAINTY_MS.hypot(u_q)).abs() < 1e-9);
        // A steady queue costs one frame.
        let steady = estimate(&inputs(&[20; 10])).expect("estimate");
        assert!((steady.uncertainty_ms - PRIOR_UNCERTAINTY_MS.hypot(10.0)).abs() < 1e-9);
        // An even count takes the middle two.
        let even = estimate(&inputs(&[10, 20])).expect("estimate");
        assert_eq!(even.queue_ms, 150.0);
    }

    #[test]
    fn percentile_interpolates_between_ranks() {
        let v = [100.0, 200.0, 300.0];
        assert_eq!(percentile(&v, 0.5), 200.0);
        assert_eq!(percentile(&v, 0.25), 150.0);
        assert_eq!(percentile(&v, 0.0), 100.0);
        assert_eq!(percentile(&v, 1.0), 300.0);
        assert_eq!(percentile(&[42.0], 0.9), 42.0);
    }

    fn figures(source: PlayoutSource, companion_ms: f64) -> PlayoutFigures {
        PlayoutFigures {
            companion_ms,
            uncertainty_ms: 30.0,
            source,
            queue_ms: 200.0,
            reserve_ms: companion_ms - 200.0,
            head_start_ms: 500,
            calib_ms: 20.0,
        }
    }

    #[test]
    fn the_epoch_starts_at_one_and_holds_for_unchanged_inputs() {
        let mut t = PlayoutTracker::default();
        let first = t.step(3, 0, &figures(PlayoutSource::Prior, 720.0));
        assert_eq!(first.epoch, 1);
        // Routine wobble in the figures does not step it.
        for ms in [722.0, 715.0, 731.0] {
            assert_eq!(t.step(3, 0, &figures(PlayoutSource::Prior, ms)).epoch, 1);
        }
    }

    #[test]
    fn the_epoch_steps_on_connection_source_and_break() {
        let mut t = PlayoutTracker::default();
        assert_eq!(t.step(3, 0, &figures(PlayoutSource::Prior, 720.0)).epoch, 1);
        // The reserve locks.
        let locked = t.step(3, 0, &figures(PlayoutSource::Reserve, 741.0));
        assert_eq!(locked.epoch, 2);
        assert_eq!(locked.source, PlayoutSource::Reserve);
        assert_eq!(
            t.step(3, 0, &figures(PlayoutSource::Reserve, 745.0)).epoch,
            2
        );
        // A segment break, with the estimate still locked by the next report.
        assert_eq!(
            t.step(3, 1, &figures(PlayoutSource::Reserve, 745.0)).epoch,
            3
        );
        assert_eq!(
            t.step(3, 1, &figures(PlayoutSource::Reserve, 745.0)).epoch,
            3
        );
        // A new connection, whose break count starts again.
        assert_eq!(
            t.step(4, 0, &figures(PlayoutSource::Reserve, 745.0)).epoch,
            4
        );
        assert_eq!(
            t.step(4, 0, &figures(PlayoutSource::Reserve, 745.0)).epoch,
            4
        );
    }

    #[test]
    fn the_estimate_is_rounded_for_the_wire() {
        let mut t = PlayoutTracker::default();
        let p = t.step(
            1,
            0,
            &PlayoutFigures {
                companion_ms: 719.6,
                uncertainty_ms: 61.2,
                source: PlayoutSource::Prior,
                queue_ms: 199.6,
                reserve_ms: 520.0,
                head_start_ms: 500,
                calib_ms: -7.6,
            },
        );
        assert_eq!(p.companion_ms, 720);
        assert_eq!(p.uncertainty_ms, 61);
        assert_eq!(p.queue_ms, 200);
        assert_eq!(p.calib_ms, -8);
        assert_eq!(whole_ms(-5.0), 0);
    }

    #[test]
    fn segment_breaks_leave_out_the_connection_starting() {
        let n = segment_breaks(|r| match r {
            SegmentBreak::NewConnection => 100,
            SegmentBreak::OffsetStep => 2,
            SegmentBreak::NotPlaying => 1,
            _ => 0,
        });
        assert_eq!(n, 3);
    }
}
