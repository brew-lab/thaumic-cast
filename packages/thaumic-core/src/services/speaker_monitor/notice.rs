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
//! Nor is the end of the item. A speaker takes a PCM connection to end at the
//! length its WAV header declares: it reads to about there, plays out and
//! hangs up, and whatever its acknowledgements and reserve do on the way is
//! the item ending, not the link. The monitor does not hand a report window
//! that came near a
//! connection's declared end to [`NoticeState::update`] at all (see
//! [`crate::stream::DeclaredEnd`]), so whatever stood before it stands.
//!
//! The kinds, most urgent first:
//!
//! - **Head start ran out** ([`SpeakerNoticeKind::HeadStartRanOut`]): the
//!   speaker underran (its acknowledged reserve went below zero, or its
//!   reserve stepped as an underrun makes it), and a Wi-Fi stall or a poor
//!   link caused it. Suggests the smallest step of
//!   [`HEAD_START_LADDER_MS`] that would have covered it. A speaker whose
//!   clock had drained most of what its reserve lost before the stall came,
//!   low yet or not, is not one: unless the stall measured would have beaten
//!   a full reserve too, it is running low, for the clock, and a head-start
//!   notice it does get reports that stall, not what the clock took.
//! - **Head start close** ([`SpeakerNoticeKind::HeadStartClose`]): a stall
//!   left less than half the floor in hand, without an underrun, and a
//!   longer step would have left room to spare.
//! - **No remedy** ([`SpeakerNoticeKind::HeadStartNoRemedy`]): the head
//!   start ran out, but even the longest would not have covered it.
//! - **Running low** ([`SpeakerNoticeKind::RunningLow`]): the reserve
//!   itself, not a stall's dip, is below the floor. When the speaker's clock
//!   is measurably draining it, has drained a real share of what the reserve
//!   lost, and no stall explains the loss, the notice carries
//!   [`SpeakerNoticeCause::Drift`], so a client can keep saying why and what
//!   fixes it after the drift notice gives way. A poor link does not take
//!   the cause away.
//! - **Drift uncorrected** ([`SpeakerNoticeKind::DriftUncorrected`]): the
//!   speaker plays faster than audio arrives and will reach the floor
//!   within half an hour, with nothing correcting it.
//! - **Drift saturated** ([`SpeakerNoticeKind::DriftSaturated`]): drift
//!   correction is running on the connection but has been pinned at its cap
//!   for five minutes, and what it cannot make up will still reach the floor
//!   within half an hour.
//!
//! Head-start kinds exist only for PCM connections, whose head start is
//! known, and stand for the rest of the cast once raised, until a
//! reconnection gets a longer head start than the one they were about. A
//! compressed connection is judged for running low as if its head start
//! were off. Each episode gets a `notice_id` that stays the same while it
//! is repeated, so a client can dismiss it once; the id changes only on a
//! new episode or an escalation (close to ran out, or a larger suggestion),
//! which a client shows again.

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

/// Least net drain rate, in ppm, that can name the clock as why a speaker
/// runs low. A tightly measured clock passes the drain test at a few ppm,
/// which over an hour drains a few ms: real, but no reason to point the
/// user at drift correction.
pub const MIN_DRIFT_CAUSE_PPM: f64 = 5.0;

/// Share of what a running-low reserve lost that the clock must have
/// drained over the connection for the notice to name it. Half, not all:
/// the drained figure is on the shrunk rate, which runs a little under the
/// true one.
pub const DRIFT_CAUSE_SHARE: f64 = 0.5;

/// Most a connection may settle below its head start and still have the
/// loss judged from where it settled. Settling is normally a few tens of ms
/// under the head start; a speaker that settled lower than this lost the
/// rest to something other than its clock, and is judged from the head
/// start less this.
pub const SETTLE_ALLOWANCE_MS: f64 = 100.0;

/// What a notice is about. Wire strings are part of the client protocol:
/// never rename a variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeakerNoticeKind {
    /// A stall outlasted the speaker head start and the speaker cut out.
    HeadStartRanOut,
    /// A stall nearly outlasted the speaker head start.
    HeadStartClose,
    /// A cut-out that the longest head start would not have covered either.
    HeadStartNoRemedy,
    /// The reserve itself is below the floor.
    RunningLow,
    /// The speaker's clock is draining the reserve and nothing corrects it.
    DriftUncorrected,
    /// Drift correction is running but cannot keep up with the speaker's
    /// clock.
    DriftSaturated,
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
            Self::DriftSaturated => "drift_saturated",
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
            Self::DriftUncorrected | Self::DriftSaturated => 1,
        }
    }

    fn index(self) -> usize {
        match self {
            Self::HeadStartRanOut => 0,
            Self::HeadStartClose => 1,
            Self::HeadStartNoRemedy => 2,
            Self::RunningLow => 3,
            Self::DriftUncorrected => 4,
            Self::DriftSaturated => 5,
        }
    }
}

impl std::fmt::Display for SpeakerNoticeKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Why a notice's speaker is in trouble, where the kind alone does not say.
/// Wire strings are part of the client protocol: never rename a variant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SpeakerNoticeCause {
    /// The speaker's clock runs faster than the audio arrives, net of any
    /// drift correction, and that, not a stall, drained the reserve.
    Drift,
}

impl SpeakerNoticeCause {
    /// The cause as a log token (its wire string).
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Drift => "drift",
        }
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
    /// when its connection got the whole configured head start, and that is
    /// not off, since a restart gives a partial one the same partial burst
    /// again and one that is off nothing.
    pub restart_helps: bool,
    /// Why the speaker is in trouble, when the core can tell and the kind
    /// does not say (running low: [`SpeakerNoticeCause::Drift`] when the
    /// clock drained it). Absent otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cause: Option<SpeakerNoticeCause>,
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
    /// compressed connection, which gets no head-start notices and is judged
    /// for running low against the floor of a head start that is off.
    pub head_start: Option<HeadStart>,
    /// How far the worst acknowledgement lag of this window stood above its
    /// median, in ms.
    pub stall_ms: Option<f64>,
    /// Whether the link to the speaker was judged poor.
    pub link_poor: bool,
    /// Seconds until the reserve reaches the floor at the net drain rate,
    /// when it is measurably draining.
    pub time_to_floor_s: Option<f64>,
    /// The net rate the speaker drains its reserve at, in ppm: its clock
    /// shrunk by its uncertainty, less the correction in force (see
    /// [`super::ReserveTracker::net_drain_ppm`]).
    pub net_drift_ppm: f64,
    /// How much of the reserve the clock drained over the connection at
    /// that rate, in ms (see [`super::ReserveTracker::clock_drained_ms`]).
    pub clock_drained_ms: f64,
    /// The level the connection settled at once its head start had gone
    /// out, once learned (see [`super::ReserveTracker::target_ms`]).
    pub target_ms: Option<f64>,
    /// Whether clock drift correction is running on this connection: made
    /// with correction on, with its adapter engaged and following the
    /// command (see [`super::control::drift_active`]). A drift notice is
    /// then about what correction cannot make up, not about turning it on.
    pub drift_active: bool,
    /// Whether the correction command has been pinned at its cap for five
    /// minutes (see [`super::control::DriftController::saturated`]).
    pub saturated: bool,
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
/// no step does. Pass the larger of the head start sent and the one
/// configured, so a partial burst never draws a suggestion below the setting
/// the user already has.
pub fn suggest_head_start_ms(needed_ms: f64, current_ms: u32) -> Option<u32> {
    HEAD_START_LADDER_MS
        .iter()
        .copied()
        .find(|&s| s > current_ms && f64::from(s) - low_floor_ms(s) >= needed_ms)
}

/// The head-start notice this report calls for, if any.
///
/// A speaker whose clock had drained most of what its reserve lost before a
/// stall came (see [`clock_took_reserve`]) is judged on the stall alone,
/// however low the clock had left it: the head start covered everything but
/// the clock, so a head-start notice stands only when the measured stall
/// would have beaten a full reserve too (see [`beats_a_full_reserve`]), and
/// then reports that stall, never what the clock took. Otherwise nothing
/// here: if the speaker underran, running low with the clock as its cause
/// says what happened and what fixes it (see [`clock_underran`]). A poor
/// link never makes such a speaker a head-start notice.
fn find_head_start(input: &NoticeInput) -> Option<HeadStartFinding> {
    let h = input.head_start?;
    let head_start = f64::from(h.sent_ms);
    let floor = low_floor_ms(h.sent_ms);
    let by_clock = clock_took_reserve(input);
    // Whether a stall of at least `share` (never less than the minimum)
    // was measured, or, with a head start to lose, the link was poor.
    let caused = |stall: Option<f64>, share: f64| {
        if by_clock {
            return stall.is_some_and(|s| beats_a_full_reserve(s, h.sent_ms));
        }
        stall.is_some_and(|s| s >= share.max(MIN_NOTICE_STALL_MS))
            || (h.sent_ms > 0 && input.link_poor)
    };
    let acked_min = input.acked.filter(|_| input.locked).map(|a| a.min_ms);
    // What a stall held back: what the head start lost to reach `min`, or
    // the measured stall where that is larger. With the head start off the
    // arithmetic figure is only the depth below zero (or nothing at all),
    // while the stall says how long the speaker went without audio. With the
    // clock behind most of the loss, only the measured stall: the rest went
    // over hours, not in this window.
    let measured = input.stall_ms.unwrap_or(0.0);
    let held_back = |min: f64| {
        if by_clock {
            measured
        } else {
            (head_start - min).max(measured)
        }
    };

    let (kind, stall, left) = match acked_min {
        Some(min) if min < 0.0 => {
            if !caused(input.stall_ms, 0.5 * head_start) {
                return None;
            }
            // It had the head start, and the stall took all of it and more.
            (
                SpeakerNoticeKind::HeadStartRanOut,
                held_back(min),
                Some(min),
            )
        }
        _ if input.offset_step => {
            // The reserve stepped: judged on the stall, the window's or the
            // one before the break, whichever was worse.
            let stall = step_stall_ms(input);
            if !caused(stall, 0.5 * head_start) {
                return None;
            }
            // A speaker that underran lost at least its whole head start,
            // whatever stall was measured (a poor link alone can cause it),
            // unless the clock had taken most of it first.
            let stall = stall.unwrap_or(0.0);
            (
                SpeakerNoticeKind::HeadStartRanOut,
                if by_clock {
                    stall
                } else {
                    stall.max(head_start)
                },
                None,
            )
        }
        Some(min) if min < floor / 2.0 => {
            // Only a stall that took a good part of what it had: a speaker
            // that settled this low has nothing to do with the head start.
            if !input
                .stall_ms
                .is_some_and(|s| s >= (0.5 * (head_start - min)).max(MIN_NOTICE_STALL_MS))
                || (by_clock && !caused(input.stall_ms, 0.0))
            {
                return None;
            }
            (SpeakerNoticeKind::HeadStartClose, held_back(min), Some(min))
        }
        _ => return None,
    };
    let suggested = suggest_head_start_ms(stall, h.sent_ms.max(h.configured_ms));
    let kind = match (kind, suggested) {
        (_, Some(_)) => kind,
        // A close call no step would have eased: the speaker did not cut
        // out, and the no-remedy wording says the stall beat the head start.
        // If it does cut out, ran out (as no remedy) follows.
        (SpeakerNoticeKind::HeadStartClose, None) => return None,
        (_, None) => SpeakerNoticeKind::HeadStartNoRemedy,
    };
    Some(HeadStartFinding {
        kind,
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

/// Whether the speaker's clock drained a real share of what the reserve
/// lost over the connection. All of:
///
/// - the speaker drains the reserve measurably, net of any correction (the
///   projection the drift notices use is there at all), at no less than
///   [`MIN_DRIFT_CAUSE_PPM`];
/// - the clock drained at least [`DRIFT_CAUSE_SHARE`] of what the reserve
///   lost over the connection, down to this window's 10th percentile, judged
///   from where it settled (never more than [`SETTLE_ALLOWANCE_MS`] under the
///   head start), so a small drift under a loss from something else is not
///   named.
///
/// The state of the link does not enter into it: a lossy link costs the
/// reserve stalls, which come back, while the clock's drain does not, and a
/// speaker on a poor link drifts like any other.
fn clock_explains_loss(input: &NoticeInput) -> bool {
    if input.time_to_floor_s.is_none() || input.net_drift_ppm < MIN_DRIFT_CAUSE_PPM {
        return false;
    }
    let Some(p10) = input.acked.map(|a| a.p10_ms) else {
        return false;
    };
    input.clock_drained_ms >= DRIFT_CAUSE_SHARE * reserve_lost_ms(input, p10)
}

/// What the reserve lost over the connection to reach `level`, in ms: from
/// where it settled, never more than [`SETTLE_ALLOWANCE_MS`] under the head
/// start (the head start itself before it has settled).
fn reserve_lost_ms(input: &NoticeInput, level: f64) -> f64 {
    let head_start = f64::from(input.head_start.map_or(0, |h| h.sent_ms));
    let settled = input.target_ms.map_or(head_start, |t| {
        t.clamp(head_start - SETTLE_ALLOWANCE_MS, head_start)
    });
    (settled - level).max(0.0)
}

/// The stall an offset step is judged on: this window's or the one before
/// the break, whichever was worse.
fn step_stall_ms(input: &NoticeInput) -> Option<f64> {
    match (
        input.stall_ms,
        input.pre_break.and_then(|p| p.acked.stall_ms),
    ) {
        (Some(a), Some(b)) => Some(a.max(b)),
        (a, b) => a.or(b),
    }
}

/// Whether the speaker's clock, not the stall this report measured, took
/// most of what the reserve had lost before that stall came: the speaker
/// drains the reserve at no less than [`MIN_DRIFT_CAUSE_PPM`] net of any
/// correction, and the clock drained at least [`DRIFT_CAUSE_SHARE`] of what
/// the reserve lost over the connection (see [`reserve_lost_ms`]) down to
/// the level the stall found it at. The reserve need not be running low
/// yet: a clock that drained 510 ms to 200 ms explains an underrun that a
/// 210 ms stall then caused as surely as one it drained to 83 ms.
///
/// The level the stall found it at is a median, never a 10th percentile or
/// minimum the stall itself pulled down:
///
/// - with a locked estimate this window, its acknowledged median, and the
///   drain measurable (the projection the drift notices use is there);
/// - on an offset step, which leaves no estimate this window, the locked
///   window before the break, and only when that was already running low
///   (its 10th percentile and median under the floor): a step is not always
///   an underrun, and only a reserve the clock had drained that low makes
///   one of a small stall. Right after a break the projection is not back
///   yet, so only the rate and the drain are asked for.
///
/// The rate is net of correction: with correction running and keeping up,
/// what the clock drained earlier no longer counts, and the loss is judged
/// as a stall's. Drift mode is fixed per connection, so turning it on takes
/// a restart, which refills the reserve anyway. The drain and the settled
/// level are per connection, so on a cast made of declared-length segments
/// each segment only sees its own drain, and this rarely holds there.
///
/// The state of the link does not enter into it.
fn clock_took_reserve(input: &NoticeInput) -> bool {
    if input.net_drift_ppm < MIN_DRIFT_CAUSE_PPM {
        return false;
    }
    let level = match (input.locked, input.acked) {
        (true, Some(a)) => {
            if input.time_to_floor_s.is_none() {
                return false;
            }
            a.median_ms
        }
        _ if input.offset_step => {
            let floor = low_floor_ms(input.head_start.map_or(0, |h| h.sent_ms));
            match input.pre_break.filter(|p| p.locked) {
                Some(p) if p.acked.p10_ms < floor && p.acked.median_ms < floor => p.acked.median_ms,
                _ => return false,
            }
        }
        _ => return false,
    };
    input.clock_drained_ms >= DRIFT_CAUSE_SHARE * reserve_lost_ms(input, level)
}

/// Whether the speaker underran on a reserve its clock had drained (see
/// [`clock_took_reserve`]) to a stall a full reserve would have covered (see
/// [`beats_a_full_reserve`]): its locked acknowledged reserve went below
/// zero this window, or its reserve stepped. No head-start notice follows,
/// since a longer head start is not the fix; running low, with the clock as
/// its cause, is the notice, whatever the reserve's level, since the speaker
/// cut out and a restart or drift correction is what refills it.
fn clock_underran(input: &NoticeInput) -> bool {
    let Some(h) = input.head_start else {
        return false;
    };
    let stall = match input.acked.filter(|_| input.locked) {
        Some(a) if a.min_ms < 0.0 => input.stall_ms,
        Some(_) => return false,
        None if input.offset_step => step_stall_ms(input),
        None => return false,
    };
    clock_took_reserve(input) && !stall.is_some_and(|s| beats_a_full_reserve(s, h.sent_ms))
}

/// Whether a stall of `stall_ms` would have run a speaker out even from a
/// full reserve at `head_start_ms`: it is more than the head start less its
/// floor, the same measure [`suggest_head_start_ms`] covers a stall by.
fn beats_a_full_reserve(stall_ms: f64, head_start_ms: u32) -> bool {
    stall_ms >= MIN_NOTICE_STALL_MS
        && stall_ms > f64::from(head_start_ms) - low_floor_ms(head_start_ms)
}

/// Why a running-low speaker is low, when it is the clock: the clock
/// explains the loss (see [`clock_explains_loss`]), and this window's stall
/// is less than half of that loss, so the stall does not explain it.
///
/// Correction running or not, the clock is then the cause; whether turning
/// correction on is the fix is for the client, which knows the mode. A poor
/// link does not veto it: on a speaker whose link is always lossy it would
/// hide the one reason a restart or drift correction fixes.
fn running_low_cause(input: &NoticeInput) -> Option<SpeakerNoticeCause> {
    if !clock_explains_loss(input) {
        return None;
    }
    let p10 = input.acked?.p10_ms;
    let lost = reserve_lost_ms(input, p10);
    let stalled = input
        .stall_ms
        .is_some_and(|s| s >= (0.5 * lost).max(MIN_NOTICE_STALL_MS));
    (!stalled).then_some(SpeakerNoticeCause::Drift)
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
    raised_at: [Option<Instant>; 6],
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
        // With the head start off a restart refills nothing.
        let restart_helps = input
            .head_start
            .is_some_and(|h| h.is_full() && h.sent_ms > 0);

        // A reconnection that got a longer head start than the standing
        // notice was about has taken its advice: the old suggestion no
        // longer applies.
        if let (Some(a), Some(h)) = (self.active, input.head_start) {
            if a.kind.is_head_start() && a.head_start_ms.is_some_and(|old| h.sent_ms > old) {
                self.active = None;
            }
        }

        // Head-start kinds stand for the rest of the cast (unless a longer
        // head start replaces them), and replace anything less urgent at
        // once.
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
                        cause: None,
                    },
                );
            }
            return self.active;
        }
        if self.active.is_some_and(|a| a.kind.is_head_start()) {
            return self.active;
        }

        // Running low, which a drift notice gives way to. A compressed
        // connection has no head start, so it is judged as one with the head
        // start off.
        let sent_ms = input.head_start.map_or(0, |h| h.sent_ms);
        // A speaker its clock drained that a stall then ran out is running
        // low for the clock, whatever its reserve's level.
        let clock_underran = clock_underran(input);
        let low = clock_underran || running_low(input, low_floor_ms(sent_ms));
        let cause = || {
            if clock_underran {
                Some(SpeakerNoticeCause::Drift)
            } else {
                running_low_cause(input)
            }
        };
        if self
            .active
            .is_some_and(|a| a.kind == SpeakerNoticeKind::RunningLow)
        {
            let clear = low_clear_ms(sent_ms);
            let above =
                !clock_underran && input.locked && input.acked.is_some_and(|a| a.p10_ms > clear);
            if !above {
                self.above_clear_since = None;
                // A clock that became measurable after the notice was raised
                // names its cause in place, under the same id: the words
                // gain a reason, the episode is the same. Once named, the
                // cause stands for the episode rather than flicker with each
                // report's projection.
                if let Some(a) = self.active.as_mut() {
                    if low && a.cause.is_none() {
                        a.cause = cause();
                    }
                }
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
                    left_ms: input
                        .acked
                        .or(input.pre_break.map(|p| p.acked))
                        .map(|a| a.p10_ms.round() as i32),
                    head_start_ms: input.head_start.map(|h| h.sent_ms),
                    suggested_head_start_ms: None,
                    minutes: None,
                    restart_helps,
                    cause: cause(),
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
                    cause: None,
                },
            );
            return self.active;
        }

        // A drift correction cannot make up. The time to the floor is on the
        // net rate, so it is what remains beyond the cap.
        let saturated = input.drift_active && input.saturated;
        if self
            .active
            .is_some_and(|a| a.kind == SpeakerNoticeKind::DriftSaturated)
        {
            if !saturated {
                self.active = None;
            }
        } else if saturated
            && input.time_to_floor_s.is_some_and(|s| s < DRIFT_NOTICE_SECS)
            && self.active.is_none()
            && self.may_raise(now, SpeakerNoticeKind::DriftSaturated)
        {
            let secs = input.time_to_floor_s.unwrap_or(0.0);
            self.raise(
                now,
                SpeakerNotice {
                    kind: SpeakerNoticeKind::DriftSaturated,
                    notice_id: 0,
                    stall_ms: None,
                    left_ms: None,
                    head_start_ms: input.head_start.map(|h| h.sent_ms),
                    suggested_head_start_ms: None,
                    minutes: Some(((secs / 60.0).ceil() as u32).max(1)),
                    restart_helps,
                    cause: None,
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
        // The stall, not just the 15 ms depth below zero, is what it lost:
        // 250 leaves 175 above its floor, which covers 90.
        assert_eq!(n.stall_ms, Some(90));
        assert_eq!(n.left_ms, Some(-15));
        assert_eq!(n.suggested_head_start_ms, Some(250));
    }

    #[test]
    fn h0_close_reports_the_measured_stall() {
        // Head start off, a 60 ms stall, and the reserve down to 5 ms: the
        // arithmetic figure (0 − 5) is below zero, the stall is not.
        let input = NoticeInput {
            locked: true,
            acked: acked(5.0, 45.0, 60.0, Some(60.0)),
            head_start: full(0),
            stall_ms: Some(60.0),
            ..NoticeInput::default()
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("close");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartClose);
        assert_eq!(n.stall_ms, Some(60));
        assert_eq!(n.head_start_ms, Some(0));
        assert_eq!(n.suggested_head_start_ms, Some(250));
    }

    #[test]
    fn step_from_a_poor_link_alone_reports_at_least_the_head_start() {
        // An underrun step with only a small stall measured, or none: the
        // poor link caused it, and the speaker lost at least its head start.
        for stall in [None, Some(5.0), Some(300.0)] {
            let input = NoticeInput {
                locked: false,
                offset_step: true,
                head_start: full(500),
                stall_ms: stall,
                link_poor: true,
                ..NoticeInput::default()
            };
            let n = NoticeState::new()
                .update(Instant::now(), &input)
                .expect("ran out");
            assert_eq!(n.kind, SpeakerNoticeKind::HeadStartRanOut);
            assert_eq!(n.stall_ms, Some(500), "stall {stall:?}");
            assert!(n.stall_ms >= n.head_start_ms);
            // 750 less its 150 ms floor leaves 600, which covers 500.
            assert_eq!(n.suggested_head_start_ms, Some(750));
        }
    }

    #[test]
    fn a_close_call_no_step_eases_is_no_notice() {
        // At the longest head start a close call has nothing to suggest, and
        // the speaker did not cut out.
        let input = NoticeInput {
            head_start: full(2_000),
            acked: acked(40.0, 1_500.0, 1_900.0, Some(1_900.0)),
            stall_ms: Some(1_900.0),
            ..report(0.0, 0.0, 0.0, None)
        };
        assert_eq!(NoticeState::new().update(Instant::now(), &input), None);
    }

    #[test]
    fn suggestion_is_above_the_configured_head_start_too() {
        // A partial burst of 400 out of 1000 configured: 750 would cover the
        // stall, but it is less than the user already has.
        let input = NoticeInput {
            head_start: Some(HeadStart {
                sent_ms: 400,
                configured_ms: 1_000,
            }),
            acked: acked(-100.0, 300.0, 380.0, Some(450.0)),
            stall_ms: Some(450.0),
            ..report(0.0, 0.0, 0.0, None)
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("ran out");
        assert_eq!(n.stall_ms, Some(500));
        assert_eq!(n.suggested_head_start_ms, Some(1_500));
    }

    #[test]
    fn a_longer_head_start_on_reconnection_clears_the_notice() {
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        let n = state
            .update(t0, &report(-21.0, 380.0, 470.0, Some(480.0)))
            .expect("ran out");
        assert_eq!(n.suggested_head_start_ms, Some(750));
        // The same head start again: it stands.
        assert_eq!(
            state.update(t0 + Duration::from_secs(30), &healthy()),
            Some(n)
        );
        // The speaker reconnected with the suggested 750: nothing to tell.
        let raised = NoticeInput {
            head_start: full(750),
            ..report(600.0, 680.0, 720.0, Some(40.0))
        };
        assert_eq!(state.update(t0 + Duration::from_secs(60), &raised), None);
    }

    #[test]
    fn compressed_gets_running_low_but_no_head_start_notice() {
        // A stall that would be ran out on PCM is no notice without a known
        // head start.
        let stalled = NoticeInput {
            head_start: None,
            ..report(-50.0, 300.0, 400.0, Some(500.0))
        };
        assert_eq!(NoticeState::new().update(Instant::now(), &stalled), None);
        // A reserve under the head-start-off floor is running low, with no
        // head start to name and no restart advice.
        let low = NoticeInput {
            head_start: None,
            ..report(-50.0, 10.0, 20.0, Some(500.0))
        };
        let n = NoticeState::new()
            .update(Instant::now(), &low)
            .expect("running low");
        assert_eq!(n.kind, SpeakerNoticeKind::RunningLow);
        assert_eq!(n.head_start_ms, None);
        assert!(!n.restart_helps);
    }

    #[test]
    fn restart_never_helps_with_the_head_start_off() {
        let low = NoticeInput {
            head_start: full(0),
            ..report(10.0, 20.0, 25.0, Some(10.0))
        };
        let n = NoticeState::new()
            .update(Instant::now(), &low)
            .expect("running low");
        assert_eq!(n.kind, SpeakerNoticeKind::RunningLow);
        assert!(!n.restart_helps);
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

    /// The field's clock: +19.6 ppm on a Playbar.
    const FIELD_PPM: f64 = 19.6;

    /// What `ppm` drains over `hours` of playing, in ms.
    fn drained_over(ppm: f64, hours: f64) -> f64 {
        ppm * 1e-6 * hours * 3_600_000.0
    }

    /// A running-low report like the field's: a Playbar five hours into a
    /// cast at +19.6 ppm (about 350 ms drained), settled at 470 ms of its
    /// 500 ms head start and now down to 130 ms with ordinary lag.
    fn drained(time_to_floor_s: Option<f64>, drift_active: bool) -> NoticeInput {
        NoticeInput {
            time_to_floor_s,
            drift_active,
            net_drift_ppm: FIELD_PPM,
            clock_drained_ms: drained_over(FIELD_PPM, 5.0),
            target_ms: Some(470.0),
            ..report(100.0, 130.0, 140.0, Some(40.0))
        }
    }

    #[test]
    fn running_low_names_the_clock_when_it_drained_the_reserve() {
        // Off or observe (not active) and on but pinned (active and still
        // draining net of the command): the clock is the cause either way.
        for drift_active in [false, true] {
            let n = NoticeState::new()
                .update(Instant::now(), &drained(Some(0.0), drift_active))
                .expect("running low");
            assert_eq!(n.kind, SpeakerNoticeKind::RunningLow);
            assert_eq!(n.cause, Some(SpeakerNoticeCause::Drift), "{drift_active}");
            assert_eq!(n.left_ms, Some(130));
            assert!(n.restart_helps);
        }
    }

    #[test]
    fn running_low_without_a_measurable_drain_has_no_cause() {
        // No projection: the clock is not measurably draining, or correction
        // matches it, whatever the mode.
        for drift_active in [false, true] {
            let n = NoticeState::new()
                .update(Instant::now(), &drained(None, drift_active))
                .expect("running low");
            assert_eq!(n.cause, None, "{drift_active}");
        }
    }

    #[test]
    fn running_low_from_a_stall_is_not_the_clock() {
        // Draining, but a stall of 250 ms is more than half the 340 ms the
        // reserve lost from where it settled: the stall explains it.
        let input = NoticeInput {
            stall_ms: Some(250.0),
            ..drained(Some(0.0), false)
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("running low");
        assert_eq!(n.kind, SpeakerNoticeKind::RunningLow);
        assert_eq!(n.cause, None);
        // A stall well under half of it does not.
        let input = NoticeInput {
            stall_ms: Some(150.0),
            ..drained(Some(0.0), false)
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("running low");
        assert_eq!(n.cause, Some(SpeakerNoticeCause::Drift));
    }

    #[test]
    fn a_small_drift_under_a_large_loss_is_not_the_cause() {
        // +2 ppm measured tightly after six hours drains about 43 ms of the
        // 340 ms the reserve lost from where it settled: something else did
        // it, and drift correction would not help.
        let input = NoticeInput {
            net_drift_ppm: 2.0,
            clock_drained_ms: drained_over(2.0, 6.0),
            ..drained(Some(0.0), false)
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("running low");
        assert_eq!(n.kind, SpeakerNoticeKind::RunningLow);
        assert_eq!(n.cause, None);
        // A rate above the floor that still drained too little of the loss
        // is not named either: 8 ppm over an hour is about 29 ms.
        let input = NoticeInput {
            net_drift_ppm: 8.0,
            clock_drained_ms: drained_over(8.0, 1.0),
            ..drained(Some(0.0), false)
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("running low");
        assert_eq!(n.cause, None);
    }

    #[test]
    fn running_low_after_an_earlier_stall_is_not_the_clock() {
        // A stall in an earlier window took the reserve down; this window's
        // lag is ordinary. The clock drains measurably, but twenty minutes at
        // +19.6 ppm is about 24 ms of the 340 ms lost.
        let input = NoticeInput {
            clock_drained_ms: drained_over(FIELD_PPM, 20.0 / 60.0),
            ..drained(Some(0.0), false)
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("running low");
        assert_eq!(n.cause, None);
    }

    #[test]
    fn running_low_on_a_poor_link_still_names_the_clock() {
        // The Playbar's link is poor all the time; its clock still drained
        // the reserve, and that is what a restart or correction fixes.
        let input = NoticeInput {
            link_poor: true,
            ..drained(Some(0.0), false)
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("running low");
        assert_eq!(n.cause, Some(SpeakerNoticeCause::Drift));
        // A poor link under a loss the clock does not explain names nothing.
        let input = NoticeInput {
            link_poor: true,
            clock_drained_ms: drained_over(FIELD_PPM, 20.0 / 60.0),
            ..drained(Some(0.0), false)
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("running low");
        assert_eq!(n.cause, None);
    }

    /// The field's clock at the end of the 6h12m cast: +19.3 ± 0.5 ppm,
    /// shrunk by its uncertainty.
    const END_PPM: f64 = 18.8;

    /// The 6h12m chunked cast's report at 07:59:25 UTC, 2026-09-29: a
    /// Playbar at the 500 ms head start that had settled at about 510 ms and
    /// that its clock had drained to about 83 ms. One acknowledgement lag
    /// was sampled in the window, about 88 ms of audio in flight during
    /// retransmissions, which put the acknowledged reserve at -5 ms; the
    /// window's stall was 10 ms, and the link was judged poor.
    fn field_0759() -> NoticeInput {
        NoticeInput {
            locked: true,
            acked: acked(-5.0, -5.0, -5.0, Some(10.0)),
            head_start: full(500),
            stall_ms: Some(10.0),
            link_poor: true,
            time_to_floor_s: Some(0.0),
            net_drift_ppm: END_PPM,
            clock_drained_ms: drained_over(END_PPM, 6.2),
            target_ms: Some(510.0),
            ..NoticeInput::default()
        }
    }

    #[test]
    fn a_drift_drained_speaker_tipped_under_by_a_small_stall_is_running_low() {
        // Not "Wi-Fi held back 505 ms": the clock took the reserve over six
        // hours, and a longer head start would not have helped.
        let n = NoticeState::new()
            .update(Instant::now(), &field_0759())
            .expect("running low");
        assert_eq!(n.kind, SpeakerNoticeKind::RunningLow);
        assert_eq!(n.cause, Some(SpeakerNoticeCause::Drift));
        assert_eq!(n.stall_ms, None);
        assert_eq!(n.suggested_head_start_ms, None);
        assert!(n.restart_helps);

        // The field's sequence: running low had stood since 06:29, first
        // without a cause. The same episode now names the clock, and no
        // head-start notice replaces it.
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        let first = state.update(t0, &drained(None, false)).expect("low");
        assert_eq!(first.cause, None);
        let later = state
            .update(t0 + Duration::from_secs(30), &field_0759())
            .expect("low");
        assert_eq!(later.kind, SpeakerNoticeKind::RunningLow);
        assert_eq!(later.notice_id, first.notice_id);
        assert_eq!(later.cause, Some(SpeakerNoticeCause::Drift));
    }

    #[test]
    fn a_stall_that_beats_a_full_reserve_is_the_head_start() {
        // A full reserve hit by a 600 ms stall: the head start ran out, and
        // 750 (600 above its floor) would have covered it.
        let input = NoticeInput {
            time_to_floor_s: Some(3.0 * 3600.0),
            net_drift_ppm: FIELD_PPM,
            clock_drained_ms: drained_over(FIELD_PPM, 0.5),
            target_ms: Some(480.0),
            ..report(-100.0, 380.0, 470.0, Some(600.0))
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("ran out");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartRanOut);
        assert_eq!(n.stall_ms, Some(600));
        assert!(n.suggested_head_start_ms >= Some(750));

        // The same stall on a reserve the clock had drained to 83 ms: still
        // a stall the head start would not have covered, reported as the
        // 600 ms measured, not the 1,100 ms the head start lost in all.
        let input = NoticeInput {
            acked: acked(-517.0, 20.0, 60.0, Some(600.0)),
            stall_ms: Some(600.0),
            ..field_0759()
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("ran out");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartRanOut);
        assert_eq!(n.stall_ms, Some(600));
        assert_eq!(n.left_ms, Some(-517));
        assert_eq!(n.suggested_head_start_ms, Some(750));
    }

    #[test]
    fn a_burst_against_a_thin_head_start_is_the_head_start() {
        // 2026-09-28 08:05 UTC: a 16 s 2.4 GHz loss burst on a poor link
        // held back about 89 ms against a reserve of about 68 ms from a thin
        // head start, and the acknowledged reserve went to -21 ms. The clock
        // (+8 ppm for half an hour) explains none of it.
        let input = NoticeInput {
            locked: true,
            acked: acked(-21.0, 30.0, 68.0, Some(89.0)),
            head_start: full(200),
            stall_ms: Some(89.0),
            link_poor: true,
            time_to_floor_s: Some(2.0 * 3600.0),
            net_drift_ppm: 8.0,
            clock_drained_ms: drained_over(8.0, 0.5),
            target_ms: Some(90.0),
            ..NoticeInput::default()
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("ran out");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartRanOut);
        assert_eq!(n.head_start_ms, Some(200));
        assert!(n.stall_ms >= Some(89));
        assert_eq!(n.left_ms, Some(-21));
        // The default 500 ms (350 above its floor) covers what it lost.
        assert_eq!(n.suggested_head_start_ms, Some(500));
    }

    #[test]
    fn a_poor_link_does_not_make_a_drift_drained_speaker_a_wifi_notice() {
        // Drained by the clock and dipped by a 25 ms stall on a poor link,
        // down to a close call or just under: running low, for the clock.
        for min in [30.0, -2.0] {
            let input = NoticeInput {
                link_poor: true,
                acked: acked(min, 60.0, 70.0, Some(25.0)),
                stall_ms: Some(25.0),
                ..drained(Some(0.0), false)
            };
            let n = NoticeState::new()
                .update(Instant::now(), &input)
                .expect("running low");
            assert_eq!(n.kind, SpeakerNoticeKind::RunningLow, "min {min}");
            assert_eq!(n.cause, Some(SpeakerNoticeCause::Drift), "min {min}");
            assert_eq!(n.stall_ms, None);
        }
    }

    /// A Playbar at the 500 ms head start that settled at about 510 ms and
    /// that its clock (+18.8 ppm for five hours, about 338 ms) had drained
    /// to `level` ms, not yet running low, when a stall of `stall` ms took
    /// it to `level - stall`.
    fn clock_drained_to(level: f64, stall: f64, link_poor: bool) -> NoticeInput {
        NoticeInput {
            locked: true,
            acked: acked(level - stall, level - 10.0, level, Some(stall)),
            head_start: full(500),
            stall_ms: Some(stall),
            link_poor,
            time_to_floor_s: Some((level - 150.0) / (END_PPM * 1e-6)),
            net_drift_ppm: END_PPM,
            clock_drained_ms: drained_over(END_PPM, 5.0),
            target_ms: Some(510.0),
            ..NoticeInput::default()
        }
    }

    #[test]
    fn a_speaker_the_clock_drained_before_it_ran_low_is_not_the_head_start() {
        // Drained to 200 ms (not yet under the 150 ms floor) and run out by a
        // 210 ms stall on a poor link, or to 250 ms and run out by 260 ms on
        // a good one: the clock took two thirds of the 510 ms lost, and
        // either stall would have left a full reserve 240-290 ms. Not
        // "Wi-Fi held back 510 ms", and no longer head start: the speaker
        // cut out for the clock, which a restart or correction fixes.
        for (level, stall, poor) in [(200.0, 210.0, true), (250.0, 260.0, false)] {
            let n = NoticeState::new()
                .update(Instant::now(), &clock_drained_to(level, stall, poor))
                .expect("running low");
            assert_eq!(n.kind, SpeakerNoticeKind::RunningLow, "at {level}");
            assert_eq!(n.cause, Some(SpeakerNoticeCause::Drift), "at {level}");
            assert_eq!(n.stall_ms, None);
            assert_eq!(n.suggested_head_start_ms, None);
            assert!(n.restart_helps);
        }

        // A close call the same way (30 ms left after a 240 ms stall from
        // 270 ms) is no head-start notice either, and not running low.
        let input = clock_drained_to(270.0, 240.0, false);
        assert_eq!(NoticeState::new().update(Instant::now(), &input), None);

        // A stall that beats a full reserve from the same level is the head
        // start, reported as the stall measured, not the 510 ms lost.
        let n = NoticeState::new()
            .update(Instant::now(), &clock_drained_to(200.0, 400.0, true))
            .expect("ran out");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartRanOut);
        assert_eq!(n.stall_ms, Some(400));
        assert_eq!(n.suggested_head_start_ms, Some(750));
    }

    #[test]
    fn a_mid_sized_stall_on_a_drift_drained_speaker_keeps_the_clock() {
        // The 07:59:25 shape with a 300 ms stall: more than half of what the
        // reserve lost to its 10th percentile, but under the 350 ms a full
        // reserve covers. The speaker still cut out for the clock.
        let input = NoticeInput {
            acked: acked(-5.0, -5.0, 295.0, Some(300.0)),
            stall_ms: Some(300.0),
            ..field_0759()
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("running low");
        assert_eq!(n.kind, SpeakerNoticeKind::RunningLow);
        assert_eq!(n.cause, Some(SpeakerNoticeCause::Drift));
    }

    /// An offset step on the field's speaker after its clock (+18.8 ppm for
    /// seven hours) drained it to a 10 ms 10th percentile, with `stall` ms
    /// measured on a poor link.
    fn drift_drained_step(stall: f64) -> NoticeInput {
        NoticeInput {
            locked: false,
            acked: None,
            offset_step: true,
            pre_break: Some(PreBreak {
                reason: SegmentBreak::OffsetStep,
                acked: AckedReserve {
                    min_ms: 5.0,
                    p10_ms: 10.0,
                    median_ms: 20.0,
                    measured: true,
                    stall_ms: Some(stall),
                },
                locked: true,
            }),
            head_start: full(500),
            stall_ms: Some(stall),
            link_poor: true,
            net_drift_ppm: END_PPM,
            clock_drained_ms: drained_over(END_PPM, 7.0),
            target_ms: Some(510.0),
            ..NoticeInput::default()
        }
    }

    #[test]
    fn a_step_on_a_drift_drained_speaker_is_not_a_wifi_notice() {
        // Running low for the clock stood when the speaker underran on an
        // offset step with an 8 ms stall on its always-poor link: the clock
        // is still the reason, and no head-start notice replaces it.
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        let low = NoticeInput {
            acked: acked(5.0, 10.0, 20.0, Some(8.0)),
            locked: true,
            time_to_floor_s: Some(0.0),
            offset_step: false,
            pre_break: None,
            ..drift_drained_step(8.0)
        };
        let first = state.update(t0, &low).expect("running low");
        assert_eq!(first.kind, SpeakerNoticeKind::RunningLow);
        assert_eq!(first.cause, Some(SpeakerNoticeCause::Drift));
        let later = state
            .update(t0 + Duration::from_secs(30), &drift_drained_step(8.0))
            .expect("running low");
        assert_eq!(later.kind, SpeakerNoticeKind::RunningLow);
        assert_eq!(later.notice_id, first.notice_id);
        assert_eq!(later.cause, Some(SpeakerNoticeCause::Drift));

        // With nothing standing, the step raises running low for the clock.
        let n = NoticeState::new()
            .update(t0, &drift_drained_step(8.0))
            .expect("running low");
        assert_eq!(n.kind, SpeakerNoticeKind::RunningLow);
        assert_eq!(n.cause, Some(SpeakerNoticeCause::Drift));
        assert_eq!(n.left_ms, Some(10));

        // A stall that beats a full reserve is still the head start, at the
        // stall measured rather than the whole head start.
        let n = NoticeState::new()
            .update(t0, &drift_drained_step(600.0))
            .expect("ran out");
        assert_eq!(n.kind, SpeakerNoticeKind::HeadStartRanOut);
        assert_eq!(n.stall_ms, Some(600));
        assert_eq!(n.suggested_head_start_ms, Some(750));
    }

    #[test]
    fn a_speaker_that_settled_low_is_judged_from_the_head_start() {
        // Settled at 200 ms of a 500 ms head start (far more than settling
        // takes): the loss is judged from 400 ms, so the 60 ms the clock
        // drained since does not name it, though it is most of the loss
        // from where it settled.
        let input = NoticeInput {
            target_ms: Some(200.0),
            clock_drained_ms: 60.0,
            ..drained(Some(0.0), false)
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("running low");
        assert_eq!(n.cause, None);
        // Without a learned target the head start is the reference, and the
        // field's drain still names the clock.
        let input = NoticeInput {
            target_ms: None,
            ..drained(Some(0.0), false)
        };
        let n = NoticeState::new()
            .update(Instant::now(), &input)
            .expect("running low");
        assert_eq!(n.cause, Some(SpeakerNoticeCause::Drift));
    }

    #[test]
    fn running_low_after_drift_uncorrected_keeps_the_cause() {
        // The field sequence: the drift notice first, then running low
        // replaces it and stands for the rest of the cast.
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        let drift = state
            .update(
                t0,
                &NoticeInput {
                    time_to_floor_s: Some(20.0 * 60.0),
                    ..healthy()
                },
            )
            .expect("drift");
        assert_eq!(drift.kind, SpeakerNoticeKind::DriftUncorrected);
        let low = state
            .update(t0 + Duration::from_secs(30), &drained(Some(0.0), false))
            .expect("running low");
        assert_eq!(low.kind, SpeakerNoticeKind::RunningLow);
        assert!(low.notice_id > drift.notice_id);
        assert_eq!(low.cause, Some(SpeakerNoticeCause::Drift));
    }

    #[test]
    fn running_low_names_a_cause_found_later_in_place() {
        let mut state = NoticeState::new();
        let t0 = Instant::now();
        let first = state.update(t0, &drained(None, false)).expect("low");
        assert_eq!(first.cause, None);
        // The clock fit firms up: the same episode, now with its cause.
        let named = state
            .update(t0 + Duration::from_secs(30), &drained(Some(0.0), false))
            .expect("low");
        assert_eq!(named.notice_id, first.notice_id);
        assert_eq!(named.cause, Some(SpeakerNoticeCause::Drift));
        // A report without the projection does not take it away again.
        let later = state
            .update(t0 + Duration::from_secs(60), &drained(None, false))
            .expect("low");
        assert_eq!(later, named);
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

    /// Drift notices follow whether correction is actually running on the
    /// connection, not the mode alone: without it the drift is uncorrected;
    /// with it, only a correction pinned at its cap is worth a notice.
    #[test]
    fn drift_notice_gates_on_adapter_active() {
        let t0 = Instant::now();
        let draining = |drift_active, saturated| NoticeInput {
            time_to_floor_s: Some(20.0 * 60.0),
            drift_active,
            saturated,
            ..healthy()
        };

        let mut state = NoticeState::new();
        let n = state.update(t0, &draining(false, false)).expect("drift");
        assert_eq!(n.kind, SpeakerNoticeKind::DriftUncorrected);
        // Saturation means nothing without an engaged adapter.
        let mut state = NoticeState::new();
        let n = state.update(t0, &draining(false, true)).expect("drift");
        assert_eq!(n.kind, SpeakerNoticeKind::DriftUncorrected);

        // Correcting within its range: nothing to say.
        let mut state = NoticeState::new();
        assert_eq!(state.update(t0, &draining(true, false)), None);

        // Pinned at the cap and still draining: saturated, with the minutes
        // left on the remainder and restart advice for a full head start.
        let n = state
            .update(t0 + Duration::from_secs(30), &draining(true, true))
            .expect("saturated");
        assert_eq!(n.kind, SpeakerNoticeKind::DriftSaturated);
        assert_eq!(n.minutes, Some(20));
        assert!(n.restart_helps);
        // It stands while saturated, under the same id...
        assert_eq!(
            state.update(t0 + Duration::from_secs(60), &draining(true, true)),
            Some(n)
        );
        // ...and clears once the controller is off the cap.
        assert_eq!(
            state.update(t0 + Duration::from_secs(90), &draining(true, false)),
            None
        );

        // An uncorrected notice gives way once correction engages.
        let mut state = NoticeState::new();
        state.update(t0, &draining(false, false)).expect("drift");
        assert_eq!(
            state.update(t0 + Duration::from_secs(30), &draining(true, false)),
            None
        );
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
            cause: None,
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
            SpeakerNoticeKind::DriftSaturated,
        ] {
            assert_eq!(wire(kind), format!("\"{}\"", kind.as_str()));
        }
        let low = SpeakerNotice {
            kind: SpeakerNoticeKind::RunningLow,
            notice_id: 4,
            stall_ms: None,
            left_ms: Some(149),
            head_start_ms: Some(500),
            suggested_head_start_ms: None,
            minutes: None,
            restart_helps: true,
            cause: Some(SpeakerNoticeCause::Drift),
        };
        assert_eq!(
            serde_json::to_value(low).unwrap(),
            serde_json::json!({
                "kind": "running_low",
                "noticeId": 4,
                "leftMs": 149,
                "headStartMs": 500,
                "restartHelps": true,
                "cause": "drift",
            })
        );
        assert_eq!(
            serde_json::to_string(&SpeakerNoticeCause::Drift).unwrap(),
            format!("\"{}\"", SpeakerNoticeCause::Drift.as_str())
        );
    }
}
