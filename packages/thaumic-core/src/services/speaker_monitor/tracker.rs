//! Ties the reserve estimator, the clock fit and the segment bookkeeping
//! together for one speaker, the way the monitor uses them.
//!
//! The monitor feeds every answered poll to [`ReserveTracker::observe`] and
//! asks for an estimate every 30 s with [`ReserveTracker::estimate`], then
//! hands over how far the speaker's acknowledgements lagged the delivered
//! count meanwhile with [`ReserveTracker::observe_ack_lag`]. The tracker
//! decides segment breaks, clears the windows they invalidate, raises the
//! low-reserve alarm, and keeps the per-connection figures the
//! end-of-connection summary reports.
//!
//! The estimate counts delivered audio as what the response body has
//! yielded, which runs ahead of what the speaker holds whenever the socket
//! backs up: a retransmission stall of a few hundred milliseconds eats the
//! speaker's reserve while the delivered count carries on. That is harmless
//! for the estimate's slow trends, but it is exactly the dip that makes the
//! speaker stutter, so the lowest reserve and the alarms are taken on the
//! audio the speaker has acknowledged instead.
//!
//! A speaker is low when that acknowledged reserve falls below an absolute
//! floor sized from the speaker head start its connection was sent (see
//! [`low_floor_ms`]), not below a level learned from the cast: a reserve that
//! settled at 500 ms and dips to 350 ms is fine, and one that started with
//! next to nothing is not, whatever it settled at.
//!
//! A long PCM cast is carried on a chain of segments (see
//! [`crate::stream::playout`]), and the monitor counts RelTime on each from
//! the playout's start, so a switch of segment is neither a new track nor
//! RelTime going backwards. But a speaker reports RelTime on the first item
//! it was told to play about 0.1-0.2 s ahead of the audio (by how much
//! depends on the model), and on an item it moved on to gaplessly from the
//! audio itself. So at the first continuation switch the reserve reads that
//! much higher though nothing was heard, and a window straddling the switch
//! ramps across the step. The tracker measures the step instead (see
//! [`ReserveTracker::observe_on`]) and absorbs it, the drift controller
//! steering meanwhile by the reserve from before the switch, carried on.

use super::bounds::PollObservation;
use super::clock_fit::{ClockEstimate, ClockFit};
use super::control::EstimateCarry;
use super::reserve::{LockReason, ReserveEstimate, ReserveEstimator, RESERVE_WINDOW_MS, TRIM_RANK};
use super::rollup::WindowStats;
use super::segment::{Segment, SegmentBreak, OFFSET_STEP_LAG_MS, OFFSET_STEP_MIN_MS};
use crate::stream::HeadStart;

/// Standard error, in ppm, above which the clock fit moves nothing: not the
/// reserve window's older bounds, the step baseline, nor an estimate carried
/// across a continuation switch. A rate from the first few blocks can be
/// hundreds of ppm off with an error to match (the field's first estimate
/// was −465±161 ppm for a +19 ppm speaker), and even shrunk (see
/// [`ClockEstimate::shrunk_ppm`]) it dragged the reserve 24 ms, which the
/// drift controller took for a real surplus. Not moving the bounds costs at
/// most the true rate over the window: 20 ppm over 180 s is 3.6 ms.
pub const CLOCK_SHIFT_MAX_SE_PPM: f64 = 50.0;

/// Standard error, in ppm, the clock fit must be within before a reporting
/// offset absorbed with a less precise clock is corrected for it (see
/// [`SwitchOutcome::Reclocked`]).
///
/// The correction is the rate times the six and a half minutes the offset
/// was measured over, about 16 ms on a 45 ppm speaker, so a rate good only
/// to the [`CLOCK_SHIFT_MAX_SE_PPM`] that moves the reserve is no better
/// than none: corrected at the first such fit, the offsets of twenty
/// simulated -45 ppm speakers in ten-minute segments moved by +9 to -50 ms
/// and came no nearer the truth (29 ms RMS off, against 30). Within 20 ppm,
/// half an hour in, a hundred of them moved by -37 to +29 ms, and their
/// error went from +17 ms on average to +3 (from 28 ms RMS to 24, the worst
/// from 64 ms to 59).
pub const RECLOCK_MAX_SE_PPM: f64 = 20.0;

/// Largest step at the first continuation switch after the speaker was told
/// to play, in ms, taken for the speaker counting RelTime differently on the
/// new item and absorbed (about 110 ms on a Playbar and 210 ms on a Play:1
/// were measured). A larger one is taken for something heard, an underrun or
/// a skip, and ends the segment as an offset step.
pub const CONTINUATION_OFFSET_MAX_MS: f64 = 400.0;

/// Most the reserve may read lower after the first continuation switch, in
/// ms, and the step still be absorbed. The first item reports ahead of the
/// audio, so a genuine reporting offset only ever raises the reserve, as an
/// underrun does too; a reserve reading lower is the playhead jumping
/// forward, a skip. A step down this small is within what two estimates'
/// errors allow, and the step detector would not tell it from noise either.
pub const CONTINUATION_OFFSET_MIN_MS: f64 = -OFFSET_STEP_MIN_MS;

/// Largest step either way at a continuation switch away from a segment the
/// speaker moved on to gaplessly (or came to any other way but being told to
/// play it), in ms, that is not taken for an underrun or a skip. Both items
/// count RelTime from the audio, so the offset should be nil (it was within
/// 10 ms on a Play:1): a step this small is measuring error, and is left
/// alone rather than absorbed, since absorbed at every switch it would add up
/// (by up to 130 ms over three hours of 600 s segments in simulation).
/// Anything the step detector would call a step is one, an underrun at the
/// handover included.
pub const LATER_SWITCH_OFFSET_MAX_MS: f64 = OFFSET_STEP_MIN_MS;

/// How long a segment must have been played before a switch away from it is
/// measured: a window's worth, so there are enough of its polls to measure
/// the reserve before the switch from. Switches between shorter segments (a
/// test configuration) are left as they always were.
pub const CONTINUATION_MIN_SEGMENT_MS: f64 = RESERVE_WINDOW_MS;

/// How much playing on either side of a continuation switch its offset is
/// measured over, in ms. One reserve estimate is good to a few tens of ms,
/// and the difference of two single estimates was off by up to 80 ms in
/// simulation; over twice the polls on each side (see
/// [`ReserveEstimator::fresh`]) the offset came within about ±20 ms of the
/// truth, the worst of forty runs 46 ms (at a switch hours into a cast; at
/// one in its first half hour the clock is not yet precise enough to carry
/// the reserve across, and on a 45 ppm speaker the offset read up to 60 ms
/// off until corrected; see [`RECLOCK_MAX_SE_PPM`]). The drift controller
/// steers by the reserve before the switch, carried on, for this long after
/// it (see [`ReserveTracker::carry`]).
pub const CONTINUATION_MEASURE_MS: f64 = 2.0 * RESERVE_WINDOW_MS;

/// How long the estimate from before a continuation switch is carried while
/// the polls after it give no tight estimate over [`CONTINUATION_MEASURE_MS`],
/// in ms. After that the new segment's own estimate is reported, and the
/// offset is measured once it is tight; the drift controller holds until
/// then.
pub const CONTINUATION_SETTLE_MAX_MS: f64 = 15.0 * 60_000.0;

/// Most the reserve window's latest tight estimate may be older than a
/// continuation switch, in ms, for the reserve before the switch to be
/// measured: as long as the reference itself spans. A window that has not
/// been tight for longer may be straddling something.
///
/// It was a window's worth, and a steady speaker's window went that long
/// without a tight estimate about once in 350 reports in simulation (at
/// 25-100 ms of tick jitter), which would have left a first switch
/// unmeasured; it never went six minutes. An older tight estimate lets no
/// step through: made before the step, it disagrees with the reference by
/// more, not less.
pub const SWITCH_REFERENCE_MAX_AGE_MS: f64 = CONTINUATION_MEASURE_MS;

/// Most the reserve over the [`CONTINUATION_MEASURE_MS`] before a
/// continuation switch may differ from the reserve window's latest tight
/// estimate, in ms, for it to be the reference the switch is measured from.
/// The two agreed within 25 ms in simulation at 25 ms of tick jitter.
pub const SWITCH_REFERENCE_MAX_DISAGREEMENT_MS: f64 = OFFSET_STEP_MIN_MS / 2.0;

/// The stretch before a continuation switch, in ms, whose polls are checked
/// for a step the reserve windows have not turned over to yet: as long as the
/// step detector takes to confirm one (see [`OFFSET_STEP_LAG_MS`]), so every
/// step before a switch is either found by it or caught here.
///
/// A window straddling a step reads somewhere between its two levels, often
/// consistent and tight, and the reserve window just before the switch
/// agrees with it: an underrun a minute before a switch moved them both by
/// only a third of the step, or nothing, in simulation. What gives the step
/// away is the few polls the trimmed estimate sets aside. For a steady
/// speaker those disagree with it on either side, scattered through the
/// window; after a step the newest of them all lie on the side of the new
/// level. [`TRIM_RANK`] of the newest in a row on one side is taken for a
/// step. In simulation that caught every underrun of 200 ms or more from 60
/// to 240 s before a switch, and no steady speaker at 25 or 50 ms of tick
/// jitter (200 runs each); at 100 ms, one switch in thirteen was left
/// unmeasured. An underrun in the last half minute before a switch leaves
/// too few polls to tell from one at the switch.
pub const SWITCH_REFERENCE_RECENT_MS: f64 = OFFSET_STEP_LAG_MS;

/// How the speaker came to be playing the playout segment a position was
/// counted on, which decides how it counts RelTime there.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TimelineEntry {
    /// Told to play it: the playout's first segment, or a restart onto a
    /// later one. RelTime runs a little ahead of the audio.
    Played,
    /// Moved on to it gaplessly as its next item. RelTime counts from the
    /// audio.
    Next,
    /// Any other way (the user skipped to it, or it reopened a segment):
    /// left as it always was.
    Other,
}

/// Which segment of a PCM playout a position poll was counted on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PlayoutTimeline {
    /// Output byte the segment's data starts at, which names it.
    pub start: u64,
    /// How the speaker came to be playing it.
    pub entry: TimelineEntry,
}

/// Why a continuation switch's offset was not measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum SwitchUnmeasured {
    /// The segment switched away from was played for less than
    /// [`CONTINUATION_MIN_SEGMENT_MS`].
    ShortSegment,
    /// No tight estimate of the playing before the switch to measure from.
    NoReference,
    /// A segment break (or a new connection) came first.
    SegmentBreak,
    /// Another switch came first.
    Superseded,
    /// The polls after the switch gave no tight estimate within
    /// [`CONTINUATION_SETTLE_MAX_MS`]: not measured yet. The offset is
    /// measured once they do, and the switch then comes to one more outcome.
    NotTight,
}

impl SwitchUnmeasured {
    /// The reason as a log token.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::ShortSegment => "short_segment",
            Self::NoReference => "no_reference",
            Self::SegmentBreak => "segment_break",
            Self::Superseded => "superseded",
            Self::NotTight => "not_tight",
        }
    }
}

/// What a continuation switch came to.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum SwitchOutcome {
    /// The step was measured and absorbed: the new segment's reserve now
    /// reads `offset_ms` lower than its RelTime alone would say.
    Absorbed {
        /// The step, in ms; positive when the reserve read higher after it.
        offset_ms: f64,
    },
    /// The segment switched away from was one the speaker moved on to by
    /// itself, so both count RelTime from the audio and no reporting offset
    /// is expected, and the step measured was within what measuring allows:
    /// nothing is absorbed and the new segment's polls join the window as
    /// they are.
    Steady {
        /// The step measured, in ms: measuring error.
        offset_ms: f64,
    },
    /// The step was too large to be a reporting offset: it ended the segment
    /// as an offset step.
    Rejected {
        /// The step, in ms.
        offset_ms: f64,
    },
    /// Nothing was measured, and nothing absorbed.
    Unmeasured(SwitchUnmeasured),
    /// The offset absorbed earlier was measured before the speaker's clock
    /// was known well enough to carry the reserve across the switch, so it
    /// was carried along a rate of 0 (or a rough one); now the clock is
    /// within [`RECLOCK_MAX_SE_PPM`], the offset is corrected by what that
    /// rate would have carried it. A second outcome for the same switch.
    Reclocked {
        /// The offset now absorbed, in ms.
        offset_ms: f64,
        /// How much it moved, in ms.
        by_ms: f64,
    },
}

/// An absorbed reporting offset measured before the clock was within
/// [`RECLOCK_MAX_SE_PPM`], awaiting correction (see
/// [`SwitchOutcome::Reclocked`]).
#[derive(Debug, Clone, Copy, PartialEq)]
struct UnclockedOffset {
    /// The clock rate the reserve before the switch was carried along, in
    /// ppm.
    clock_ppm: f64,
    /// How long it was carried, in ms.
    span_ms: f64,
}

/// A continuation switch whose offset is being measured.
#[derive(Debug, Clone)]
struct PendingSwitch {
    /// When the first poll on the new segment was sent.
    at: f64,
    /// The steps, in ms, that are not taken for an underrun or a skip: which
    /// depends on how the speaker came to the segment it left.
    bounds: (f64, f64),
    /// Whether a step within `bounds` is a reporting offset, absorbed, or
    /// measuring error, left alone: only a switch away from the item the
    /// speaker was told to play can have an offset.
    absorbs: bool,
    /// The reserve just before the switch, over the
    /// [`CONTINUATION_MEASURE_MS`] of polls before it.
    carried: ReserveEstimate,
    /// Audio the drift correction has inserted since `carried` was made, in
    /// ms, counted a report at a time at the correction in force over each.
    inserted_ms: f64,
    /// Up to when `inserted_ms` has been counted.
    inserted_at: f64,
    /// The polls since the switch, on their own.
    probe: ReserveEstimator,
    /// Whether they have taken longer than [`CONTINUATION_SETTLE_MAX_MS`]
    /// to give a tight estimate.
    overdue: bool,
}

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

/// Projected time to the low floor (see [`ReserveTracker::time_to_floor_s`])
/// below which the speaker is reported as draining.
pub const DRAINING_WARN_SECS: f64 = 30.0 * 60.0;

/// The acknowledged reserve below which a speaker is low, in ms, given the
/// speaker head start its connection was actually sent:
/// `clamp(0.3·H, 40, 150)`, so 150 ms at the default 500 ms head start, 75 ms
/// at 250 ms and 40 ms with the head start off.
///
/// Judged on the acknowledged reserve's 10th percentile over a report's
/// window, not its minimum: a single retransmission stall dips the minimum
/// by a round trip and a retransmission timeout, and a reserve that rides it
/// out is not low.
pub fn low_floor_ms(head_start_ms: u32) -> f64 {
    (0.3 * f64::from(head_start_ms)).clamp(40.0, 150.0)
}

/// The level a low speaker's acknowledged reserve must regain to be healthy
/// again, in ms: the floor plus `clamp(0.2·H, 30, 100)`, so 250 ms at the
/// default 500 ms head start and 70 ms with it off.
pub fn low_clear_ms(head_start_ms: u32) -> f64 {
    low_floor_ms(head_start_ms) + (0.2 * f64::from(head_start_ms)).clamp(30.0, 100.0)
}

/// The reserve on audio the speaker has acknowledged, over one report's
/// window: the estimate less how far the acknowledgements lagged.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AckedReserve {
    /// The lowest the acknowledged reserve fell to.
    pub min_ms: f64,
    /// The level it stayed above nine tenths of the time.
    pub p10_ms: f64,
    /// Its median: the estimate less the median acknowledgement lag. Below
    /// the floor, the reserve itself is low, not just dipped by stalls.
    pub median_ms: f64,
    /// Whether acknowledgements were measured. Where the platform does not
    /// report them this is the delivered-count estimate itself.
    pub measured: bool,
    /// How far the worst acknowledgement lag of the window stood above its
    /// median (see [`stall_ms`]), where acknowledgements were measured.
    pub stall_ms: Option<f64>,
}

/// How far the worst of a window's acknowledgement lags stood above their
/// median, in ms: the audio a stall held back, less the steady amount in
/// flight on a clean link. `None` without lags. Reorders `lags_ms`.
pub fn stall_ms(lags_ms: &mut [f64]) -> Option<f64> {
    let median = median_ms(lags_ms)?;
    Some((lags_ms[lags_ms.len() - 1] - median).max(0.0))
}

/// The median of `samples`, or `None` without any. Sorts `samples`.
fn median_ms(samples: &mut [f64]) -> Option<f64> {
    if samples.is_empty() {
        return None;
    }
    samples.sort_unstable_by(f64::total_cmp);
    let n = samples.len();
    Some(if n % 2 == 1 {
        samples[n / 2]
    } else {
        (samples[n / 2 - 1] + samples[n / 2]) / 2.0
    })
}

/// The acknowledged reserve from the last report before a segment break,
/// kept so what led up to the break can still be judged once the estimate
/// it came from has been cleared.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct PreBreak {
    /// Why the segment broke.
    pub reason: SegmentBreak,
    /// The acknowledged reserve over the last report's window before it.
    pub acked: AckedReserve,
    /// Whether the estimate behind `acked` was locked.
    pub locked: bool,
}

/// The monitor's view of one speaker, for the log.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MonitorState {
    /// Measuring, but the estimate is not yet precise or settled.
    Locking,
    /// The estimate is locked.
    Ok,
    /// The estimate is locked and the reserve is projected to reach the low
    /// floor within [`DRAINING_WARN_SECS`].
    Draining,
    /// The estimate is locked and the acknowledged reserve's 10th percentile
    /// has fallen below the floor [`low_floor_ms`] sets (and not yet
    /// regained [`low_clear_ms`]).
    Low,
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
            Self::Low => "low",
            Self::Paused => "paused",
            Self::Stale => "stale",
            Self::Dormant => "dormant",
        }
    }
}

impl From<MonitorState> for crate::events::SpeakerHealthState {
    fn from(state: MonitorState) -> Self {
        match state {
            MonitorState::Locking => Self::Locking,
            MonitorState::Ok => Self::Ok,
            MonitorState::Draining => Self::Draining,
            MonitorState::Low => Self::Low,
            MonitorState::Paused => Self::Paused,
            MonitorState::Stale => Self::Stale,
            MonitorState::Dormant => Self::Dormant,
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
    /// The lowest reserve seen while locked, on acknowledged audio (on the
    /// delivered count where acknowledgements are not reported), so a stall
    /// that briefly emptied the speaker shows here.
    pub reserve_min_ms: Option<f64>,
    /// Whether [`Self::reserve_min_ms`] was taken on acknowledged audio.
    pub acked_measured: bool,
    /// Segment breaks by reason, as counted when the connection started.
    breaks_before: [u32; 5],
    /// Reserve estimates made and how many were inconsistent, as counted
    /// when the connection started.
    estimates_before: (u64, u64),
    /// How long the connection has been measured playing, in ms: the gaps
    /// between its measured polls, each up to [`PLAYING_GAP_MAX_MS`].
    playing_ms: f64,
    /// When the latest measured poll was sent.
    last_measured_ts: Option<f64>,
}

/// Longest gap between two measured polls counted as time spent playing, in
/// ms. The monitor polls every 2 s (5 s when backing off), so a longer gap
/// is a pause or an outage, over which the clock drains nothing.
const PLAYING_GAP_MAX_MS: f64 = 30_000.0;

/// Reserve and clock tracking for one speaker, across its connections.
#[derive(Debug, Clone, Default)]
pub struct ReserveTracker {
    reserve: ReserveEstimator,
    clock: ClockFit,
    segment: Segment,
    /// Whether the current connection's reserve can be measured (PCM).
    pcm: bool,
    /// The speaker head start the current connection was sent, when known
    /// (PCM only).
    head_start: Option<HeadStart>,
    /// Whether no segment break has happened yet on the current connection:
    /// the target is learned only in its first segment.
    first_segment: bool,
    /// Whether any connection has started yet.
    started: bool,
    last: Option<ReserveEstimate>,
    /// The latest tight estimate the reserve window made on the current
    /// segment, or the one a continuation switch was measured by.
    last_tight: Option<ReserveEstimate>,
    /// Whether [`Self::last`] was made by the latest call to
    /// [`Self::estimate`], and so may be combined with the acknowledgement
    /// lag of the same window.
    last_fresh: bool,
    /// The acknowledged reserve over the latest report's window.
    last_acked: Option<AckedReserve>,
    /// How far the worst acknowledgement lag of the latest report's window
    /// stood above its median, whether or not that report made an estimate.
    last_stall_ms: Option<f64>,
    /// The acknowledged reserve before the current connection's latest
    /// segment break, until the next locked estimate.
    pre_break: Option<PreBreak>,
    /// The reserve the current connection settled at once its head start
    /// had gone out: the mean of the first two tight estimates of its first
    /// segment. Relearned on every connection, since each gets its own head
    /// start; a connection whose first segment breaks before two tight
    /// estimates has none. Not what the low alarm is judged against (that
    /// is the absolute floor); the log shows it against the head start sent
    /// as `calib`.
    target_ms: Option<f64>,
    /// The first tight estimate for the target, while it waits for a
    /// second.
    target_pending: Option<f64>,
    /// Whether the acknowledged reserve is low (with hysteresis).
    low: bool,
    /// The drift correction applied to the delivered audio, in ppm: how
    /// much faster than our clock it is handed over.
    command_ppm: f64,
    connection: ConnectionStats,
    /// The playout segment the latest measured poll was counted on, and
    /// when the first poll on it was sent.
    timeline: Option<(PlayoutTimeline, f64)>,
    /// How much lower than their RelTime alone says the reserve is taken on
    /// the current playout segment, in ms: the reporting offset absorbed at
    /// the first continuation switch since the speaker was last told to play.
    reserve_offset_ms: f64,
    /// The offset in [`Self::reserve_offset_ms`], if it was measured before
    /// the clock was within [`RECLOCK_MAX_SE_PPM`] and has not been
    /// corrected yet.
    unclocked: Option<UnclockedOffset>,
    /// A continuation switch whose offset is being measured.
    switch: Option<PendingSwitch>,
    /// The current segment's polls over the last
    /// [`CONTINUATION_MEASURE_MS`], as the reserve window gets them, for
    /// measuring the reserve just before a continuation switch.
    reference: ReserveEstimator,
    /// What the latest continuation switch came to, until taken.
    switch_outcome: Option<SwitchOutcome>,
}

impl ReserveTracker {
    /// A tracker that has seen nothing.
    pub fn new() -> Self {
        Self::default()
    }

    /// Starts tracking a new connection. `pcm` is whether its delivered
    /// audio can be counted in milliseconds; a compressed connection only
    /// gets a clock fit. `head_start` is the speaker head start the
    /// connection was sent, which sizes the low floor (PCM only; taken as
    /// none when unknown). Every connection after the first ends a segment.
    pub fn start_connection(&mut self, pcm: bool, head_start: Option<HeadStart>) {
        if self.started {
            self.segment.start(SegmentBreak::NewConnection);
            self.clear();
        }
        self.started = true;
        self.pcm = pcm;
        self.head_start = head_start.filter(|_| pcm);
        self.first_segment = true;
        self.last = None;
        self.last_tight = None;
        self.last_fresh = false;
        self.last_acked = None;
        self.last_stall_ms = None;
        self.pre_break = None;
        // Each connection gets its own head start, so it settles at its own
        // level, and the alarm is about the connection being measured.
        self.target_ms = None;
        self.target_pending = None;
        self.low = false;
        // The new connection counts RelTime from its own start.
        self.reference = self.reserve.fresh(CONTINUATION_MEASURE_MS);
        self.timeline = None;
        self.reserve_offset_ms = 0.0;
        self.unclocked = None;
        self.switch_outcome = None;
        self.connection = ConnectionStats {
            breaks_before: SegmentBreak::ALL.map(|r| self.segment.count(r)),
            estimates_before: self.reserve.counts(),
            ..ConnectionStats::default()
        };
    }

    /// Sets the drift correction applied to the delivered audio from now
    /// on, in ppm (positive inserts audio). The reserve then drains at the
    /// clock rate less this, which is what the estimate carries older bounds
    /// forward by and what the time to the floor is projected on.
    pub fn set_command_ppm(&mut self, ppm: f64) {
        self.command_ppm = if ppm.is_finite() { ppm } else { 0.0 };
    }

    /// The drift correction applied to the delivered audio, in ppm.
    pub fn command_ppm(&self) -> f64 {
        self.command_ppm
    }

    /// How much faster than delivery the speaker drains its reserve, in
    /// ppm: its clock rate shrunk by its uncertainty (see
    /// [`ClockEstimate::shrunk_ppm`]), less the correction applied.
    fn net_ppm(&self) -> f64 {
        self.clock.estimate().map_or(0.0, |c| c.shrunk_ppm()) - self.command_ppm
    }

    /// The net rate older reserve bounds are carried forward along, in ppm:
    /// as [`Self::net_ppm`], but with the clock left out until its standard
    /// error is within [`CLOCK_SHIFT_MAX_SE_PPM`].
    fn shift_ppm(&self) -> f64 {
        self.clock_shift_ppm() - self.command_ppm
    }

    /// The speaker's clock rate as [`Self::shift_ppm`] counts it, in ppm:
    /// shrunk, and 0 until its standard error is within
    /// [`CLOCK_SHIFT_MAX_SE_PPM`].
    fn clock_shift_ppm(&self) -> f64 {
        self.clock
            .estimate()
            .filter(|c| c.se_ppm <= CLOCK_SHIFT_MAX_SE_PPM)
            .map_or(0.0, |c| c.shrunk_ppm())
    }

    /// Whether the clock fit's standard error is within `se_ppm`.
    fn clock_within(&self, se_ppm: f64) -> bool {
        self.clock.estimate().is_some_and(|c| c.se_ppm <= se_ppm)
    }

    /// Corrects an offset absorbed with an imprecise clock (see
    /// [`SwitchOutcome::Reclocked`]) once the clock is within
    /// [`RECLOCK_MAX_SE_PPM`].
    ///
    /// The reserve before the switch was carried across the measuring span
    /// along the rate the clock was taken at then (0 until it is within
    /// [`CLOCK_SHIFT_MAX_SE_PPM`]), so the offset read the true rate's
    /// difference from it times that span off. The first switch on a real
    /// cast comes hours in, with a precise clock; with segments of ten
    /// minutes it comes before one. The correction waits while another
    /// switch is being measured, whose polls have the offset in force taken
    /// off them already, and while an outcome waits to be taken.
    fn reclock_offset(&mut self) {
        if self.switch.is_some()
            || self.switch_outcome.is_some()
            || !self.clock_within(RECLOCK_MAX_SE_PPM)
        {
            return;
        }
        let Some(unclocked) = self.unclocked.take() else {
            return;
        };
        // Carried along a faster clock, the reserve would have been expected
        // lower, and the step read that much larger.
        let by_ms = (self.clock_shift_ppm() - unclocked.clock_ppm) * 1e-6 * unclocked.span_ms;
        self.reserve_offset_ms += by_ms;
        self.reserve.shift(-by_ms);
        self.reference.shift(-by_ms);
        if let Some(last) = self.last_tight.as_mut() {
            last.reserve_ms -= by_ms;
        }
        self.switch_outcome = Some(SwitchOutcome::Reclocked {
            offset_ms: self.reserve_offset_ms,
            by_ms,
        });
    }

    /// How much faster than delivery the speaker drains its reserve, in
    /// ppm, net of the correction applied (see [`Self::set_command_ppm`]):
    /// its clock rate shrunk by its uncertainty, less the correction. Zero
    /// before the clock is estimated.
    pub fn net_drain_ppm(&self) -> f64 {
        self.net_ppm()
    }

    /// How much of the reserve the speaker's clock has drained over the
    /// current connection, in ms: the net rate (see [`Self::net_drain_ppm`])
    /// over the time the connection has been measured playing. Zero unless
    /// the clock measurably drains the reserve (see [`Self::clock_drains`]).
    ///
    /// An approximation: the rate is the latest estimate applied to the whole
    /// connection and the correction the one in force now. Enough to tell
    /// whether the clock explains a real share of a running-low reserve,
    /// which is all it is used for.
    pub fn clock_drained_ms(&self) -> f64 {
        if !self.clock_drains() {
            return 0.0;
        }
        (self.net_ppm() * 1e-6 * self.connection.playing_ms).max(0.0)
    }

    /// Clears what a segment break invalidates.
    fn clear(&mut self) {
        self.reserve.clear();
        self.clock.break_segment();
        self.target_pending = None;
        self.first_segment = false;
        self.last_tight = None;
        self.reference.clear();
        if self.switch.take().is_some() {
            self.switch_outcome = Some(SwitchOutcome::Unmeasured(SwitchUnmeasured::SegmentBreak));
        }
    }

    /// Keeps the latest report's acknowledged reserve as the snapshot from
    /// before a segment break for `reason`, then clears what the break
    /// invalidates.
    fn break_segment(&mut self, reason: SegmentBreak) {
        if let Some(acked) = self.last_acked {
            self.pre_break = Some(PreBreak {
                reason,
                acked,
                locked: self.last.is_some_and(|e| e.locked()),
            });
        }
        self.clear();
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
        self.observe_on(obs, track_uri, not_playing, None)
    }

    /// [`Self::observe`] for a poll whose position was counted on playout
    /// segment `timeline`, when known.
    ///
    /// When the speaker moves gaplessly onto the next segment (a
    /// continuation switch, [`TimelineEntry::Next`]), the reserve window
    /// must not straddle the switch: the speaker counted RelTime on the old
    /// segment from a different origin (see the module docs). So the window
    /// holding the old segment's polls stops taking any, and the new
    /// segment's polls are estimated on their own. Until that estimate is
    /// tight, the reserve before the switch is reported, carried forward
    /// along the clock and the correction, held (and [`Self::settling`] says
    /// so); the drift controller steers by it (see [`Self::carry`]). Once it
    /// is tight, the offset between the two, if it is within
    /// [`CONTINUATION_OFFSET_MIN_MS`]..=[`CONTINUATION_OFFSET_MAX_MS`] at the
    /// first switch after the speaker was told to play, is taken off the new
    /// segment's polls (these and all later ones), they join the old window
    /// and the reserve carries on as if nothing had happened. At a later
    /// switch no reporting offset is expected, and one within
    /// ±[`LATER_SWITCH_OFFSET_MAX_MS`] is measuring error: the polls join the
    /// window as they are. A larger one, at either, ends the segment as an
    /// offset step. The clock fit starts a new segment of its own at the
    /// switch away from the item the speaker was told to play, since RelTime
    /// steps there, but runs on across a switch between items it moved on to
    /// by itself (see [`Self::begin_switch`]). [`Self::take_switch_outcome`]
    /// says what each switch came to.
    ///
    /// The reference kept is the first segment's: the reserve measured while
    /// the speaker plays the item it was told to play reads the reporting
    /// offset lower than what it really holds (by the ~110 ms of a Playbar),
    /// and the head start and the drift controller's target were sized
    /// against that reading, so the later segments are brought into line
    /// with it rather than the other way round. For the same reason a
    /// restart onto a later segment ([`TimelineEntry::Played`]) returns to
    /// counting RelTime as it is.
    ///
    /// A real underrun or skip at the first switch (or in the half minute
    /// before it) that is no larger than a reporting offset is absorbed with
    /// it; one that happens while the new segment's polls settle is measured
    /// into the offset. One in the minutes before the switch leaves no
    /// reference to measure from (see [`SWITCH_REFERENCE_RECENT_MS`]).
    ///
    /// A switch left unmeasured (no reference, or a pause or other segment
    /// break while it settles) is left as it always was: the new segment's
    /// polls keep their RelTime as it is, so a reporting offset reads as that
    /// much more reserve against the target learnt before, and reaches the
    /// drift controller once the estimate locks again. The log says which
    /// switches went unmeasured. So does a switch after a segment shorter
    /// than [`CONTINUATION_MIN_SEGMENT_MS`], and the clock fit is not broken
    /// there either (segments that short would never give it a block): the
    /// fit sees the step, which on a real cast happens once.
    pub fn observe_on(
        &mut self,
        obs: &PollObservation,
        track_uri: &str,
        not_playing: bool,
        timeline: Option<PlayoutTimeline>,
    ) -> Option<SegmentBreak> {
        let brk = self
            .segment
            .observe_poll(obs.rel_ms, track_uri, not_playing);
        if let Some(reason) = brk {
            self.break_segment(reason);
        }
        if not_playing {
            return brk;
        }
        if !self.follow_timeline(obs.ts, timeline) {
            // A late answer about a segment the speaker has left.
            return brk;
        }
        if self.pcm {
            let obs = PollObservation {
                d_ts_ms: obs.d_ts_ms - self.reserve_offset_ms,
                d_tr_ms: obs.d_tr_ms - self.reserve_offset_ms,
                ..*obs
            };
            match &mut self.switch {
                Some(switch) => switch.probe.add(&obs),
                None => {
                    self.reserve.add(&obs);
                    self.reference.add(&obs);
                }
            }
        }
        self.clock.add(obs, self.reserve.jitter_ms());
        let c = &mut self.connection;
        c.polls += 1;
        if let Some(gap) = c.last_measured_ts.map(|prev| obs.ts - prev) {
            if gap > 0.0 && gap <= PLAYING_GAP_MAX_MS {
                c.playing_ms += gap;
            }
        }
        c.last_measured_ts = Some(obs.ts);
        brk
    }

    /// Follows the playout segment a poll sent at `ts` was counted on, and
    /// starts measuring a continuation switch when it moves on. Returns
    /// whether the poll is measured: one about a segment older than the
    /// current one is a late answer and is not.
    fn follow_timeline(&mut self, ts: f64, timeline: Option<PlayoutTimeline>) -> bool {
        let Some(next) = timeline else {
            return true;
        };
        let Some((current, since)) = self.timeline else {
            self.timeline = Some((next, ts));
            return true;
        };
        if next.start == current.start {
            return true;
        }
        // A segment's start names it and only grows along the playout, so
        // an older one is a late answer. A segment reopened under the same
        // URL gets a record of its own, and a poll whose RelTime could not
        // have been reached on the reopened one yet is mapped onto the old
        // record (see `PlayoutView::continuous_position`). That is dropped
        // too: a late answer from before the reopen, or, were the reserve on
        // the reopened record ever to fall below the mapping's slack, one of
        // its polls lost rather than measured against the wrong start.
        if next.start < current.start {
            return false;
        }
        self.timeline = Some((next, ts));
        match next.entry {
            TimelineEntry::Next => self.begin_switch(ts, ts - since, current.entry),
            TimelineEntry::Played => {
                // Told to play afresh: RelTime is counted as on the first
                // segment again.
                self.cancel_switch(SwitchUnmeasured::Superseded);
                self.reserve.shift(self.reserve_offset_ms);
                self.reference.shift(self.reserve_offset_ms);
                self.reserve_offset_ms = 0.0;
                self.unclocked = None;
            }
            TimelineEntry::Other => self.cancel_switch(SwitchUnmeasured::Superseded),
        }
        true
    }

    /// Starts measuring a continuation switch whose first poll was sent at
    /// `ts`, after the previous segment, which the speaker came to by
    /// `left`, was played for `lasted` ms.
    fn begin_switch(&mut self, ts: f64, lasted: f64, left: TimelineEntry) {
        if self.switch.is_some() {
            // The previous switch's polls are all that was measured of the
            // segment just left, and they are not offset-corrected.
            self.cancel_switch(SwitchUnmeasured::Superseded);
            self.reference.clear();
        }
        if !self.pcm {
            return;
        }
        if lasted < CONTINUATION_MIN_SEGMENT_MS {
            self.switch_outcome = Some(SwitchOutcome::Unmeasured(SwitchUnmeasured::ShortSegment));
            return;
        }
        // RelTime steps at a switch away from an item the speaker did not
        // move on to by itself, whether or not the step is measured. Between
        // two it did, both count from the audio and nothing steps; broken
        // there anyway, the fit's segments are one playout segment long (ten
        // minutes in a test configuration), and a slope pinned only within
        // each was up to 60 ppm off after 2.5 hours in simulation, claiming
        // ±18, where one unbroken line was within 3. A step that does come at a
        // later switch breaks the segment, and the fit, as an offset step.
        if left != TimelineEntry::Next {
            self.clock.break_segment();
        }
        let Some(carried) = self.switch_reference(ts) else {
            self.switch_outcome = Some(SwitchOutcome::Unmeasured(SwitchUnmeasured::NoReference));
            return;
        };
        // Only the item the speaker was told to play reports ahead of the
        // audio; between items it moved on to gaplessly nothing should step.
        let (bounds, absorbs) = match left {
            TimelineEntry::Played => (
                (CONTINUATION_OFFSET_MIN_MS, CONTINUATION_OFFSET_MAX_MS),
                true,
            ),
            TimelineEntry::Next | TimelineEntry::Other => (
                (-LATER_SWITCH_OFFSET_MAX_MS, LATER_SWITCH_OFFSET_MAX_MS),
                false,
            ),
        };
        self.switch = Some(PendingSwitch {
            at: ts,
            bounds,
            absorbs,
            inserted_ms: 0.0,
            inserted_at: carried.at,
            carried,
            probe: self.reserve.fresh(CONTINUATION_MEASURE_MS),
            overdue: false,
        });
    }

    /// The reserve just before a continuation switch whose first poll was
    /// sent at `ts`, measured over the last [`CONTINUATION_MEASURE_MS`] of
    /// the segment's polls, if it can be trusted as the level the new
    /// segment's polls are compared with.
    ///
    /// Its own lock says little: it is made once, by an estimator with no
    /// history, so a window straddling a step (whose bounds cross, and whose
    /// half-width is then only the jitter allowance) would pass as tight. An
    /// underrun in the last few minutes before the switch is exactly that,
    /// and the step detector would not have confirmed it yet (it compares
    /// with an estimate [`OFFSET_STEP_LAG_MS`] old). Taken as the reference,
    /// its midpoint would put most of the underrun into the offset and never
    /// report it. So no jump may be awaiting confirmation, the reference must
    /// be consistent, its newest set-aside polls must not crowd onto one side
    /// (see [`SWITCH_REFERENCE_RECENT_MS`]), and it must agree with the
    /// reserve window's latest tight estimate, made within
    /// [`SWITCH_REFERENCE_MAX_AGE_MS`], to within
    /// [`SWITCH_REFERENCE_MAX_DISAGREEMENT_MS`]. Otherwise the switch is
    /// left unmeasured and its polls join the window as they are, where a
    /// step shows up as it always did (and a reporting offset too small for
    /// the step detector reaches the drift controller, as before).
    ///
    /// A steady speaker is refused now and then too: its six minutes of
    /// polls may come out too wide to be tight, as any estimate may. That
    /// left one switch in 340 unmeasured in simulation (twenty three-hour
    /// casts in ten-minute segments at 50 ms of tick jitter). At a later
    /// switch it costs nothing, since a measured one absorbs nothing either;
    /// a first switch it leaves unabsorbed, with its reporting offset read
    /// as surplus reserve.
    fn switch_reference(&self, ts: f64) -> Option<ReserveEstimate> {
        if self.segment.step_pending() {
            return None;
        }
        let ppm = self.shift_ppm();
        let last = self
            .last_tight
            .filter(|e| ts - e.at <= SWITCH_REFERENCE_MAX_AGE_MS)?;
        // Estimated afresh at the jitter the reserve window has learnt.
        let mut reference = self.reserve.fresh(CONTINUATION_MEASURE_MS);
        reference.absorb(&self.reference, 0.0);
        let reference = reference
            .estimate(ts, ppm)
            .filter(|e| e.tight() && !e.inconsistent)?;
        // The trimmed estimate ignores a few polls that disagree with it,
        // scattered outliers; as many crowded into the last stretch, all on
        // one side, are a new level the window has not turned over to yet.
        let crowded = self.reference.newest_beyond(
            ts,
            ppm,
            ts - SWITCH_REFERENCE_RECENT_MS,
            reference.reserve_ms,
        );
        if crowded >= TRIM_RANK {
            return None;
        }
        // Delivery runs at our clock and the playhead at the speaker's.
        let expected = last.reserve_ms - ppm * 1e-6 * (ts - last.at);
        ((reference.reserve_ms - expected).abs() <= SWITCH_REFERENCE_MAX_DISAGREEMENT_MS)
            .then_some(reference)
    }

    /// Gives up measuring the pending continuation switch, if any, for
    /// `why`: its polls join the window as they are.
    fn cancel_switch(&mut self, why: SwitchUnmeasured) {
        if let Some(switch) = self.switch.take() {
            self.reserve.absorb(&switch.probe, 0.0);
            self.reference.absorb(&switch.probe, 0.0);
            self.switch_outcome = Some(SwitchOutcome::Unmeasured(why));
        }
    }

    /// Moves a pending continuation switch on at `now`, the older bounds
    /// carried along `ppm`. Returns what [`Self::estimate`] returns while the
    /// switch is still settling or when it ended the segment, and `None`
    /// once the estimate can be made from the window as usual.
    fn step_switch(
        &mut self,
        now: f64,
        ppm: f64,
        previous_acked: Option<AckedReserve>,
    ) -> Option<(Option<ReserveEstimate>, Option<SegmentBreak>)> {
        let (clock_ppm, command_ppm) = (self.clock_shift_ppm(), self.command_ppm);
        let reclocked = self.clock_within(RECLOCK_MAX_SE_PPM);
        let switch = self.switch.as_mut()?;
        let probe = switch.probe.estimate(now, ppm);
        // Delivery runs at our clock and the playhead at the speaker's. The
        // drift controller steers by the carried estimate meanwhile, so the
        // correction moves: what it inserted is counted as it went, and the
        // clock, which does not move, is taken at its best estimate yet.
        switch.inserted_ms += command_ppm * 1e-6 * (now - switch.inserted_at).max(0.0);
        switch.inserted_at = switch.inserted_at.max(now);
        let carried = switch.carried;
        let expected =
            carried.reserve_ms - clock_ppm * 1e-6 * (now - carried.at) + switch.inserted_ms;
        let measured = now - switch.at >= CONTINUATION_MEASURE_MS;
        if let Some(probe) = probe.filter(|p| measured && p.tight()) {
            let switch = self.switch.take()?;
            let offset_ms = probe.reserve_ms - expected;
            if (switch.bounds.0..=switch.bounds.1).contains(&offset_ms) {
                // The probe's estimate is a tight one of the level the window
                // carries on at: with ten-minute segments the window itself
                // may make none in the four minutes before the next switch,
                // which would then find no reference to measure from.
                if !switch.absorbs {
                    // Measuring error, a few tens of ms either way: absorbed
                    // at every switch it would add up, a switch at a time.
                    self.reserve.absorb(&switch.probe, 0.0);
                    self.reference.absorb(&switch.probe, 0.0);
                    self.last_tight = Some(probe);
                    self.switch_outcome = Some(SwitchOutcome::Steady { offset_ms });
                    return None;
                }
                self.reserve.absorb(&switch.probe, -offset_ms);
                self.reference.absorb(&switch.probe, -offset_ms);
                self.last_tight = Some(ReserveEstimate {
                    reserve_ms: probe.reserve_ms - offset_ms,
                    ..probe
                });
                self.reserve_offset_ms += offset_ms;
                self.unclocked = (!reclocked).then_some(UnclockedOffset {
                    clock_ppm,
                    span_ms: now - carried.at,
                });
                self.switch_outcome = Some(SwitchOutcome::Absorbed { offset_ms });
                return None;
            }
            // Something the speaker played: an underrun or a skip. The
            // segment ends, and the next one starts from the polls since.
            self.switch_outcome = Some(SwitchOutcome::Rejected { offset_ms });
            self.segment.record_break(SegmentBreak::OffsetStep);
            self.last_acked = previous_acked;
            self.break_segment(SegmentBreak::OffsetStep);
            self.reserve.absorb(&switch.probe, 0.0);
            self.reference.absorb(&switch.probe, 0.0);
            self.last_acked = None;
            self.last = None;
            return Some((None, Some(SegmentBreak::OffsetStep)));
        }
        if now - switch.at > CONTINUATION_SETTLE_MAX_MS {
            // The carried estimate has stood long enough: the new segment's
            // own estimate is reported from here on, uncorrected (and never
            // tight, or it would have been measured), so the alarms and
            // notices watch the speaker again. The drift controller holds on
            // until the offset is measured, since the level it would steer
            // by has a reporting offset in it.
            if !switch.overdue {
                switch.overdue = true;
                self.switch_outcome = Some(SwitchOutcome::Unmeasured(SwitchUnmeasured::NotTight));
            }
            self.last = probe;
            self.last_fresh = probe.is_some();
            return Some((probe, None));
        }
        let est = ReserveEstimate {
            at: now,
            reserve_ms: expected,
            half_width_ms: carried.half_width_ms,
            inconsistent: false,
            jitter_ms: self.reserve.jitter_ms(),
            polls: switch.probe.polls(),
            lock_reason: LockReason::Held,
        };
        self.last = Some(est);
        self.last_fresh = true;
        Some((Some(est), None))
    }

    /// Whether a continuation switch is being measured and the estimate is
    /// the one from before it, carried forward, which says nothing new.
    /// No notice or alarm should be decided from it. Not once the switch has
    /// taken longer than [`CONTINUATION_SETTLE_MAX_MS`] to measure, when the
    /// new segment's own estimate is reported instead.
    pub fn settling(&self) -> bool {
        self.switch.as_ref().is_some_and(|s| !s.overdue)
    }

    /// How the drift controller may use the estimate: as measured, or, while
    /// a switch settles, as carried across it (see [`EstimateCarry`]).
    ///
    /// The carried estimate is the reserve before the switch carried along
    /// the clock and the correction, so nothing of the new segment's offset
    /// is in it, and the controller steers by it: with segments of ten
    /// minutes a switch settles for six of every ten, and a controller held
    /// at its integral meanwhile never caught up with a 45 ppm speaker. It
    /// teaches the integral too, but only once the clock carrying it is
    /// precise (within [`CLOCK_SHIFT_MAX_SE_PPM`]): before that it is carried
    /// along the correction alone, and would teach the integral the opposite
    /// of the speaker's clock.
    pub fn carry(&self) -> EstimateCarry {
        if !self.settling() {
            EstimateCarry::Measured
        } else if self.clock_within(CLOCK_SHIFT_MAX_SE_PPM) {
            EstimateCarry::Teaches
        } else {
            EstimateCarry::Steers
        }
    }

    /// Whether the drift controller should hold: a continuation switch has
    /// been measuring for longer than [`CONTINUATION_SETTLE_MAX_MS`], so the
    /// estimate is the new segment's own, reporting offset and all, or the
    /// reserve has jumped from its baseline and may be an offset step.
    /// Neither is drift, and a step integrated would wind the controller up
    /// for hours. A switch settling within that time does not hold it: the
    /// estimate is the one from before the switch, carried (see
    /// [`Self::carry`]).
    ///
    /// The second covers the estimates before an offset step is confirmed:
    /// the first jumped estimate can be tight, and would teach the integral
    /// part of the step. Once the step is confirmed the segment
    /// breaks and the estimate is unlocked, which holds the controller
    /// anyway. A jump that fades holds it for a report or two, at its
    /// integral, which costs nothing.
    pub fn control_hold(&self) -> bool {
        self.switch.as_ref().is_some_and(|s| s.overdue) || self.segment.step_pending()
    }

    /// What the latest continuation switch came to, once, as soon as it is
    /// known.
    pub fn take_switch_outcome(&mut self) -> Option<SwitchOutcome> {
        self.switch_outcome.take()
    }

    /// Estimates the reserve at `now` (PCM only) and checks it for an offset
    /// step. An estimate that reveals a step is not returned: it mixes the
    /// two sides of the step.
    pub fn estimate(&mut self, now: f64) -> (Option<ReserveEstimate>, Option<SegmentBreak>) {
        self.last_fresh = false;
        // Kept until here so an offset step found below can snapshot it.
        let previous_acked = self.last_acked.take();
        if !self.pcm || self.segment.paused() {
            return (None, None);
        }
        // Shrunk, and only once precise, so a rate from a few short blocks
        // (whose error can be hundreds of ppm) cannot drag the older bounds,
        // or the step baseline, far. Net of the correction applied: inserted
        // audio raises the reserve as the speaker's clock lowers it.
        self.reclock_offset();
        let ppm = self.shift_ppm();
        if let Some(settling) = self.step_switch(now, ppm, previous_acked) {
            return settling;
        }
        let Some(est) = self.reserve.estimate(now, ppm) else {
            return (None, None);
        };
        if let Some(brk) = self.segment.observe_estimate(&est, ppm) {
            self.last_acked = previous_acked;
            self.break_segment(brk);
            self.last_acked = None;
            self.last = None;
            return (None, Some(brk));
        }
        self.last = Some(est);
        self.last_fresh = true;
        if est.tight() {
            self.last_tight = Some(est);
        }
        if est.locked() {
            self.pre_break = None;
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

    /// Combines the estimate just made with how far the speaker's
    /// acknowledgements lagged the delivered count over the same window (at
    /// each pipeline snapshot and each monitor tick), in milliseconds of
    /// audio, and steps the low alarm. With no lag samples (the platform
    /// does not report acknowledgements) the delivered-count estimate stands
    /// in.
    ///
    /// The window's stall (see [`stall_ms`]) is kept whether or not there is
    /// an estimate, so a window that ended in a segment break still has one.
    ///
    /// Returns the acknowledged reserve, or `None` if the latest call to
    /// [`Self::estimate`] produced no estimate. Only a locked estimate
    /// lowers the connection's minimum or moves the alarm, and only a tight
    /// one (see [`LockReason`]) teaches the
    /// target. Overwrites `lags_ms`. Call once after each
    /// [`Self::estimate`], with no lags where none were measured.
    pub fn observe_ack_lag(&mut self, lags_ms: &mut [f64]) -> Option<AckedReserve> {
        let stall = stall_ms(lags_ms);
        // Sorted by the line above.
        let median_lag = median_ms(lags_ms);
        self.last_stall_ms = stall;
        let est = self.last.filter(|_| self.last_fresh)?;
        // The reserve moves by well under a millisecond over a window, so
        // the estimate made at its end holds throughout it.
        for lag in lags_ms.iter_mut() {
            *lag = est.reserve_ms - *lag;
        }
        let acked = match WindowStats::of(lags_ms) {
            Some(r) => AckedReserve {
                min_ms: r.min,
                p10_ms: r.p10,
                median_ms: est.reserve_ms - median_lag.unwrap_or(0.0),
                measured: true,
                stall_ms: stall,
            },
            None => AckedReserve {
                min_ms: est.reserve_ms,
                p10_ms: est.reserve_ms,
                median_ms: est.reserve_ms,
                measured: false,
                stall_ms: None,
            },
        };
        self.last_acked = Some(acked);
        // An estimate carried across a switch has nothing new to say about
        // the level, and the lags alone must not sound the alarm.
        if est.locked() && !self.settling() {
            let c = &mut self.connection;
            c.reserve_min_ms = Some(
                c.reserve_min_ms
                    .map_or(acked.min_ms, |m| m.min(acked.min_ms)),
            );
            c.acked_measured |= acked.measured;
            // A held estimate may be a window straddling a step: it may sound
            // the alarm, but not teach the level the speaker settled at.
            if self.first_segment && self.target_ms.is_none() && est.tight() {
                match self.target_pending.take() {
                    Some(first) => self.target_ms = Some((first + est.reserve_ms) / 2.0),
                    None => self.target_pending = Some(est.reserve_ms),
                }
            }
            let head_start = self.head_start_sent_ms();
            if !self.low && acked.p10_ms < low_floor_ms(head_start) {
                self.low = true;
            } else if self.low && acked.p10_ms >= low_clear_ms(head_start) {
                self.low = false;
            }
        }
        Some(acked)
    }

    /// Whether the acknowledged reserve is low on the current connection:
    /// its 10th percentile over a window fell below [`Self::floor_ms`] and
    /// has not since regained [`Self::clear_ms`].
    pub fn is_low(&self) -> bool {
        self.low
    }

    /// The level the current connection settled at once its head start had
    /// gone out, once learned.
    pub fn target_ms(&self) -> Option<f64> {
        self.target_ms
    }

    /// How far the level the connection settled at lies from the head start
    /// it was sent (`target − H`), once learned: the speaker's own share of
    /// the reserve, which is not counted as delivered, and the estimate's
    /// bias. Expected to sit a few tens of ms below zero.
    pub fn calib_ms(&self) -> Option<f64> {
        let head_start = self.head_start?;
        Some(self.target_ms? - f64::from(head_start.sent_ms))
    }

    /// The speaker head start the current connection was sent, when known.
    pub fn head_start(&self) -> Option<HeadStart> {
        self.head_start
    }

    /// The head start sent, in ms, counting an unknown one as none.
    fn head_start_sent_ms(&self) -> u32 {
        self.head_start.map_or(0, |h| h.sent_ms)
    }

    /// The acknowledged reserve below which the current connection is low
    /// (see [`low_floor_ms`]), or `None` for a compressed connection.
    pub fn floor_ms(&self) -> Option<f64> {
        self.pcm.then(|| low_floor_ms(self.head_start_sent_ms()))
    }

    /// The level a low connection must regain (see [`low_clear_ms`]), or
    /// `None` for a compressed connection.
    pub fn clear_ms(&self) -> Option<f64> {
        self.pcm.then(|| low_clear_ms(self.head_start_sent_ms()))
    }

    /// Stands in for [`Self::observe_ack_lag`] on a window in which the
    /// connection reached, or came near, the end its speaker was told of
    /// (see [`crate::stream::DeclaredEnd`]). Whatever the speaker's
    /// acknowledgements do there is the item ending, so the window has no
    /// stall, and neither the low alarm, the connection's minimum nor its
    /// target moves.
    pub fn observe_declared_end(&mut self) {
        self.last_stall_ms = None;
    }

    /// How far the worst acknowledgement lag of the latest report's window
    /// stood above its median (see [`stall_ms`]), where acknowledgements
    /// were measured.
    pub fn stall_ms(&self) -> Option<f64> {
        self.last_stall_ms
    }

    /// The acknowledged reserve before the current connection's latest
    /// segment break, until the next locked estimate.
    pub fn pre_break(&self) -> Option<PreBreak> {
        self.pre_break
    }

    /// The latest reserve estimate of the current segment.
    pub fn last_estimate(&self) -> Option<&ReserveEstimate> {
        self.last.as_ref()
    }

    /// The acknowledged reserve over the latest report's window, if that
    /// report produced an estimate.
    pub fn last_acked(&self) -> Option<AckedReserve> {
        self.last_acked
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

    /// Seconds until the reserve reaches the low floor at the net rate the
    /// speaker drains it, when the estimate is locked and the speaker is
    /// draining it by more than [`drain_threshold_sigmas`] standard errors;
    /// zero once it is below the floor.
    ///
    /// Projected from the acknowledged reserve's 10th percentile over the
    /// latest window when there is one, the estimate otherwise: the level
    /// the speaker's reserve really held, not the delivered count's.
    ///
    /// The rate is the clock rate shrunk by its uncertainty (see
    /// [`ClockEstimate::shrunk_ppm`]): a rate pooled from a few short
    /// segments can clear the drain test at several times its true value,
    /// and projected unshrunk it would put a speaker hours from the floor
    /// within the half hour [`DRAINING_WARN_SECS`] warns at. A precise rate
    /// passes through almost unchanged. The net rate is that less the audio
    /// drift correction adds (see [`Self::set_command_ppm`]), so a
    /// correction that matches the clock projects nothing, and one pinned at
    /// its cap projects the remainder it cannot make up.
    pub fn time_to_floor_s(&self) -> Option<f64> {
        let est = self.last.filter(|e| e.locked())?;
        if !self.clock_drains() {
            return None;
        }
        let floor = self.floor_ms()?;
        let reserve = self.last_acked.map_or(est.reserve_ms, |a| a.p10_ms);
        let net_ppm = self.net_ppm();
        if net_ppm <= 0.0 {
            return None;
        }
        // ppm·1e-6 ms per ms is ppm·1e-3 ms per second.
        Some((reserve - floor).max(0.0) / (net_ppm * 1e-3))
    }

    /// Whether the speaker plays faster than we deliver, net of any drift
    /// correction applied, by more than [`drain_threshold_sigmas`] standard
    /// errors, whatever the reserve estimate is doing.
    pub fn clock_drains(&self) -> bool {
        self.clock().is_some_and(|c| {
            let net = c.ppm - self.command_ppm;
            net > 0.0 && net > drain_threshold_sigmas(c.dof) * c.se_ppm
        })
    }

    /// The state to report, given what the monitor knows beyond the polls.
    pub fn state(&self, dormant: bool, stale: bool) -> MonitorState {
        if dormant {
            MonitorState::Dormant
        } else if stale {
            MonitorState::Stale
        } else if self.paused() {
            MonitorState::Paused
        } else if self.last.is_some_and(|e| e.locked()) {
            if self.low {
                MonitorState::Low
            } else if self
                .time_to_floor_s()
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
    use super::super::reserve::LockReason;
    use super::super::test_support::PollGen;
    use super::*;

    const URI: &str = "http://10.0.0.1:49400/stream/s/live.wav";

    /// The default head start, sent in full.
    const H500: Option<HeadStart> = Some(HeadStart {
        sent_ms: 500,
        configured_ms: 500,
    });

    /// Polls and estimates every 30 s from `from` to `to`, and returns the
    /// shortest time to the floor projected meanwhile.
    fn run(tracker: &mut ReserveTracker, gen: &mut PollGen, from: f64, to: f64) -> Option<f64> {
        let mut shortest: Option<f64> = None;
        let mut t = from;
        while t < to {
            t += 30_000.0;
            gen.run_until(t, |p| {
                tracker.observe(p, URI, false);
            });
            tracker.estimate(t);
            tracker.observe_ack_lag(&mut []);
            if let Some(s) = tracker.time_to_floor_s() {
                shortest = Some(shortest.map_or(s, |m| m.min(s)));
            }
        }
        shortest
    }

    #[test]
    fn a_draining_speaker_projects_a_time_to_floor() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(41);
        gen.ppm = 300.0;
        run(&mut tracker, &mut gen, 0.0, 15.0 * 60_000.0);
        // Fifteen minutes at 300 ppm is 270 ms drained: about 330 ms left,
        // above the 150 ms floor but due to reach it within half an hour.
        assert_eq!(tracker.state(false, false), MonitorState::Draining);
        assert!(tracker.clock_drains());
        let ttf = tracker.time_to_floor_s().expect("draining");
        let truth = (gen.reserve(15.0 * 60_000.0) - 150.0) / 0.3;
        // Within what the estimate's own error (tens of ms) moves it.
        assert!((ttf - truth).abs() < 60.0 / 0.3, "{ttf:.0}s vs {truth:.0}s");
        let c = tracker.connection();
        assert!(c.reserve_min_ms.unwrap() < c.reserve_start_ms.unwrap());
        // What the clock drained over the connection: about the 270 ms the
        // reserve lost, less what shrinking the rate takes off it.
        let drained = tracker.clock_drained_ms();
        assert!((200.0..=300.0).contains(&drained), "{drained:.0}ms");
    }

    #[test]
    fn a_steady_speaker_projects_nothing() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(43);
        run(&mut tracker, &mut gen, 0.0, 30.0 * 60_000.0);
        assert_eq!(tracker.time_to_floor_s(), None);
        assert!(!tracker.clock_drains());
        assert_eq!(tracker.clock_drained_ms(), 0.0);
        assert_eq!(tracker.state(false, false), MonitorState::Ok);
    }

    /// A speaker 300 ppm fast whose delivery drift correction speeds up by
    /// the same: its reserve holds level, so nothing drains and nothing is
    /// projected, and the estimate follows the flat reserve rather than
    /// carrying older bounds down the clock rate.
    #[test]
    fn ttf_is_none_when_correction_matches_the_clock() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        tracker.set_command_ppm(300.0);
        let mut gen = PollGen::new(47);
        gen.ppm = 300.0;
        gen.inserted_per_ms = 300e-6;
        run(&mut tracker, &mut gen, 0.0, 30.0 * 60_000.0);
        let clock = tracker.clock().expect("clock");
        assert!((clock.ppm - 300.0).abs() < 60.0, "{clock:?}");
        assert!(!tracker.clock_drains());
        assert_eq!(tracker.time_to_floor_s(), None);
        assert_eq!(tracker.state(false, false), MonitorState::Ok);
        let est = tracker.last_estimate().expect("estimate");
        let truth = gen.reserve(30.0 * 60_000.0);
        assert!(
            (est.reserve_ms - truth).abs() < 50.0,
            "{est:?} vs {truth:.0}"
        );
    }

    /// A speaker 400 ppm fast with the correction pinned at 150 ppm drains
    /// at the 250 ppm it cannot make up, and the time to the floor is
    /// projected on that.
    #[test]
    fn saturated_ttf_uses_the_uncorrected_remainder() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        tracker.set_command_ppm(150.0);
        let mut gen = PollGen::new(53);
        gen.ppm = 400.0;
        gen.inserted_per_ms = 150e-6;
        run(&mut tracker, &mut gen, 0.0, 15.0 * 60_000.0);
        let ttf = tracker.time_to_floor_s().expect("draining");
        let truth = (gen.reserve(15.0 * 60_000.0) - 150.0) / 0.25;
        assert!(
            (ttf - truth).abs() < 60.0 / 0.25,
            "{ttf:.0}s vs {truth:.0}s"
        );
    }

    #[test]
    fn a_new_connection_breaks_the_segment_and_resets_its_stats() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(47);
        run(&mut tracker, &mut gen, 0.0, 10.0 * 60_000.0);
        assert!(tracker.connection().polls > 0);
        assert_eq!(tracker.connection_breaks(SegmentBreak::NewConnection), 0);
        assert!(tracker.connection_estimate_counts().0 > 0);
        tracker.start_connection(true, H500);
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
        tracker.start_connection(false, None);
        let mut gen = PollGen::new(53);
        gen.ppm = -40.0;
        run(&mut tracker, &mut gen, 0.0, 10.0 * 60_000.0);
        assert_eq!(tracker.last_estimate(), None);
        assert!(tracker.clock().is_some());
    }

    #[test]
    fn a_paused_speaker_is_not_measured() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
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
    /// the shortest time to the floor ever projected.
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
            tracker.start_connection(true, H500);
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
                // +40 ppm takes a 600 ms reserve to the floor in about three
                // hours: it must never be projected inside the half hour the
                // monitor warns at.
                assert!(
                    shortest.map_or(true, |s| s > DRAINING_WARN_SECS),
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
                assert!(
                    s > DRAINING_WARN_SECS,
                    "seed {seed}: projected at the floor in {s:.0}s"
                );
                projected.push((seed, s));
            }
        }
        assert!(projected.len() <= 1, "{projected:?}");
    }

    /// Polls and estimates every 30 s from `from` to `to` like [`run`],
    /// handing the tracker `lags(t)` as each window's acknowledgement lags.
    /// Returns the acknowledged reserve and whether the speaker was low
    /// after each report.
    fn run_acked(
        tracker: &mut ReserveTracker,
        gen: &mut PollGen,
        from: f64,
        to: f64,
        lags: impl Fn(f64) -> Vec<f64>,
    ) -> Vec<(Option<AckedReserve>, bool)> {
        let mut out = Vec::new();
        let mut t = from;
        while t < to {
            t += 30_000.0;
            gen.run_until(t, |p| {
                tracker.observe(p, URI, false);
            });
            tracker.estimate(t);
            let acked = tracker.observe_ack_lag(&mut lags(t));
            out.push((acked, tracker.is_low()));
        }
        out
    }

    /// Sixty snapshots of a clean link: a few milliseconds unacknowledged.
    fn clean(_t: f64) -> Vec<f64> {
        (0..60).map(|i| f64::from(i % 5)).collect()
    }

    #[test]
    fn the_target_is_the_first_two_tight_estimates_and_relearned_per_connection() {
        // Unmeasured acknowledgements: the estimates themselves.
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(61);
        let mut tight = Vec::new();
        let mut t = 0.0;
        while tight.len() < 2 {
            t += 30_000.0;
            gen.run_until(t, |p| {
                tracker.observe(p, URI, false);
            });
            if let (Some(e), _) = tracker.estimate(t) {
                if e.tight() {
                    tight.push(e.reserve_ms);
                }
            }
            tracker.observe_ack_lag(&mut []);
            if tight.len() < 2 {
                assert_eq!(tracker.target_ms(), None, "at {t}");
            }
        }
        let target = tracker.target_ms().expect("learned");
        assert_eq!(target, (tight[0] + tight[1]) / 2.0);
        assert!(
            (target - gen.reserve(t)).abs() < 60.0,
            "{target} vs {}",
            gen.reserve(t)
        );

        assert_eq!(tracker.calib_ms(), Some(target - 500.0));

        // A reconnect gets its own head start, so it learns its own level.
        tracker.start_connection(
            true,
            Some(HeadStart {
                sent_ms: 250,
                configured_ms: 500,
            }),
        );
        assert_eq!(tracker.target_ms(), None);
        let mut gen = PollGen::new(62);
        gen.start_ms = 300.0;
        run(&mut tracker, &mut gen, 0.0, 10.0 * 60_000.0);
        let second = tracker.target_ms().expect("relearned");
        assert!((second - 300.0).abs() < 60.0, "{second}");
        assert_eq!(tracker.calib_ms(), Some(second - 250.0));
    }

    #[test]
    fn a_segment_break_before_the_second_tight_estimate_leaves_no_target() {
        // Only the connection's first segment starts from its head start;
        // a later one starts from wherever the break left the reserve.
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        tracker.target_pending = Some(10_000.0);
        tracker.clear();
        let mut gen = PollGen::new(63);
        run(&mut tracker, &mut gen, 0.0, 10.0 * 60_000.0);
        assert_eq!(tracker.target_ms(), None);
        assert_eq!(tracker.calib_ms(), None);
        assert!(tracker.last_estimate().is_some_and(|e| e.locked()));
    }

    #[test]
    fn straddling_window_does_not_teach_target() {
        // The first tight window has been seen; the next estimate is held,
        // as one whose window straddles a step is. It still counts towards
        // the connection's minimum, but must not finish the target.
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        tracker.target_pending = Some(500.0);
        tracker.last = Some(ReserveEstimate {
            at: 300_000.0,
            reserve_ms: 300.0,
            half_width_ms: 180.0,
            inconsistent: false,
            jitter_ms: 150.0,
            polls: 72,
            lock_reason: LockReason::Held,
        });
        tracker.last_fresh = true;
        tracker
            .observe_ack_lag(&mut [])
            .expect("acknowledged reserve");
        assert_eq!(tracker.target_ms(), None);
        assert_eq!(tracker.target_pending, Some(500.0));
        assert_eq!(tracker.connection().reserve_min_ms, Some(300.0));

        // A tight one does.
        tracker.last = tracker.last.map(|e| ReserveEstimate {
            reserve_ms: 520.0,
            half_width_ms: 60.0,
            lock_reason: LockReason::Tight,
            ..e
        });
        tracker.last_fresh = true;
        tracker.observe_ack_lag(&mut []);
        assert_eq!(tracker.target_ms(), Some(510.0));
    }

    #[test]
    fn acknowledgement_lag_lowers_the_reserve_minimum_but_not_the_estimate() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(67);
        let reports = run_acked(&mut tracker, &mut gen, 0.0, 10.0 * 60_000.0, |t| {
            let mut lags = clean(t);
            // One 250 ms retransmission stall five minutes in.
            if t == 300_000.0 {
                lags[30] = 250.0;
            }
            lags
        });
        let est = tracker.last_estimate().copied().expect("estimated");
        let (acked, low) = reports.last().copied().unwrap();
        let acked = acked.expect("acked");
        assert!(acked.measured);
        assert_eq!(acked.min_ms, est.reserve_ms - 4.0);
        assert_eq!(acked.p10_ms, est.reserve_ms - 4.0);
        assert!(!low);
        let c = tracker.connection();
        assert!(c.acked_measured);
        let min = c.reserve_min_ms.unwrap();
        assert!(
            min < c.reserve_end_ms.unwrap() - 200.0,
            "the stall shows in the minimum: {min} vs {:?}",
            c.reserve_end_ms
        );
    }

    #[test]
    fn without_acknowledgements_the_delivered_estimate_stands_in() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(71);
        let reports = run_acked(&mut tracker, &mut gen, 0.0, 5.0 * 60_000.0, |_| Vec::new());
        let est = tracker.last_estimate().copied().unwrap();
        let acked = reports.last().unwrap().0.unwrap();
        assert!(!acked.measured);
        assert_eq!(
            (acked.min_ms, acked.p10_ms),
            (est.reserve_ms, est.reserve_ms)
        );
        assert!(!tracker.connection().acked_measured);
    }

    #[test]
    fn no_estimate_means_no_acknowledged_reserve() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        tracker.estimate(30_000.0);
        assert_eq!(tracker.observe_ack_lag(&mut clean(0.0)), None);
        tracker.start_connection(false, None);
        let mut gen = PollGen::new(73);
        let reports = run_acked(&mut tracker, &mut gen, 0.0, 5.0 * 60_000.0, clean);
        assert!(reports.iter().all(|(a, _)| a.is_none()), "compressed");
    }

    #[test]
    fn the_low_alarm_follows_the_acknowledged_reserve_with_hysteresis() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(79);
        run_acked(&mut tracker, &mut gen, 0.0, 6.0 * 60_000.0, clean);
        let (floor, clear) = (low_floor_ms(500), low_clear_ms(500));
        assert_eq!(
            (tracker.floor_ms(), tracker.clear_ms()),
            (Some(floor), Some(clear))
        );
        assert_eq!(tracker.state(false, false), MonitorState::Ok);
        // One report 30 s on whose acknowledged reserve dipped to `level`.
        let mut t = 6.0 * 60_000.0;
        let mut dip_to = |tracker: &mut ReserveTracker, level: f64| {
            t += 30_000.0;
            gen.run_until(t, |p| {
                tracker.observe(p, URI, false);
            });
            let est = tracker.estimate(t).0.expect("estimated");
            assert!(est.locked());
            // A tenth of the window at `level`, the rest clean.
            let mut lags: Vec<f64> = (0..60)
                .map(|i| if i < 6 { est.reserve_ms - level } else { 0.0 })
                .collect();
            let acked = tracker.observe_ack_lag(&mut lags);
            assert_eq!(acked.unwrap().p10_ms, level);
            tracker.is_low()
        };

        assert!(
            !dip_to(&mut tracker, floor + 20.0),
            "a dip to just above the floor is not low"
        );
        assert!(
            dip_to(&mut tracker, floor - 20.0),
            "below it the speaker is low, though the estimate is not"
        );
        assert_eq!(tracker.state(false, false), MonitorState::Low);
        assert!(
            dip_to(&mut tracker, clear - 20.0),
            "recovering into the hysteresis band is not enough"
        );
        assert!(
            !dip_to(&mut tracker, clear + 20.0),
            "regaining the clear level is"
        );
        assert_eq!(tracker.state(false, false), MonitorState::Ok);

        // Low again, then a reconnect: the alarm is the connection's.
        assert!(dip_to(&mut tracker, floor - 20.0));
        tracker.start_connection(true, H500);
        assert!(!tracker.is_low());
    }

    #[test]
    fn a_single_retransmission_stall_is_not_low() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(83);
        let reports = run_acked(&mut tracker, &mut gen, 0.0, 10.0 * 60_000.0, |t| {
            let mut lags = clean(t);
            // One snapshot caught a 500 ms stall five minutes in.
            if t == 300_000.0 {
                lags[30] = 500.0;
            }
            lags
        });
        let (acked, low) = reports[9];
        let acked = acked.expect("acked");
        assert!(
            acked.min_ms < low_floor_ms(500),
            "the stall shows in the minimum: {}",
            acked.min_ms
        );
        assert!(!low, "but one snapshot of a window does not make it low");
        assert!(reports.iter().all(|(_, low)| !low));
    }

    #[test]
    fn a_steady_acknowledgement_lag_is_not_low() {
        // The speaker's receive window held partly closed throughout: the
        // acknowledged reserve sits 200 ms under the estimate from the start,
        // still well above the floor. The target is the estimate's level.
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(89);
        let reports = run_acked(&mut tracker, &mut gen, 0.0, 10.0 * 60_000.0, |t| {
            clean(t).into_iter().map(|lag| lag + 200.0).collect()
        });
        let est = tracker.last_estimate().copied().expect("estimated");
        let target = tracker.target_ms().expect("learned");
        assert!(
            (target - est.reserve_ms).abs() < 60.0,
            "{target} vs {}",
            est.reserve_ms
        );
        assert!(reports.iter().all(|(_, low)| !low), "{reports:?}");
        let acked = reports.last().unwrap().0.unwrap();
        assert_eq!(acked.stall_ms, Some(2.0), "the steady lag is no stall");
    }

    #[test]
    fn time_to_floor_is_projected_from_the_acknowledged_reserve() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(41);
        gen.ppm = 300.0;
        run(&mut tracker, &mut gen, 0.0, 15.0 * 60_000.0);
        let delivered = tracker.time_to_floor_s().expect("draining");
        // Acknowledgements lag by 100 ms nine tenths of the time.
        let mut lags: Vec<f64> = (0..60).map(|i| if i < 6 { 0.0 } else { 100.0 }).collect();
        let acked = tracker.observe_ack_lag(&mut lags).unwrap();
        let est = tracker.last_estimate().unwrap().reserve_ms;
        assert_eq!(acked.p10_ms, est - 100.0);
        let projected = tracker.time_to_floor_s().expect("draining");
        // 100 ms sooner at the projected rate (about 0.3 ms/s).
        let ppm = tracker.clock().unwrap().shrunk_ppm();
        assert!(
            (delivered - projected - 100.0 / (ppm * 1e-3)).abs() < 1e-6,
            "{delivered} vs {projected}"
        );
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
            tracker.start_connection(true, H500);
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

    /// One report on a locked estimate whose window's acknowledgement lags
    /// are `lags`, on top of whatever the tracker holds. Returns the
    /// acknowledged reserve.
    fn report_with(tracker: &mut ReserveTracker, reserve_ms: f64, lags: &[f64]) -> AckedReserve {
        tracker.last = Some(ReserveEstimate {
            at: 300_000.0,
            reserve_ms,
            half_width_ms: 60.0,
            inconsistent: false,
            jitter_ms: 30.0,
            polls: 72,
            lock_reason: LockReason::Tight,
        });
        tracker.last_fresh = true;
        tracker
            .observe_ack_lag(&mut lags.to_vec())
            .expect("acknowledged reserve")
    }

    #[test]
    fn floor_scales_with_head_start() {
        assert_eq!(low_floor_ms(0), 40.0);
        assert_eq!(low_floor_ms(250), 75.0);
        assert_eq!(low_floor_ms(500), 150.0);
        assert_eq!(low_floor_ms(2000), 150.0);
        assert_eq!(low_clear_ms(0), 70.0);
        assert_eq!(low_clear_ms(250), 125.0);
        assert_eq!(low_clear_ms(500), 250.0);
        assert_eq!(low_clear_ms(2000), 250.0);

        // Sized from what was sent, not what was configured; an unknown head
        // start counts as none, and a compressed connection has no floor.
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(
            true,
            Some(HeadStart {
                sent_ms: 250,
                configured_ms: 500,
            }),
        );
        assert_eq!(tracker.floor_ms(), Some(75.0));
        tracker.start_connection(true, None);
        assert_eq!(tracker.floor_ms(), Some(40.0));
        tracker.start_connection(false, H500);
        assert_eq!((tracker.floor_ms(), tracker.head_start()), (None, None));
    }

    #[test]
    fn low_fires_below_absolute_floor_without_a_target() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        assert_eq!(tracker.target_ms(), None);
        // The first locked estimate, already below the floor: no settled
        // level is needed to call that low.
        report_with(&mut tracker, 120.0, &[0.0; 60]);
        assert!(tracker.is_low());
    }

    #[test]
    fn a_500ms_reserve_dipping_to_350_is_not_low() {
        // Low against the level it settled at under the old relative alarm;
        // with 350 ms still in hand it is nowhere near cutting out.
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        report_with(&mut tracker, 500.0, &[0.0; 60]);
        report_with(&mut tracker, 500.0, &[0.0; 60]);
        assert_eq!(tracker.target_ms(), Some(500.0));
        let lags: Vec<f64> = (0..60).map(|i| if i < 10 { 150.0 } else { 0.0 }).collect();
        let acked = report_with(&mut tracker, 500.0, &lags);
        assert_eq!(acked.p10_ms, 350.0);
        assert!(!tracker.is_low());
    }

    #[test]
    fn field_minus_21ms_is_low_with_burst_off() {
        // The field log of 2026-09-28: burst off, the acknowledged reserve's
        // 10th percentile at -21 ms, the speaker cutting out.
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(
            true,
            Some(HeadStart {
                sent_ms: 0,
                configured_ms: 0,
            }),
        );
        let lags: Vec<f64> = (0..60).map(|i| if i < 10 { 91.0 } else { 20.0 }).collect();
        let acked = report_with(&mut tracker, 70.0, &lags);
        assert_eq!(acked.p10_ms, -21.0);
        assert!(tracker.is_low());
        assert_eq!(tracker.floor_ms(), Some(40.0));
    }

    #[test]
    fn time_to_floor_not_time_to_zero() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(41);
        gen.ppm = 300.0;
        run(&mut tracker, &mut gen, 0.0, 12.0 * 60_000.0);
        let ttf = tracker.time_to_floor_s().expect("draining");
        let reserve = tracker.last_estimate().unwrap().reserve_ms;
        let ppm = tracker.clock().unwrap().shrunk_ppm();
        let to_zero = reserve / (ppm * 1e-3);
        assert!(
            (to_zero - ttf - 150.0 / (ppm * 1e-3)).abs() < 1e-6,
            "{ttf} vs {to_zero}"
        );
    }

    #[test]
    fn ttf_clamps_to_zero_below_floor() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(41);
        gen.ppm = 300.0;
        run(&mut tracker, &mut gen, 0.0, 12.0 * 60_000.0);
        assert!(tracker.time_to_floor_s().is_some_and(|s| s > 0.0));
        // Acknowledgements lag the estimate by far more than it holds.
        let est = tracker.last_estimate().unwrap().reserve_ms;
        tracker.last_fresh = true;
        tracker.observe_ack_lag(&mut [est; 60]);
        assert_eq!(tracker.time_to_floor_s(), Some(0.0));
    }

    #[test]
    fn stall_ms_excludes_steady_lag() {
        // 40 ms always in flight, and one snapshot 130 ms behind that.
        let mut lags = vec![40.0; 60];
        lags[17] = 170.0;
        assert_eq!(stall_ms(&mut lags), Some(130.0));
        assert_eq!(stall_ms(&mut [25.0; 10]), Some(0.0));
        assert_eq!(stall_ms(&mut []), None);

        // Kept for a window with no estimate too.
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        tracker.estimate(30_000.0);
        let mut lags = vec![10.0, 10.0, 10.0, 210.0];
        assert_eq!(tracker.observe_ack_lag(&mut lags), None);
        assert_eq!(tracker.stall_ms(), Some(200.0));
    }

    #[test]
    fn pre_break_snapshot_survives_segment_break() {
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut gen = PollGen::new(97);
        gen.steps = vec![(6.0 * 60_000.0, -300.0)];
        let mut t = 0.0;
        let (mut before, mut before_locked) = (None, false);
        let brk = loop {
            t += 30_000.0;
            assert!(t < 12.0 * 60_000.0, "the step breaks the segment");
            gen.run_until(t, |p| {
                tracker.observe(p, URI, false);
            });
            let (est, brk) = tracker.estimate(t);
            // A 150 ms stall in every window.
            let mut lags = clean(t);
            lags[40] = 150.0;
            let acked = tracker.observe_ack_lag(&mut lags);
            if brk.is_some() {
                assert_eq!(acked, None, "the break clears the estimate");
                break brk;
            }
            before = acked;
            before_locked = est.is_some_and(|e| e.locked());
        };
        assert_eq!(brk, Some(SegmentBreak::OffsetStep));
        let pre = tracker.pre_break().expect("kept");
        assert_eq!(pre.reason, SegmentBreak::OffsetStep);
        assert_eq!(Some(pre.acked), before);
        assert_eq!(pre.locked, before_locked);
        assert_eq!(pre.acked.stall_ms, Some(148.0));
        assert_eq!(tracker.stall_ms(), Some(148.0), "the breaking window's own");

        // Kept until the next locked estimate, and never across connections.
        run(&mut tracker, &mut gen, t, t + 6.0 * 60_000.0);
        assert!(tracker.last_estimate().is_some_and(|e| e.locked()));
        assert_eq!(tracker.pre_break(), None);
        tracker.pre_break = Some(pre);
        tracker.start_connection(true, H500);
        assert_eq!(tracker.pre_break(), None);
    }

    /// The first segment: told to play.
    const SEG0: PlayoutTimeline = PlayoutTimeline {
        start: 0,
        entry: TimelineEntry::Played,
    };

    /// A later segment moved on to gaplessly, starting at output byte `n`.
    fn next(n: u64) -> PlayoutTimeline {
        PlayoutTimeline {
            start: n,
            entry: TimelineEntry::Next,
        }
    }

    /// One report of a switch scenario.
    #[derive(Debug, Clone, Copy)]
    struct SwitchReport {
        at: f64,
        est: Option<ReserveEstimate>,
        brk: Option<SegmentBreak>,
        outcome: Option<SwitchOutcome>,
        settling: bool,
        integral: f64,
        command: f64,
        hold: super::super::control::ControlHold,
    }

    /// A +19 ppm speaker whose drift controller has learnt its clock,
    /// polled on segment 0 and then, from each `(at, timeline, offset_ms)`
    /// of `switches`, on `timeline`, where the speaker counts RelTime
    /// `offset_ms` further behind the audio than before (the reserve reads
    /// that much higher). The controller steps at every report and its
    /// command is inserted into the delivered audio, as in the monitor.
    /// Reports every 30 s for `minutes`.
    fn switching(
        seed: u64,
        switches: &[(f64, PlayoutTimeline, f64)],
        minutes: f64,
    ) -> Vec<SwitchReport> {
        switching_answered(seed, switches, minutes, |_, _| true)
    }

    /// [`switching`], with only the polls `answered` keeps (by when they
    /// were sent and their index) reaching the tracker.
    fn switching_answered(
        seed: u64,
        switches: &[(f64, PlayoutTimeline, f64)],
        minutes: f64,
        answered: impl Fn(f64, usize) -> bool,
    ) -> Vec<SwitchReport> {
        use super::super::control::{
            ControlInput, DriftController, DriftMode, SpeakerControlState,
        };
        let mut gen = PollGen::new(seed);
        gen.start_ms = 500.0;
        gen.ppm = 19.0;
        gen.inserted_per_ms = 19e-6;
        gen.tick_jitter_ms = 25.0;
        gen.steps = switches
            .iter()
            .map(|(at, _, offset)| (*at, -*offset))
            .collect();
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        tracker.set_command_ppm(19.0);
        let mut controller = DriftController::new(SpeakerControlState {
            integral_ppm: 19.0,
            seeded: true,
            ..SpeakerControlState::default()
        });
        controller.start_connection(DriftMode::On, true);
        let mut out = Vec::new();
        let mut t = 0.0;
        let mut index = 0;
        while t < minutes * 60_000.0 {
            t += 30_000.0;
            gen.run_until(t, |p| {
                index += 1;
                if !answered(p.ts, index) {
                    return;
                }
                // The segment a poll lands on is the one the speaker was
                // playing when it read its playhead, about when it was sent.
                let timeline = switches
                    .iter()
                    .rev()
                    .find(|(at, _, _)| p.ts >= *at)
                    .map_or(SEG0, |(_, tl, _)| *tl);
                tracker.observe_on(p, URI, false, Some(timeline));
            });
            let (est, brk) = tracker.estimate(t);
            tracker.observe_ack_lag(&mut []);
            controller.update(&ControlInput {
                now_s: t / 1000.0,
                estimate: est,
                target_ms: tracker.target_ms(),
                head_start_ms: Some(500),
                clock: tracker.clock(),
                stale: false,
                settling: tracker.control_hold(),
                carry: tracker.carry(),
            });
            tracker.set_command_ppm(controller.applied_ppm());
            gen.inserted_changes
                .push((t, controller.applied_ppm() * 1e-6));
            out.push(SwitchReport {
                at: t,
                est,
                brk,
                outcome: tracker.take_switch_outcome(),
                settling: tracker.settling(),
                integral: controller.integral_ppm(),
                command: controller.command_ppm(),
                hold: controller.hold(),
            });
        }
        out
    }

    /// The mean reserve of the locked estimates from `from` to `to`.
    fn mean_reserve(reports: &[SwitchReport], from: f64, to: f64) -> f64 {
        let levels: Vec<f64> = reports
            .iter()
            .filter(|r| r.at > from && r.at <= to)
            .filter_map(|r| r.est.filter(|e| e.locked()))
            .map(|e| e.reserve_ms)
            .collect();
        assert!(!levels.is_empty());
        levels.iter().sum::<f64>() / levels.len() as f64
    }

    #[test]
    fn a_continuation_switch_reporting_offset_is_absorbed() {
        use super::super::control::ControlHold;
        const MINUTE: f64 = 60_000.0;
        let switch_at = 40.0 * MINUTE + 7_000.0;
        for offset in [110.0, 210.0] {
            for seed in 0..8 {
                let reports = switching(900 + seed, &[(switch_at, next(1 << 32), offset)], 80.0);
                // The same speaker never switching, for comparison: the
                // estimates wander by tens of ms over an hour, and the open
                // loop's integral with them.
                let unswitched = switching(900 + seed, &[], 80.0);
                let ctx = format!("{offset} ms, seed {seed}");
                let outcomes: Vec<SwitchOutcome> =
                    reports.iter().filter_map(|r| r.outcome).collect();
                assert_eq!(outcomes.len(), 1, "{ctx}: {outcomes:?}");
                let SwitchOutcome::Absorbed { offset_ms } = outcomes[0] else {
                    panic!("{ctx}: {outcomes:?}");
                };
                assert!(
                    (offset_ms - offset).abs() < 50.0,
                    "{ctx}: measured {offset_ms:.0}"
                );
                assert!(
                    reports.iter().all(|r| r.brk.is_none()),
                    "{ctx}: {reports:?}"
                );

                // The reserve reads on at its level, whatever the new
                // segment's RelTime says, and never loses its lock.
                assert!(
                    reports
                        .iter()
                        .filter(|r| r.at > 5.0 * MINUTE)
                        .all(|r| r.est.is_some_and(|e| e.locked())),
                    "{ctx}: {reports:?}"
                );
                let after = mean_reserve(&reports, switch_at + 8.0 * MINUTE, 80.0 * MINUTE);
                let level = mean_reserve(&unswitched, switch_at + 8.0 * MINUTE, 80.0 * MINUTE);
                // Within what measuring the offset allows: each side's level
                // is good to about ±20 ms at this tick jitter.
                assert!(
                    (after - level).abs() < 35.0,
                    "{ctx}: {after:.0} against {level:.0} unswitched"
                );

                // Until the new segment's estimate is tight and corrected, the
                // controller steers by the estimate from before the switch,
                // carried on, which has none of the step in it; and it learns
                // nothing from the step after.
                let last_before = reports
                    .iter()
                    .rposition(|r| r.at <= switch_at)
                    .expect("reports before");
                let settled = reports
                    .iter()
                    .position(|r| r.at > switch_at && !r.settling)
                    .expect("settles");
                assert!(settled > last_before + 1, "{ctx}: settled at once");
                // The speaker's clock is matched, so the carried estimate
                // barely moves, and it stays at the level before the switch,
                // not the one the step would read.
                let before = mean_reserve(&reports, switch_at - 6.0 * MINUTE, switch_at);
                let first = reports[last_before + 1].est.expect("carried").reserve_ms;
                for r in &reports[last_before + 1..settled] {
                    assert!(r.settling, "{ctx}: {r:?}");
                    assert_eq!(r.hold, ControlHold::Carried, "{ctx}");
                    let carried = r.est.expect("carried");
                    assert_eq!(carried.lock_reason, LockReason::Held, "{ctx}");
                    assert!(
                        (carried.reserve_ms - before).abs() < offset / 2.0
                            && (carried.reserve_ms - first).abs() < 10.0,
                        "{ctx}: carried {carried:?} against {before:.0} before"
                    );
                }
                // Nor after: over the next 10 min the integral keeps within a
                // few ppm of the unswitched run's (at most 3.5 in these runs;
                // with the step integrated it was 17-41 ppm off 20 min after
                // the switch). By the end it may be further off, since an
                // error in measuring the offset (up to about 35 ms) is a
                // step to the controller too, which it steers out over the
                // following 40 min (at most 12 ppm here; 23-56 unfixed).
                for (r, u) in reports.iter().zip(&unswitched).filter(|(r, _)| {
                    r.at > switch_at && r.at <= reports[settled].at + 10.0 * MINUTE
                }) {
                    assert!(
                        (r.integral - u.integral).abs() < 5.0,
                        "{ctx}: integral {:+.1} ppm against {:+.1} unswitched at {}",
                        r.integral,
                        u.integral,
                        r.at
                    );
                }
                let (i, unswitched_i) = (
                    reports.last().unwrap().integral,
                    unswitched.last().unwrap().integral,
                );
                assert!(
                    (i - unswitched_i).abs() < 15.0,
                    "{ctx}: integral {i:+.1} ppm against {unswitched_i:+.1} unswitched"
                );
            }
        }
    }

    #[test]
    fn a_later_switch_with_no_offset_changes_nothing() {
        const MINUTE: f64 = 60_000.0;
        let (first, second) = (30.0 * MINUTE + 3_000.0, 60.0 * MINUTE + 11_000.0);
        let reports = switching(
            950,
            &[(first, next(1 << 32), 110.0), (second, next(2 << 32), 0.0)],
            90.0,
        );
        let outcomes: Vec<SwitchOutcome> = reports.iter().filter_map(|r| r.outcome).collect();
        assert_eq!(outcomes.len(), 2, "{outcomes:?}");
        // Measuring error, and left alone: absorbed at every switch it would
        // add up.
        let SwitchOutcome::Steady { offset_ms } = outcomes[1] else {
            panic!("{outcomes:?}");
        };
        assert!(offset_ms.abs() < 50.0, "measured {offset_ms:.0}");
        let before = mean_reserve(&reports, 45.0 * MINUTE, second);
        let after = mean_reserve(&reports, second + 10.0 * MINUTE, 90.0 * MINUTE);
        assert!((after - before).abs() < 25.0, "{before:.0} then {after:.0}");
        assert!(reports.iter().all(|r| r.brk.is_none()), "{reports:?}");
    }

    #[test]
    fn a_step_beyond_a_reporting_offset_at_a_switch_is_not_absorbed() {
        const MINUTE: f64 = 60_000.0;
        let switch_at = 40.0 * MINUTE + 7_000.0;
        for (seed, offset) in [(960, 500.0), (961, -300.0)] {
            let reports = switching(seed, &[(switch_at, next(1 << 32), offset)], 60.0);
            let outcomes: Vec<SwitchOutcome> = reports.iter().filter_map(|r| r.outcome).collect();
            assert!(
                matches!(outcomes[..], [SwitchOutcome::Rejected { offset_ms }]
                    if (offset_ms - offset).abs() < 60.0),
                "{offset}: {outcomes:?}"
            );
            let breaks: Vec<SegmentBreak> = reports.iter().filter_map(|r| r.brk).collect();
            assert_eq!(breaks, [SegmentBreak::OffsetStep], "{offset}");
            // Measured afresh from the polls since the switch: the reserve
            // reads the step at once (and the controller then steers it).
            let before = mean_reserve(&reports, 20.0 * MINUTE, switch_at);
            let broke = reports.iter().position(|r| r.brk.is_some()).unwrap();
            let after = reports[broke + 1..]
                .iter()
                .find_map(|r| r.est.filter(|e| e.locked()))
                .expect("locked again");
            assert!(
                after.at - reports[broke].at <= 30_000.0,
                "{offset}: locked again only at {after:?}"
            );
            assert!(
                (after.reserve_ms - before - offset).abs() < 60.0,
                "{offset}: {before:.0} then {after:?}"
            );
        }
    }

    #[test]
    fn a_switch_slow_to_measure_keeps_the_controller_holding() {
        use super::super::control::ControlHold;
        const MINUTE: f64 = 60_000.0;
        let switch_at = 30.0 * MINUTE + 5_000.0;
        let answered_again = switch_at + 20.0 * MINUTE;
        // After the switch most polls go unanswered for 20 min, so the new
        // segment's polls give no tight estimate in time.
        let reports =
            switching_answered(1200, &[(switch_at, next(1 << 32), 110.0)], 60.0, |ts, i| {
                ts < switch_at || ts >= answered_again || i % 12 == 0
            });
        let unswitched = switching(1200, &[], 60.0);
        let outcomes: Vec<(f64, SwitchOutcome)> = reports
            .iter()
            .filter_map(|r| r.outcome.map(|o| (r.at, o)))
            .collect();
        let [(overdue_at, SwitchOutcome::Unmeasured(SwitchUnmeasured::NotTight)), (measured_at, SwitchOutcome::Absorbed { offset_ms })] =
            outcomes[..]
        else {
            panic!("{outcomes:?}");
        };
        assert!(overdue_at > switch_at + CONTINUATION_SETTLE_MAX_MS);
        assert!(measured_at > answered_again, "{measured_at}");
        assert!((offset_ms - 110.0).abs() < 50.0, "measured {offset_ms:.0}");
        assert!(reports.iter().all(|r| r.brk.is_none()), "{reports:?}");

        // The controller steers by the carried estimate until the switch is
        // overdue; then the new segment's own estimate, offset and all, is
        // reported, and the controller holds at its integral, the command
        // at it from the first report, learning nothing until the offset is
        // measured.
        let last_carried = reports.iter().rposition(|r| r.at < overdue_at).unwrap();
        let frozen = reports[last_carried].integral;
        for r in reports
            .iter()
            .filter(|r| r.at > switch_at && r.at < measured_at)
        {
            assert_eq!(r.settling, r.at < overdue_at, "{r:?}");
            if r.at < overdue_at {
                assert_eq!(r.hold, ControlHold::Carried, "{r:?}");
            } else {
                assert_eq!(r.hold, ControlHold::Settling, "{r:?}");
                assert_eq!(r.integral, frozen, "{r:?}");
                assert_eq!(r.command, frozen, "{r:?}");
                assert!(r.est.is_none_or(|e| !e.tight()), "{r:?}");
            }
        }
        let after = mean_reserve(&reports, measured_at + 5.0 * MINUTE, 60.0 * MINUTE);
        let level = mean_reserve(&unswitched, measured_at + 5.0 * MINUTE, 60.0 * MINUTE);
        assert!(
            (after - level).abs() < 35.0,
            "{after:.0} against {level:.0}"
        );
    }

    #[test]
    fn a_step_at_a_later_switch_is_not_taken_for_a_reporting_offset() {
        // Only the first switch after the speaker was told to play has a
        // reporting offset; at a later one an underrun (which raises the
        // reserve, as the offset does) is an offset step.
        const MINUTE: f64 = 60_000.0;
        let (first, second) = (30.0 * MINUTE + 3_000.0, 60.0 * MINUTE + 11_000.0);
        for seed in 1000..1006 {
            let reports = switching(
                seed,
                &[
                    (first, next(1 << 32), 110.0),
                    (second, next(2 << 32), 300.0),
                ],
                80.0,
            );
            let outcomes: Vec<SwitchOutcome> = reports.iter().filter_map(|r| r.outcome).collect();
            assert!(
                matches!(
                    outcomes[..],
                    [SwitchOutcome::Absorbed { .. }, SwitchOutcome::Rejected { offset_ms }]
                        if (offset_ms - 300.0).abs() < 60.0
                ),
                "seed {seed}: {outcomes:?}"
            );
            let breaks: Vec<(f64, SegmentBreak)> = reports
                .iter()
                .filter_map(|r| r.brk.map(|b| (r.at, b)))
                .collect();
            assert!(
                matches!(breaks[..], [(at, SegmentBreak::OffsetStep)] if at > second),
                "seed {seed}: {breaks:?}"
            );
        }
    }

    #[test]
    fn an_underrun_just_before_a_switch_is_still_an_offset_step() {
        // An underrun in the minutes before the first switch, too recent for
        // the step detector to have confirmed it: the reserve over the polls
        // before the switch straddles it and is no reference, so the switch
        // is left unmeasured and the step is found as it always was. Once the
        // detector has confirmed it (after about 4 min), the switch is
        // measured afresh after the break, and only the reporting offset is
        // absorbed. Either way the underrun is reported.
        const MINUTE: f64 = 60_000.0;
        let switch_at = 40.0 * MINUTE + 7_000.0;
        for lead_s in [60.0, 120.0, 180.0, 240.0, 300.0] {
            for step in [200.0, 250.0] {
                for seed in 1100..1106 {
                    let reports = switching(
                        seed,
                        &[
                            (switch_at - lead_s * 1000.0, SEG0, step),
                            (switch_at, next(1 << 32), 110.0),
                        ],
                        60.0,
                    );
                    let ctx = format!("{step} ms {lead_s} s before, seed {seed}");
                    let outcomes: Vec<SwitchOutcome> =
                        reports.iter().filter_map(|r| r.outcome).collect();
                    assert!(
                        outcomes.iter().all(|o| match o {
                            SwitchOutcome::Absorbed { offset_ms } => {
                                (offset_ms - 110.0).abs() < 60.0
                            }
                            _ => true,
                        }),
                        "{ctx}: {outcomes:?}"
                    );
                    let breaks: Vec<SegmentBreak> = reports.iter().filter_map(|r| r.brk).collect();
                    // The detector itself misses this one 200 ms underrun,
                    // switch or none (see `most_200ms_underruns_are_suspected`).
                    if (lead_s, step, seed) != (300.0, 200.0, 1102) {
                        assert_eq!(breaks, [SegmentBreak::OffsetStep], "{ctx}: {outcomes:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn a_300ms_underrun_away_from_a_switch_is_still_an_offset_step() {
        const MINUTE: f64 = 60_000.0;
        let mut gen = PollGen::new(970);
        gen.ppm = 19.0;
        gen.tick_jitter_ms = 50.0;
        gen.steps = vec![(30.0 * MINUTE, -300.0)];
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut breaks = Vec::new();
        let mut t = 0.0;
        while t < 45.0 * MINUTE {
            t += 30_000.0;
            gen.run_until(t, |p| {
                tracker.observe_on(p, URI, false, Some(SEG0));
            });
            let (_, brk) = tracker.estimate(t);
            breaks.extend(brk.map(|b| (t, b)));
            assert_eq!(tracker.take_switch_outcome(), None);
            assert!(!tracker.settling());
        }
        assert!(
            matches!(breaks[..], [(at, SegmentBreak::OffsetStep)] if at > 30.0 * MINUTE),
            "{breaks:?}"
        );
    }

    #[test]
    fn a_step_being_confirmed_holds_the_controller() {
        let mut seg_tracker = ReserveTracker::new();
        seg_tracker.start_connection(true, H500);
        let mut gen = PollGen::new(971);
        gen.steps = vec![(20.0 * 60_000.0, -300.0)];
        let mut t = 0.0;
        let mut held_before_break = false;
        loop {
            t += 30_000.0;
            assert!(t < 30.0 * 60_000.0, "the step breaks the segment");
            gen.run_until(t, |p| {
                seg_tracker.observe(p, URI, false);
            });
            let (_, brk) = seg_tracker.estimate(t);
            if brk.is_some() {
                break;
            }
            held_before_break |= seg_tracker.control_hold();
        }
        assert!(held_before_break, "the first jumped estimate holds");
    }

    #[test]
    fn an_offset_measured_before_the_clock_is_precise_is_reclocked() {
        // A -45 ppm speaker moving on ten minutes in, before its clock is
        // known: the reserve before the switch is carried across it at a
        // rate of 0 while it rises 45 ppm, so the offset reads about 17 ms
        // high. Once the clock is within RECLOCK_MAX_SE_PPM the offset is
        // corrected by that much, and the reserve reads on from it.
        const MINUTE: f64 = 60_000.0;
        const OFFSET_MS: f64 = 190.0;
        let switch_at = 10.0 * MINUTE + 5_000.0;
        let (mut measured, mut corrected) = (Vec::new(), Vec::new());
        for seed in 1300..1316 {
            let mut gen = PollGen::new(seed);
            gen.start_ms = 500.0;
            gen.ppm = -45.0;
            gen.steps = vec![(switch_at, -OFFSET_MS)];
            let mut tracker = ReserveTracker::new();
            tracker.start_connection(true, H500);
            let mut outcomes = Vec::new();
            let mut t = 0.0;
            while t < 60.0 * MINUTE {
                t += 30_000.0;
                gen.run_until(t, |p| {
                    let tl = if p.ts >= switch_at {
                        next(1 << 32)
                    } else {
                        SEG0
                    };
                    tracker.observe_on(p, URI, false, Some(tl));
                });
                let (_, brk) = tracker.estimate(t);
                assert_eq!(brk, None, "seed {seed} at {t}");
                tracker.observe_ack_lag(&mut []);
                if let Some(o) = tracker.take_switch_outcome() {
                    let clock = tracker.clock().expect("clock");
                    outcomes.push((o, clock.se_ppm));
                }
            }
            let [(SwitchOutcome::Absorbed { offset_ms }, se_then), (
                SwitchOutcome::Reclocked {
                    offset_ms: now,
                    by_ms,
                },
                se_now,
            )] = outcomes[..]
            else {
                panic!("seed {seed}: {outcomes:?}");
            };
            assert!(
                se_then > RECLOCK_MAX_SE_PPM && se_now <= RECLOCK_MAX_SE_PPM,
                "seed {seed}: {outcomes:?}"
            );
            // 45 ppm over about 6.5 min, give or take the clock's error.
            assert!((-32.0..=-2.0).contains(&by_ms), "seed {seed}: {by_ms:.1}");
            assert!((now - offset_ms - by_ms).abs() < 1e-9);
            assert_eq!(tracker.reserve_offset_ms, now);
            measured.push(offset_ms - OFFSET_MS);
            corrected.push(now - OFFSET_MS);
        }
        // Measured 21 ms high on average, and 4 once corrected: what is left
        // is each measurement's own error, ±20 ms or so.
        let mean = |v: &[f64]| v.iter().sum::<f64>() / v.len() as f64;
        let (measured, corrected) = (mean(&measured), mean(&corrected));
        assert!(measured > 12.0, "{measured:+.1}");
        assert!(corrected.abs() < 8.0, "{measured:+.1} then {corrected:+.1}");
    }

    #[test]
    fn a_switch_after_a_short_segment_is_left_as_it_was() {
        const MINUTE: f64 = 60_000.0;
        // Segments of a minute: nothing is measured, nothing held, and the
        // reserve estimate never loses its lock over it.
        let switches: Vec<(f64, PlayoutTimeline, f64)> = (1u32..20)
            .map(|i| (f64::from(i) * MINUTE, next(u64::from(i) << 32), 0.0))
            .collect();
        let reports = switching(980, &switches, 20.0);
        assert!(reports.iter().all(|r| !r.settling));
        assert!(reports
            .iter()
            .filter_map(|r| r.outcome)
            .all(|o| o == SwitchOutcome::Unmeasured(SwitchUnmeasured::ShortSegment)));
        assert!(reports.last().unwrap().est.is_some_and(|e| e.locked()));
    }

    /// Runs a speaker 30 min on segment 0 and moves it on to segment 1 with
    /// a 110 ms reporting offset, returning the tracker once the switch has
    /// been seen (and the generator and time, to carry on).
    fn switched_tracker(seed: u64) -> (ReserveTracker, PollGen, f64) {
        switched_tracker_at(seed, 30.0 * 60_000.0 + 5_000.0, 0.0)
    }

    /// [`switched_tracker`], moving on at `switch_at`, with RelTime ticks
    /// jittered by up to `tick_jitter_ms`.
    fn switched_tracker_at(
        seed: u64,
        switch_at: f64,
        tick_jitter_ms: f64,
    ) -> (ReserveTracker, PollGen, f64) {
        let mut gen = PollGen::new(seed);
        gen.start_ms = 500.0;
        gen.tick_jitter_ms = tick_jitter_ms;
        gen.steps = vec![(switch_at, -110.0)];
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut t = 0.0;
        while t < switch_at + 30_000.0 {
            t += 30_000.0;
            gen.run_until(t, |p| {
                let tl = if p.ts >= switch_at {
                    next(1 << 32)
                } else {
                    SEG0
                };
                tracker.observe_on(p, URI, false, Some(tl));
            });
            tracker.estimate(t);
            tracker.observe_ack_lag(&mut []);
        }
        assert!(tracker.settling());
        (tracker, gen, t)
    }

    #[test]
    fn a_carried_estimate_teaches_only_along_a_precise_clock() {
        // Eight minutes in, at the field's tick jitter, the clock is too
        // uncertain to carry the reserve across the switch: the estimate is
        // carried along the correction alone, and would teach the integral
        // the opposite of the clock.
        let (tracker, _, _) = switched_tracker_at(994, 8.0 * 60_000.0 + 5_000.0, 50.0);
        let clock = tracker.clock();
        assert!(
            clock.is_none_or(|c| c.se_ppm > CLOCK_SHIFT_MAX_SE_PPM),
            "{clock:?}"
        );
        assert_eq!(tracker.carry(), EstimateCarry::Steers);

        // Half an hour in it is precise, and the carried estimate teaches.
        let (mut tracker, mut gen, mut t) = switched_tracker(994);
        let clock = tracker.clock().expect("clock");
        assert!(clock.se_ppm <= CLOCK_SHIFT_MAX_SE_PPM, "{clock:?}");
        assert_eq!(tracker.carry(), EstimateCarry::Teaches);

        // Measured, the estimate is the new segment's own again.
        while tracker.settling() {
            t += 30_000.0;
            assert!(t < 50.0 * 60_000.0, "the switch is measured");
            gen.run_until(t, |p| {
                tracker.observe_on(p, URI, false, Some(next(1 << 32)));
            });
            tracker.estimate(t);
            tracker.observe_ack_lag(&mut []);
        }
        assert_eq!(tracker.carry(), EstimateCarry::Measured);
    }

    #[test]
    fn a_pause_while_a_switch_settles_is_a_plain_pause() {
        let (mut tracker, mut gen, t) = switched_tracker(990);
        let p = gen.next_poll();
        assert_eq!(
            tracker.observe_on(&p, URI, true, Some(next(1 << 32))),
            Some(SegmentBreak::NotPlaying)
        );
        assert!(!tracker.settling());
        assert!(!tracker.control_hold());
        assert_eq!(
            tracker.take_switch_outcome(),
            Some(SwitchOutcome::Unmeasured(SwitchUnmeasured::SegmentBreak))
        );
        assert_eq!(tracker.estimate(t + 30_000.0), (None, None));
        // Playing again, the reserve is measured afresh as after any pause.
        let mut t = t + 30_000.0;
        gen.run_until(t, |_| {});
        let first = loop {
            t += 30_000.0;
            gen.run_until(t, |p| {
                tracker.observe_on(p, URI, false, Some(next(1 << 32)));
            });
            if let (Some(e), _) = tracker.estimate(t) {
                break e;
            }
        };
        assert_eq!(first.lock_reason, LockReason::Unlocked);
        assert_eq!(tracker.take_switch_outcome(), None);
    }

    #[test]
    fn a_restart_or_new_connection_counts_reltime_as_it_is_again() {
        // Absorbed, then restarted onto segment 2: told to play, RelTime is
        // counted as on segment 0 and nothing is measured or held.
        let mut gen = PollGen::new(991);
        gen.start_ms = 500.0;
        let switch_at = 30.0 * 60_000.0 + 5_000.0;
        let restart_at = 50.0 * 60_000.0 + 5_000.0;
        gen.steps = vec![(switch_at, -110.0), (restart_at, 110.0)];
        let restarted = PlayoutTimeline {
            start: 2 << 32,
            entry: TimelineEntry::Played,
        };
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        let mut t = 0.0;
        let mut outcomes = Vec::new();
        let mut levels = Vec::new();
        while t < 70.0 * 60_000.0 {
            t += 30_000.0;
            gen.run_until(t, |p| {
                let tl = if p.ts >= restart_at {
                    restarted
                } else if p.ts >= switch_at {
                    next(1 << 32)
                } else {
                    SEG0
                };
                tracker.observe_on(p, URI, false, Some(tl));
            });
            let (est, brk) = tracker.estimate(t);
            assert_eq!(brk, None, "at {t}");
            if t > restart_at {
                assert!(!tracker.control_hold(), "at {t}");
            }
            outcomes.extend(tracker.take_switch_outcome());
            levels.extend(est.filter(|e| e.locked()).map(|e| e.reserve_ms));
        }
        assert!(
            matches!(outcomes[..], [SwitchOutcome::Absorbed { .. }]),
            "{outcomes:?}"
        );
        let (first, last) = (levels[5], *levels.last().unwrap());
        assert!((first - last).abs() < 60.0, "{first:.0} then {last:.0}");

        // A new connection starts from RelTime as it is.
        tracker.start_connection(true, H500);
        assert_eq!(tracker.reserve_offset_ms, 0.0);
        assert_eq!(tracker.timeline, None);
    }

    #[test]
    fn an_uncertain_clock_moves_no_bounds() {
        // Five minutes of a +19 ppm speaker whose first clock fit came out at
        // +340±117 ppm, as wild and as uncertain as the field's first one:
        // far too uncertain to carry older bounds, or a step baseline, along.
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        tracker.set_command_ppm(10.0);
        let mut gen = PollGen::new(7);
        gen.tick_jitter_ms = 25.0;
        gen.ppm = 19.0;
        // The same polls, estimated with and without the clock.
        let (mut plain, mut clocked) = (ReserveEstimator::new(), ReserveEstimator::new());
        let mut t = 0.0;
        while t < 5.0 * 60_000.0 {
            t += 30_000.0;
            gen.run_until(t, |p| {
                tracker.observe(p, URI, false);
                plain.add(p);
                clocked.add(p);
            });
            tracker.estimate(t);
            tracker.observe_ack_lag(&mut []);
        }
        let clock = tracker.clock().expect("a first fit");
        assert!(clock.se_ppm > CLOCK_SHIFT_MAX_SE_PPM, "{clock:?}");
        assert_eq!(tracker.shift_ppm(), -10.0);
        t += 30_000.0;
        gen.run_until(t, |p| {
            tracker.observe(p, URI, false);
            plain.add(p);
            clocked.add(p);
        });
        let (est, _) = tracker.estimate(t);
        let est = est.expect("an estimate");
        let plain = plain.estimate(t, -10.0).unwrap();
        let clocked = clocked.estimate(t, clock.shrunk_ppm() - 10.0).unwrap();
        // The estimate is the one made without the clock, to the bit.
        assert_eq!(est.reserve_ms, plain.reserve_ms);
        assert!(
            (clocked.reserve_ms - plain.reserve_ms).abs() > 1.0,
            "the clock would have moved it: {clocked:?} against {plain:?}"
        );
        // A precise one does, shrunk as before.
        let mut gen = PollGen::new(993);
        gen.ppm = 40.0;
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true, H500);
        run(&mut tracker, &mut gen, 0.0, 60.0 * 60_000.0);
        let clock = tracker.clock().expect("fit");
        assert!(clock.se_ppm <= CLOCK_SHIFT_MAX_SE_PPM, "{clock:?}");
        assert_eq!(tracker.shift_ppm(), clock.shrunk_ppm());
    }
}
