//! Decides what, if anything, the user is told about one speaker.
//!
//! The monitor hands [`NoticeState::update`] what each 30 s report found;
//! the notice it returns rides the speaker health event, and clients only
//! render it. Deciding here keeps every client saying the same thing, and
//! keeps the judgement next to the figures it is made from.
//!
//! A notice appears only when a speaker ran out of audio, came close, or
//! will soon, and nothing is already fixing it. Trouble on the link to the
//! speaker is never a notice on its own: the speaker head start usually
//! rides it out, and a notice that asks for nothing helps nobody.
//!
//! The kinds, most urgent first:
//!
//! - **Head start ran out** ([`SpeakerNoticeKind::HeadStartRanOut`]): the
//!   speaker underran (its acknowledged reserve went below zero, or its
//!   reserve stepped as an underrun makes it), and a Wi-Fi stall or a poor
//!   link caused it. Suggests the smallest step of
//!   [`HEAD_START_LADDER_MS`] that would have covered it.
//! - **Head start close** ([`SpeakerNoticeKind::HeadStartClose`]): a stall
//!   left less than half the floor in hand, without an underrun.
//! - **No remedy** ([`SpeakerNoticeKind::HeadStartNoRemedy`]): either of
//!   the two, but even the longest head start would not have covered it.
//! - **Running low** ([`SpeakerNoticeKind::RunningLow`]): the reserve
//!   itself, not a stall's dip, is below the floor.
//! - **Drift uncorrected** ([`SpeakerNoticeKind::DriftUncorrected`]): the
//!   speaker plays faster than audio arrives and will reach the floor
//!   within half an hour, with nothing correcting it.
//!
//! Head-start kinds exist only for PCM connections, whose head start is
//! known, and stand for the rest of the cast once raised. Each episode gets
//! a `notice_id` that stays the same while it is repeated, so a client can
//! dismiss it once; the id changes only on a new episode or an escalation
//! (close to ran out, or a larger suggestion), which a client shows again.

use std::time::{Duration, Instant};

use serde::Serialize;

use super::tracker::{low_clear_ms, low_floor_ms, AckedReserve, PreBreak};
use crate::protocol_constants::HEAD_START_LADDER_MS;
use crate::stream::HeadStart;

/// Shortest time between two episodes of the same kind for one speaker.
pub const NOTICE_EPISODE_INTERVAL: Duration = Duration::from_secs(10 * 60);

/// How long the acknowledged reserve's 10th percentile must stay above the
/// clear level before a running-low notice clears.
pub const RUNNING_LOW_CLEAR_AFTER: Duration = Duration::from_secs(60);

/// Projected time to the floor below which an uncorrected drift is a
/// notice.
pub const DRIFT_NOTICE_SECS: f64 = 30.0 * 60.0;

/// Projected time to the floor above which a drift notice clears.
pub const DRIFT_NOTICE_CLEAR_SECS: f64 = 45.0 * 60.0;

/// Least stall, in ms, that counts as having caused a head-start notice,
/// whatever the head start. With the head start off, half of it is nothing,
/// so a stall must still have been measured and be more than jitter.
pub const MIN_NOTICE_STALL_MS: f64 = 20.0;

/// What a notice is about. Wire strings are part of the client protocol:
/// never rename a variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeakerNoticeKind {
    /// A stall outlasted the speaker head start and the speaker cut out.
    HeadStartRanOut,
    /// A stall nearly outlasted the speaker head start.
    HeadStartClose,
    /// A stall that the longest head start would not have covered either.
    HeadStartNoRemedy,
    /// The reserve itself is below the floor.
    RunningLow,
    /// The speaker's clock is draining the reserve and nothing corrects it.
    DriftUncorrected,
}

impl SpeakerNoticeKind {
    /// The kind as a log token (its wire string).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::HeadStartRanOut => "head_start_ran_out",
            Self::HeadStartClose => "head_start_close",
            Self::HeadStartNoRemedy => "head_start_no_remedy",
            Self::RunningLow => "running_low",
            Self::DriftUncorrected => "drift_uncorrected",
        }
    }

    /// Whether the kind is about the speaker head start.
    pub fn is_head_start(self) -> bool {
        matches!(
            self,
            Self::HeadStartRanOut | Self::HeadStartClose | Self::HeadStartNoRemedy
        )
    }

    /// How urgent the kind is: a more urgent notice replaces a less urgent
    /// one.
    fn urgency(self) -> u8 {
        match self {
            Self::HeadStartNoRemedy => 5,
            Self::HeadStartRanOut => 4,
            Self::HeadStartClose => 3,
            Self::RunningLow => 2,
            Self::DriftUncorrected => 1,
        }
    }

    fn index(self) -> usize {
        match self {
            Self::HeadStartRanOut => 0,
            Self::HeadStartClose => 1,
            Self::HeadStartNoRemedy => 2,
            Self::RunningLow => 3,
            Self::DriftUncorrected => 4,
        }
    }
}

impl std::fmt::Display for SpeakerNoticeKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// What the user is told about one speaker, with the figures its wording
/// needs. Clients pick the words; every value is in ms unless named
/// otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerNotice {
    /// What the notice is about.
    pub kind: SpeakerNoticeKind,
    /// The episode, counted per stream and speaker: the same while the
    /// notice is repeated, new on a new episode or an escalation. Clients
    /// dismiss by it.
    pub notice_id: u64,
    /// The audio a stall held back from the speaker (head-start kinds).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stall_ms: Option<u32>,
    /// The audio the speaker had left at its lowest (head start close,
    /// ran out) or holds most of the time (running low).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub left_ms: Option<i32>,
    /// The speaker head start the connection was sent (PCM only).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head_start_ms: Option<u32>,
    /// The head start that would have covered the stall (head start close
    /// and ran out).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suggested_head_start_ms: Option<u32>,
    /// Minutes until the speaker runs low (drift).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub minutes: Option<u32>,
    /// Whether stopping and restarting the cast refills the speaker: only
    /// when its connection got the whole configured head start, since a
    /// restart gives a partial one the same partial burst again.
    pub restart_helps: bool,
}

/// What one report found about a speaker, as the notice decision needs it.
#[derive(Debug, Clone, Copy, Default, PartialEq)]
pub struct NoticeInput {
    /// Whether this report's reserve estimate is locked.
    pub locked: bool,
    /// The acknowledged reserve over this report's window, when it made an
    /// estimate.
    pub acked: Option<AckedReserve>,
    /// Whether this report's estimate broke its segment on an offset step
    /// (in either direction): an underrun the acknowledged reserve may not
    /// show.
    pub offset_step: bool,
    /// The acknowledged reserve from before the connection's latest segment
    /// break, judged when [`Self::offset_step`] is set.
    pub pre_break: Option<PreBreak>,
    /// The speaker head start the connection was sent; `None` for a
    /// compressed connection, which gets no head-start notices.
    pub head_start: Option<HeadStart>,
    /// How far the worst acknowledgement lag of this window stood above its
    /// median, in ms.
    pub stall_ms: Option<f64>,
    /// Whether the link to the speaker was judged poor.
    pub link_poor: bool,
    /// Seconds until the reserve reaches the floor at the net drain rate,
    /// when it is measurably draining.
    pub time_to_floor_s: Option<f64>,
    /// Whether clock drift correction is running on this connection. Always
    /// false until drift correction exists; a drift notice is then about
    /// what correction cannot make up, not about turning it on.
    pub drift_active: bool,
}

/// A head-start notice one report calls for.
#[derive(Debug, Clone, Copy, PartialEq)]
struct HeadStartFinding {
    kind: SpeakerNoticeKind,
    stall_ms: f64,
    left_ms: Option<f64>,
    head_start_ms: u32,
    suggested_ms: Option<u32>,
}

/// The smallest step of [`HEAD_START_LADDER_MS`] above `current_ms` that
/// keeps the speaker at or above its own floor after losing `needed_ms` to a
/// stall: the step `s` with `s − low_floor_ms(s) ≥ needed_ms`. `None` when
/// no step does.
pub fn suggest_head_start_ms(needed_ms: f64, current_ms: u32) -> Option<u32> {
    HEAD_START_LADDER_MS
        .iter()
        .copied()
        .find(|&s| s > current_ms && f64::from(s) - low_floor_ms(s) >= needed_ms)
}

/// The head-start notice this report calls for, if any.
fn find_head_start(input: &NoticeInput) -> Option<HeadStartFinding> {
    let h = input.head_start?;
    let head_start = f64::from(h.sent_ms);
    let floor = low_floor_ms(h.sent_ms);
    // Whether a stall of at least `share` (never less than the minimum)
    // was measured, or, with a head start to lose, the link was poor.
    let caused = |stall: Option<f64>, share: f64| {
        stall.is_some_and(|s| s >= share.max(MIN_NOTICE_STALL_MS))
            || (h.sent_ms > 0 && input.link_poor)
    };
    let acked_min = input.acked.filter(|_| input.locked).map(|a| a.min_ms);

    let (kind, stall, left, needed) = match acked_min {
        Some(min) if min < 0.0 => {
            if !caused(input.stall_ms, 0.5 * head_start) {
                return None;
            }
            // It had the head start, and the stall took all of it and more.
            let held_back = head_start - min;
            (
                SpeakerNoticeKind::HeadStartRanOut,
                held_back,
                Some(min),
                held_back,
            )
        }
        _ if input.offset_step => {
            // The reserve stepped: judged on the stall, the window's or the
            // one before the break, whichever was worse.
            let stall = match (
                input.stall_ms,
                input.pre_break.and_then(|p| p.acked.stall_ms),
            ) {
                (Some(a), Some(b)) => Some(a.max(b)),
                (a, b) => a.or(b),
            };
            if !caused(stall, 0.5 * head_start) {
                return None;
            }
            let stall = stall.unwrap_or(0.0);
            (SpeakerNoticeKind::HeadStartRanOut, stall, None, stall)
        }
        Some(min) if min < floor / 2.0 => {
            let held_back = head_start - min;
            // Only a stall that took a good part of what it had: a speaker
            // that settled this low has nothing to do with the head start.
            if !input
                .stall_ms
                .is_some_and(|s| s >= (0.5 * held_back).max(MIN_NOTICE_STALL_MS))
            {
                return None;
            }
            (
                SpeakerNoticeKind::HeadStartClose,
                held_back,
                Some(min),
                held_back,
            )
        }
        _ => return None,
    };
    let suggested = suggest_head_start_ms(needed, h.sent_ms);
    Some(HeadStartFinding {
        kind: if suggested.is_some() {
            kind
        } else {
            SpeakerNoticeKind::HeadStartNoRemedy
        },
        stall_ms: stall,
        left_ms: left,
        head_start_ms: h.sent_ms,
        suggested_ms: suggested,
    })
}

/// Whether the reserve itself, not a stall's dip, is below the floor: the
/// 10th percentile is below it and so is the median (the estimate less the
/// median lag). With the head start off, ordinary retransmission lag dips
/// the 10th percentile under 40 ms on every window; the head-start kinds
/// cover that.
fn running_low(input: &NoticeInput, floor: f64) -> bool {
    input.locked
        && input
            .acked
            .is_some_and(|a| a.p10_ms < floor && a.median_ms < floor)
}

fn round_ms(v: f64) -> u32 {
    v.max(0.0).round().min(f64::from(u32::MAX)) as u32
}

/// The notice standing for one speaker, and what decides when it clears.
#[derive(Debug, Clone, Default)]
pub struct NoticeState {
    active: Option<SpeakerNotice>,
    /// The last notice id handed out.
    last_id: u64,
    /// When each kind last started an episode, by
    /// [`SpeakerNoticeKind::index`].
    raised_at: [Option<Instant>; 5],
    /// Since when a running-low speaker's 10th percentile has stayed above
    /// the clear level.
    above_clear_since: Option<Instant>,
}

impl NoticeState {
    /// No notice yet.
    pub fn new() -> Self {
        Self::default()
    }

    /// The notice standing, if any.
    pub fn active(&self) -> Option<SpeakerNotice> {
        self.active
    }

    /// Steps the decision with one report taken at `now`, and returns the
    /// notice standing after it, to go out with the report. The same notice
    /// comes back, under the same id, until it clears or escalates.
    pub fn update(&mut self, now: Instant, input: &NoticeInput) -> Option<SpeakerNotice> {
        let restart_helps = input.head_start.is_some_and(|h| h.is_full());

        // Head-start kinds stand for the rest of the cast, and replace
        // anything less urgent at once.
        if let Some(found) = find_head_start(input) {
            let escalates = match self.active {
                Some(a) if a.kind.is_head_start() => {
                    found.kind.urgency() > a.kind.urgency()
                        || matches!(
                            (found.suggested_ms, a.suggested_head_start_ms),
                            (Some(new), Some(old)) if new > old
                        )
                }
                _ => true,
            };
            if escalates {
                // Never less urgent than what it replaces.
                let kind = match self.active {
                    Some(a)
                        if a.kind.is_head_start() && a.kind.urgency() > found.kind.urgency() =>
                    {
                        a.kind
                    }
                    _ => found.kind,
                };
                self.raise(
                    now,
                    SpeakerNotice {
                        kind,
                        notice_id: 0,
                        stall_ms: Some(round_ms(found.stall_ms)),
                        left_ms: found.left_ms.map(|v| v.round() as i32),
                        head_start_ms: Some(found.head_start_ms),
                        suggested_head_start_ms: found
                            .suggested_ms
                            .filter(|_| kind != SpeakerNoticeKind::HeadStartNoRemedy),
                        minutes: None,
                        restart_helps: false,
                    },
                );
            }
            return self.active;
        }
        if self.active.is_some_and(|a| a.kind.is_head_start()) {
            return self.active;
        }

        // Running low, which a drift notice gives way to.
        let floor = input.head_start.map(|h| low_floor_ms(h.sent_ms));
        let low = floor.is_some_and(|f| running_low(input, f));
        if self
            .active
            .is_some_and(|a| a.kind == SpeakerNoticeKind::RunningLow)
        {
            let clear = input.head_start.map_or(0.0, |h| low_clear_ms(h.sent_ms));
            let above = input.locked && input.acked.is_some_and(|a| a.p10_ms > clear);
            if !above {
                self.above_clear_since = None;
                return self.active;
            }
            let since = *self.above_clear_since.get_or_insert(now);
            if now.saturating_duration_since(since) < RUNNING_LOW_CLEAR_AFTER {
                return self.active;
            }
            self.active = None;
            self.above_clear_since = None;
        } else if low && self.may_raise(now, SpeakerNoticeKind::RunningLow) {
            self.above_clear_since = None;
            self.raise(
                now,
                SpeakerNotice {
                    kind: SpeakerNoticeKind::RunningLow,
                    notice_id: 0,
                    stall_ms: None,
                    left_ms: input.acked.map(|a| a.p10_ms.round() as i32),
                    head_start_ms: input.head_start.map(|h| h.sent_ms),
                    suggested_head_start_ms: None,
                    minutes: None,
                    restart_helps,
                },
            );
            return self.active;
        }

        // A drift nothing is correcting.
        let draining =
            !input.drift_active && input.time_to_floor_s.is_some_and(|s| s < DRIFT_NOTICE_SECS);
        if self
            .active
            .is_some_and(|a| a.kind == SpeakerNoticeKind::DriftUncorrected)
        {
            let recovered = input.drift_active
                || input
                    .time_to_floor_s
                    .is_some_and(|s| s > DRIFT_NOTICE_CLEAR_SECS)
                // Locked and no longer measurably draining.
                || (input.locked && input.time_to_floor_s.is_none());
            if recovered {
                self.active = None;
            }
        } else if draining && self.may_raise(now, SpeakerNoticeKind::DriftUncorrected) {
            let secs = input.time_to_floor_s.unwrap_or(0.0);
            self.raise(
                now,
                SpeakerNotice {
                    kind: SpeakerNoticeKind::DriftUncorrected,
                    notice_id: 0,
                    stall_ms: None,
                    left_ms: None,
                    head_start_ms: input.head_start.map(|h| h.sent_ms),
                    suggested_head_start_ms: None,
                    minutes: Some(((secs / 60.0).ceil() as u32).max(1)),
                    restart_helps,
                },
            );
        }
        self.active
    }

    /// Whether a new episode of `kind` may start at `now`.
    fn may_raise(&self, now: Instant, kind: SpeakerNoticeKind) -> bool {
        self.raised_at[kind.index()].map_or(true, |at| {
            now.saturating_duration_since(at) >= NOTICE_EPISODE_INTERVAL
        })
    }

    /// Makes `notice` the standing one under a new id.
    fn raise(&mut self, now: Instant, mut notice: SpeakerNotice) {
        self.last_id += 1;
        notice.notice_id = self.last_id;
        self.raised_at[notice.kind.index()] = Some(now);
        self.active = Some(notice);
    }
}

#[cfg(test)]
mod tests {
    use super::super::segment::SegmentBreak;
    use super::*;

    fn full(ms: u32) -> Option<HeadStart> {
        Some(HeadStart {
            sent_ms: ms,
            configured_ms: ms,
        })
    }

    fn acked(min: f64, p10: f64, median: f64, stall: Option<f64>) -> Option<AckedReserve> {
        Some(AckedReserve {
            min_ms: min,
            p10_ms: p10,
            median_ms: median,
            measured: true,
            stall_ms: stall,
        })
    }

    /// A locked report at the 500 ms default with the given acknowledged
    /// reserve and stall.
    fn report(min: f64, p10: f64, median: f64, stall: Option<f64>) -> NoticeInput {
        NoticeInput {
            locked: true,
            acked: acked(min, p10, median, stall),
            head_start: full(500),
            stall_ms: stall,
            ..NoticeInput::default()
        }
    }

    fn healthy() -> NoticeInput {
        report(430.0, 470.0, 480.0, Some(40.0))
    }

    #[test]
    fn a_healthy_speaker_gets_no_notice() {
        let mut state = NoticeState::new();
        assert_eq!(state.update(Instant::now(), &healthy()), None);
    }

    #[test]
    fn underrun_from_negative_acked_min() {
        // The field's -21 ms at the default head start: a stall of about
        // 521 ms. 750 - 150 = 600 covers it.
        let mut state = NoticeState::new();
        let n = state
            .update(Instant::now(), &report(-21.0, 380.0, 470.0, Some(480.0)))
            .expect("ran out");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartRanOut);
        assert_eq!(n.stall_ms, Some(521));
        assert_eq!(n.left_ms, Some(-21));
        assert_eq!(n.head_start_ms, Some(500));
        assert_eq!(n.suggested_head_start_ms, Some(750));
        assert!(!n.restart_helps);
        assert_eq!(n.notice_id, 1);
    }

    #[test]
    fn head_start_close_suggests_room_to_spare() {
        // 40 ms left of 500 (under half the 150 ms floor) after a 460 ms
        // stall: 750 leaves 600 above its floor, which covers it.
        let mut state = NoticeState::new();
        let n = state
            .update(Instant::now(), &report(40.0, 300.0, 470.0, Some(420.0)))
            .expect("close");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartClose);
        assert_eq!(n.left_ms, Some(40));
        assert_eq!(n.stall_ms, Some(460));
        assert_eq!(n.suggested_head_start_ms, Some(750));
    }

    #[test]
    fn a_low_minimum_without_a_stall_is_not_the_head_start() {
        let mut state = NoticeState::new();
        assert_eq!(
            state.update(Instant::now(), &report(40.0, 300.0, 470.0, Some(60.0))),
            None
        );
    }

    #[test]
    fn head_start_no_remedy_past_the_longest_step() {
        let mut state = NoticeState::new();
        let mut input = report(-1_900.0, 300.0, 470.0, Some(2_300.0));
        let n = state.update(Instant::now(), &input).expect("no remedy");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartNoRemedy);
        assert_eq!(n.suggested_head_start_ms, None);

        // Already at the longest head start, any underrun is past remedy.
        let mut state = NoticeState::new();
        input.head_start = full(2_000);
        input.acked = acked(-10.0, 1_500.0, 1_900.0, Some(1_900.0));
        input.stall_ms = Some(1_900.0);
        let n = state.update(Instant::now(), &input).expect("no remedy");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartNoRemedy);
    }

    #[test]
    fn suggestion_never_exceeds_2000() {
        for needed in (0..3_000).step_by(10) {
            for current in [0, 250, 500, 750, 1_000, 1_500, 2_000] {
                if let Some(s) = suggest_head_start_ms(f64::from(needed), current) {
                    assert!(s <= 2_000, "{s} for {needed} from {current}");
                    assert!(s > current, "{s} is not more than {current}");
                    assert!(HEAD_START_LADDER_MS.contains(&s));
                }
            }
        }
        assert_eq!(suggest_head_start_ms(1_850.0, 1_500), Some(2_000));
        assert_eq!(suggest_head_start_ms(1_851.0, 1_500), None);
        assert_eq!(
            HEAD_START_LADDER_MS.last().map(|&s| u64::from(s)),
            Some(crate::protocol_constants::MAX_PCM_CONNECT_BURST_MS)
        );
    }

    #[test]
    fn underrun_from_step_either_direction_uses_stall() {
        // The estimate broke on a step, so there is no acknowledged reserve
        // this window; the stall before the break says what caused it.
        let pre_break = |stall| PreBreak {
            reason: SegmentBreak::OffsetStep,
            acked: AckedReserve {
                min_ms: 200.0,
                p10_ms: 400.0,
                median_ms: 470.0,
                measured: true,
                stall_ms: Some(stall),
            },
            locked: true,
        };
        let input = NoticeInput {
            locked: false,
            acked: None,
            offset_step: true,
            pre_break: Some(pre_break(600.0)),
            head_start: full(500),
            stall_ms: Some(120.0),
            ..NoticeInput::default()
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("ran out");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartRanOut);
        assert_eq!(n.stall_ms, Some(600));
        // 750 less its 150 ms floor leaves 600, which covers it.
        assert_eq!(n.suggested_head_start_ms, Some(750));
        assert_eq!(n.left_ms, None);

        // A step with nothing held back is a skip, not the head start.
        let quiet = NoticeInput {
            pre_break: Some(pre_break(30.0)),
            stall_ms: Some(20.0),
            ..input
        };
        assert_eq!(NoticeState::new().update(Instant::now(), &quiet), None);
    }

    #[test]
    fn h0_ran_out_needs_stall() {
        let off = NoticeInput {
            locked: true,
            // Out for a moment, but not holding less than the 40 ms floor
            // most of the time.
            acked: acked(-15.0, 45.0, 60.0, None),
            head_start: full(0),
            stall_ms: None,
            link_poor: true,
            ..NoticeInput::default()
        };
        // With the head start off a poor link alone is no cause: there was
        // no head start for it to eat.
        assert_eq!(NoticeState::new().update(Instant::now(), &off), None);
        let stalled = NoticeInput {
            stall_ms: Some(90.0),
            ..off
        };
        let n = NoticeState::new()
            .update(Instant::now(), &stalled)
            .expect("ran out");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartRanOut);
        assert_eq!(n.head_start_ms, Some(0));
        // 15 ms held back beyond the start: 250 leaves 175 above its floor.
        assert_eq!(n.suggested_head_start_ms, Some(250));
    }

    #[test]
    fn no_head_start_notice_for_compressed() {
        let input = NoticeInput {
            head_start: None,
            ..report(-50.0, 10.0, 20.0, Some(500.0))
        };
        assert_eq!(NoticeState::new().update(Instant::now(), &input), None);
    }

    #[test]
    fn no_notice_for_link_trouble_the_head_start_covered() {
        // A poor link and a 90 ms stall that left 380 ms in hand.
        let input = NoticeInput {
            link_poor: true,
            ..report(380.0, 430.0, 470.0, Some(90.0))
        };
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        for i in 0..20 {
            assert_eq!(state.update(t0 + Duration::from_secs(30 * i), &input), None);
        }
    }

    #[test]
    fn running_low_fires_on_the_reserve_not_a_dip() {
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        // The 10th percentile under the floor from a stall's dip alone.
        assert_eq!(
            state.update(t0, &report(100.0, 140.0, 400.0, Some(60.0))),
            None
        );
        // The reserve itself under the floor.
        let n = state
            .update(t0, &report(90.0, 120.0, 140.0, Some(20.0)))
            .expect("running low");
        assert_eq!(n.kind, SpeakerNoticeKind::RunningLow);
        assert_eq!(n.left_ms, Some(120));
        assert!(n.restart_helps);
    }

    #[test]
    fn running_low_fires_even_with_drift_on() {
        let input = NoticeInput {
            drift_active: true,
            ..report(90.0, 120.0, 140.0, Some(20.0))
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("running low");
        assert_eq!(n.kind, SpeakerNoticeKind::RunningLow);
    }

    #[test]
    fn running_low_clears_after_a_minute_above_the_clear_level() {
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        let low = report(90.0, 120.0, 140.0, Some(20.0));
        let id = state.update(t0, &low).expect("low").notice_id;
        // Above the floor but under the 250 ms clear level: still low.
        let t = |s| t0 + Duration::from_secs(s);
        assert!(state
            .update(t(30), &report(170.0, 200.0, 220.0, None))
            .is_some());
        // Above the clear level, but not yet for a minute.
        assert!(state.update(t(60), &healthy()).is_some());
        assert!(state.update(t(90), &healthy()).is_some());
        assert_eq!(state.update(t(120), &healthy()), None);
        // Low again within ten minutes of the last episode: not raised.
        assert_eq!(state.update(t(150), &low), None);
        // Ten minutes after it was raised, a new episode, under a new id.
        let again = state.update(t(600), &low).expect("new episode");
        assert!(again.notice_id > id);
    }

    #[test]
    fn drift_uncorrected_until_the_projection_recovers() {
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        let draining = NoticeInput {
            time_to_floor_s: Some(20.0 * 60.0 + 1.0),
            ..healthy()
        };
        let n = state.update(t0, &draining).expect("drift");
        assert_eq!(n.kind, SpeakerNoticeKind::DriftUncorrected);
        assert_eq!(n.minutes, Some(21));
        assert!(n.restart_helps);
        // Past thirty minutes but not yet forty-five: it stands.
        let easing = NoticeInput {
            time_to_floor_s: Some(40.0 * 60.0),
            ..healthy()
        };
        assert_eq!(state.update(t0 + Duration::from_secs(30), &easing), Some(n));
        let recovered = NoticeInput {
            time_to_floor_s: Some(50.0 * 60.0),
            ..healthy()
        };
        assert_eq!(state.update(t0 + Duration::from_secs(60), &recovered), None);
        // Correction running: nothing to tell.
        let corrected = NoticeInput {
            drift_active: true,
            ..draining
        };
        assert_eq!(NoticeState::new().update(t0, &corrected), None);
    }

    #[test]
    fn restart_helps_false_on_partial_burst() {
        let partial = Some(HeadStart {
            sent_ms: 300,
            configured_ms: 500,
        });
        let low = NoticeInput {
            head_start: partial,
            ..report(60.0, 80.0, 85.0, Some(20.0))
        };
        let n = NoticeState::new()
            .update(Instant::now(), &low)
            .expect("running low");
        assert_eq!(n.kind, SpeakerNoticeKind::RunningLow);
        assert!(!n.restart_helps);
        let drift = NoticeInput {
            head_start: partial,
            time_to_floor_s: Some(600.0),
            ..healthy()
        };
        let n = NoticeState::new()
            .update(Instant::now(), &drift)
            .expect("drift");
        assert!(!n.restart_helps);
    }

    #[test]
    fn same_episode_repeats_same_id() {
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        let first = state
            .update(t0, &report(40.0, 300.0, 470.0, Some(420.0)))
            .expect("close");
        // Healthy reports, the same stall again, a running-low report and a
        // drift: the head-start notice stands for the rest of the cast.
        for (i, input) in [
            healthy(),
            report(40.0, 300.0, 470.0, Some(420.0)),
            report(90.0, 120.0, 140.0, Some(20.0)),
            NoticeInput {
                time_to_floor_s: Some(60.0),
                ..healthy()
            },
        ]
        .iter()
        .enumerate()
        {
            let at = t0 + Duration::from_secs(30 * (i as u64 + 1));
            assert_eq!(state.update(at, input), Some(first));
        }
    }

    #[test]
    fn escalation_bumps_notice_id() {
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        let close = state
            .update(t0, &report(40.0, 300.0, 470.0, Some(420.0)))
            .expect("close");
        let ran_out = state
            .update(
                t0 + Duration::from_secs(30),
                &report(-21.0, 300.0, 470.0, Some(480.0)),
            )
            .expect("ran out");
        assert_eq!(ran_out.kind, SpeakerNoticeKind::HeadStartRanOut);
        assert!(ran_out.notice_id > close.notice_id);
        // A bigger stall asks for a bigger step: a new id, still ran out.
        let bigger = state
            .update(
                t0 + Duration::from_secs(60),
                &report(-300.0, 300.0, 470.0, Some(700.0)),
            )
            .expect("escalated");
        assert_eq!(bigger.kind, SpeakerNoticeKind::HeadStartRanOut);
        assert_eq!(bigger.suggested_head_start_ms, Some(1_000));
        assert!(bigger.notice_id > ran_out.notice_id);
        // A close call after that is no escalation: the notice stands.
        assert_eq!(
            state.update(
                t0 + Duration::from_secs(90),
                &report(40.0, 300.0, 470.0, Some(420.0))
            ),
            Some(bigger)
        );
    }

    #[test]
    fn a_head_start_notice_replaces_running_low_at_once() {
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        let low = state
            .update(t0, &report(90.0, 120.0, 140.0, Some(20.0)))
            .expect("low");
        let ran_out = state
            .update(
                t0 + Duration::from_secs(30),
                &report(-21.0, 300.0, 470.0, Some(480.0)),
            )
            .expect("ran out");
        assert_eq!(ran_out.kind, SpeakerNoticeKind::HeadStartRanOut);
        assert!(ran_out.notice_id > low.notice_id);
    }

    #[test]
    fn notice_wire_shape() {
        let notice = SpeakerNotice {
            kind: SpeakerNoticeKind::HeadStartRanOut,
            notice_id: 3,
            stall_ms: Some(521),
            left_ms: Some(-21),
            head_start_ms: Some(500),
            suggested_head_start_ms: Some(750),
            minutes: None,
            restart_helps: false,
        };
        assert_eq!(
            serde_json::to_value(notice).unwrap(),
            serde_json::json!({
                "kind": "head_start_ran_out",
                "noticeId": 3,
                "stallMs": 521,
                "leftMs": -21,
                "headStartMs": 500,
                "suggestedHeadStartMs": 750,
                "restartHelps": false,
            })
        );
        let wire = |k: SpeakerNoticeKind| serde_json::to_string(&k).unwrap();
        for kind in [
            SpeakerNoticeKind::HeadStartRanOut,
            SpeakerNoticeKind::HeadStartClose,
            SpeakerNoticeKind::HeadStartNoRemedy,
            SpeakerNoticeKind::RunningLow,
            SpeakerNoticeKind::DriftUncorrected,
        ] {
            assert_eq!(wire(kind), format!("\"{}\"", kind.as_str()));
        }
    }
}
