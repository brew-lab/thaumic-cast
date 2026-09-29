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

use super::bounds::PollObservation;
use super::clock_fit::{ClockEstimate, ClockFit};
use super::reserve::{ReserveEstimate, ReserveEstimator};
use super::rollup::WindowStats;
use super::segment::{Segment, SegmentBreak};
use crate::stream::HeadStart;

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
        self.last_fresh = false;
        self.last_acked = None;
        self.last_stall_ms = None;
        self.pre_break = None;
        // Each connection gets its own head start, so it settles at its own
        // level, and the alarm is about the connection being measured.
        self.target_ms = None;
        self.target_pending = None;
        self.low = false;
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
        let brk = self
            .segment
            .observe_poll(obs.rel_ms, track_uri, not_playing);
        if let Some(reason) = brk {
            self.break_segment(reason);
        }
        if not_playing {
            return brk;
        }
        if self.pcm {
            self.reserve.add(obs);
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
        // Shrunk, so a rate from a few short segments (whose error can be
        // hundreds of ppm) cannot drag the older bounds, or the step
        // baseline, far. Net of the correction applied: inserted audio
        // raises the reserve as the speaker's clock lowers it.
        let ppm = self.net_ppm();
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
    /// one (see [`LockReason`](super::reserve::LockReason)) teaches the
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
        if est.locked() {
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
}
