//! Latency monitoring service for measuring absolute audio playback delay.
//!
//! This service measures the end-to-end latency between audio source and Sonos
//! playback by polling `GetPositionInfo` and comparing against stream timing.
//! The absolute latency is suitable for video sync applications.
//!
//! # Measurement Strategy
//!
//! Uses epoch-based timing where each Sonos HTTP connection defines a playback epoch.
//! Measures absolute latency: `stream_elapsed - sonos_reltime`
//! - `stream_elapsed` = wall-clock time since audio epoch (T0 for this connection)
//! - `sonos_reltime` = Sonos playback position in the track
//! - Result = total pipeline delay (typically 0.5-2s for PCM, 15-25s for AAC)
//!
//! The audio epoch (T0) is anchored to the capture time of the first frame the
//! connection serves (the oldest prefill frame kept after the PCM cadence trims
//! the prefill), capturing buffer-before-GET time for accurate measurement.
//!
//! # Features
//!
//! - Per-speaker epochs (prevents stray requests from clobbering timing)
//! - Stale detection (emits `Stale` event after 30s without valid position)
//! - RTT compensation for network delay
//! - Exponential moving average for stability
//! - Incremental variance (jitter) calculation for confidence scoring
//! - Track restart detection to maintain continuity
//! - Isolated polls: each speaker's `GetPositionInfo` runs in its own task with
//!   a short timeout, so a speaker that stops answering never delays another
//!
//! # Which speakers are watched
//!
//! Monitoring follows the data plane. Every connection that fetches a stream
//! for playback registers its [`ConnectionTap`] with the monitor when it serves
//! its first frame, however the cast was started, so only the device that
//! actually pulls the audio is ever polled; grouped slaves and home-theatre
//! satellites never are. A speaker is polled when speaker monitoring was on
//! for its connection (see [`speaker_monitor_enabled`]), or when a client
//! asked for video sync on it, which works whatever the setting says. A
//! video-sync request that arrives before the speaker's first fetch leaves a
//! pending session that the fetch completes.
//!
//! Monitor-only speakers are polled every two to three seconds, and never
//! more than [`SPEAKER_MONITOR_MAX_POLLS_PER_MIN`] times a minute between
//! them. A speaker reporting another track is left alone until it fetches the
//! stream again, and a poll taken while the speaker is known not to be
//! playing is not measured (see [`TransportGate`]).
//!
//! # Reserve and clock
//!
//! Every measured poll of a PCM connection also bounds the speaker's
//! *reserve*: the audio delivered to it minus the audio it has played (see
//! [`crate::services::speaker_monitor`]). Every 30 s each watched speaker's
//! reserve is estimated from the last three minutes of polls and its clock
//! rate from every stretch of unbroken playback so far, and one
//! `[SpeakerMonitor]` line reports both, with the cadence queue and the link
//! beside them; the same figures go into the connection's pipeline
//! snapshots. When a connection ends, a summary line reports what it saw.
//! Compressed codecs, whose
//! delivered bytes say nothing exact about playback time, get the clock
//! rate and keep the older wall-clock cushion line instead.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::events::{EventEmitter, LatencyEvent, LinkQuality, NetworkEvent};
use crate::protocol_constants::POSITION_POLL_TIMEOUT_MS;
use crate::runtime::TokioSpawner;
use crate::services::speaker_monitor::reserve::{HOLD_MIN_POLLS, RESERVE_WINDOW_MS};
use crate::services::speaker_monitor::{
    drift_active, ControlInput, DriftController, DriftMode, GenaTransport, MemberChange,
    MonitorState, NoticeInput, NoticeState, PollObservation, ReserveTracker, SegmentBreak,
    SpeakerControlState, SwitchOutcome, SwitchUnmeasured, TransportGate, TransportSource,
    TransportStateView, TransportVerdict, WindowStats,
};
use crate::sonos::traits::SonosPlayback;
use crate::sonos::types::{PositionInfo, TransportState};
use crate::stream::{
    ConnectionTap, MonitorRegistrar, PlaybackEpoch, SpeakerFigures, StreamRegistry,
};
use crate::utils::now_millis;

/// Polling interval for position queries.
/// 500ms is sufficient since Sonos RelTime only has 1-second precision.
const POLL_INTERVAL_MS: u64 = 500;

/// Environment variable that forces speaker monitoring on for this process,
/// whatever the configuration says. Kept from before monitoring was on by
/// default, for anyone whose setup already sets it.
pub const SPEAKER_DIAGNOSTICS_ENV: &str = "THAUMIC_SPEAKER_DIAGNOSTICS";

/// Whether the diagnostics switch is set for this process.
pub fn speaker_diagnostics_enabled() -> bool {
    std::env::var_os(SPEAKER_DIAGNOSTICS_ENV).is_some_and(|v| !v.is_empty() && v != "0")
}

/// Environment variable that overrides the speaker-monitor setting:
/// `on` or `off` (also `true`/`false`, `1`/`0`, `yes`/`no`).
pub const SPEAKER_MONITOR_ENV: &str = "THAUMIC_SPEAKER_MONITOR";

/// Parses a speaker-monitor switch value, or `None` if it is not one.
pub fn parse_speaker_monitor_switch(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "on" | "true" | "1" | "yes" => Some(true),
        "off" | "false" | "0" | "no" => Some(false),
        _ => None,
    }
}

/// The value [`SPEAKER_MONITOR_ENV`] forces the setting to, if it is set to
/// something recognisable. An unrecognisable value is ignored, with a
/// warning the first time it is seen.
pub fn speaker_monitor_env_override() -> Option<bool> {
    static WARNED: std::sync::Once = std::sync::Once::new();
    let raw = std::env::var(SPEAKER_MONITOR_ENV).ok()?;
    if raw.trim().is_empty() {
        return None;
    }
    let parsed = parse_speaker_monitor_switch(&raw);
    if parsed.is_none() {
        WARNED.call_once(|| {
            log::warn!(
                "[LatencyMonitor] Ignoring {}={:?}: expected on or off",
                SPEAKER_MONITOR_ENV,
                raw
            );
        });
    }
    parsed
}

/// Whether speaker monitoring is on, given the configured setting.
///
/// [`SPEAKER_MONITOR_ENV`] overrides `configured` when set, and the older
/// [`SPEAKER_DIAGNOSTICS_ENV`] switch turns monitoring on regardless. Read
/// once per speaker connection. Video sync does not depend on this: a speaker
/// a client asked video sync for is polled either way.
pub fn speaker_monitor_enabled(configured: bool) -> bool {
    resolve_speaker_monitor(
        configured,
        speaker_monitor_env_override(),
        speaker_diagnostics_enabled(),
    )
}

/// [`speaker_monitor_enabled`] without the environment.
fn resolve_speaker_monitor(
    configured: bool,
    env_override: Option<bool>,
    diagnostics: bool,
) -> bool {
    env_override.unwrap_or(configured) || diagnostics
}

/// Base polling interval for a speaker that is monitored but not driving
/// video sync. With [`MONITOR_POLL_DITHER_MS`] this averages one poll every
/// two and a half seconds, 24 a minute.
const MONITOR_POLL_INTERVAL_MS: u64 = 2000;

/// Random delay added to every monitor-only poll, for the same reason as
/// [`POLL_DITHER_MS`]: it spreads the polls uniformly over the speaker's
/// whole-second RelTime ticks.
const MONITOR_POLL_DITHER_MS: u64 = 1000;

/// Polls a minute one monitor-only speaker costs at the base interval.
const MONITOR_POLLS_PER_MIN: u64 = 60_000 / (MONITOR_POLL_INTERVAL_MS + MONITOR_POLL_DITHER_MS / 2);

/// Ceiling on monitor-only polls a minute across the whole process. Past
/// five fetching speakers (a large unsynced cast) every monitor-only interval
/// stretches in proportion, so the total stays here. Video-sync polls are
/// exempt: video sync needs its cadence.
pub const SPEAKER_MONITOR_MAX_POLLS_PER_MIN: u64 = 120;

/// How often each compressed-codec speaker's cushion and trend are written
/// to the log.
const DIAGNOSTIC_LOG_INTERVAL_SECS: u64 = 30;

/// How often each watched speaker's reserve and clock are estimated and
/// written to the log.
const SPEAKER_REPORT_INTERVAL: Duration = Duration::from_secs(30);

/// Most household changes listed on one report line. A flapping satellite
/// between two reports is still counted in the connection's summary.
const MAX_TOPOLOGY_NOTES: usize = 8;

/// Projected time to the low floor above which a draining warning is
/// re-armed (it fires below
/// [`DRAINING_WARN_SECS`](crate::services::speaker_monitor::tracker::DRAINING_WARN_SECS)).
const DRAINING_CLEAR_SECS: f64 = 45.0 * 60.0;

/// Most acknowledgement-lag samples the monitor ticks add to one report's
/// window: a 30 s window at the 500 ms tick holds 60, so this only bounds a
/// window stretched by a stalled monitor.
const MAX_TICK_LAGS: usize = 256;

/// Polls in a row reporting a track that is not the stream after which the
/// speaker is left alone until it fetches the stream again. Two, so a single
/// odd answer around the start of a cast does not end its monitoring.
const DORMANT_AFTER_MISMATCHES: u32 = 2;

/// How long a monitor-only session outlives its connection, waiting for the
/// speaker's next fetch (the routine reconnect, or a resume) to take it over.
const CONNECTION_LOST_GRACE: Duration = Duration::from_secs(60);

/// How long what drift correction learned about a speaker is kept after its
/// last session ends, for its next cast.
const CONTROL_STATE_IDLE: Duration = Duration::from_secs(60 * 60);

/// Random delay added to every poll, in milliseconds.
///
/// The speaker reports its position in whole seconds, so each sample of the
/// cushion carries an error that depends on where in the speaker's second
/// the poll lands. Polling on a fixed cadence keeps that phase almost
/// constant, and under a slow drift it creeps linearly, which a trend fit
/// cannot tell from the drift itself. Spreading each poll by up to a full
/// second makes the phase uniform, so the error averages out instead.
const POLL_DITHER_MS: u64 = 1000;

/// Cushion below which a speaker is about to run dry. The pipeline latency
/// this service measures is the audio between capture and the speaker's
/// playhead; when it approaches zero the speaker has nothing left to play
/// ahead and every network hiccup becomes a dropout.
const LOW_CUSHION_MS: i64 = 150;

/// Cushion above which a low-cushion warning is re-armed.
const LOW_CUSHION_CLEAR_MS: i64 = 300;

/// A trend at least this steep, sustained over [`TREND_MIN_SPAN_SECS`] and
/// at least [`TREND_MIN_SIGMA`] standard errors from zero, is reported. The
/// source and the speaker run on different clocks and their rates never
/// match exactly; what matters is whether the mismatch will empty the cushion
/// within a session.
const TREND_WARN_MS_PER_MIN: f64 = 10.0;

/// How many standard errors from zero a slope must be before it is called a
/// trend. Each sample carries up to a second of noise from the speaker's
/// position precision, so a short window fits a steep slope out of nothing;
/// the standard error says how much of the slope is noise.
const TREND_MIN_SIGMA: f64 = 3.0;

/// Shortest span of samples a trend is trusted over.
const TREND_MIN_SPAN_SECS: f64 = 60.0;

/// Projected time to an empty cushion below which the trend is a warning.
const TREND_WARN_HORIZON_MIN: f64 = 15.0;

/// Consecutive failed polls (timeouts or errors) after which a speaker is
/// polled at [`BACKOFF_POLL_INTERVAL_MS`] until it answers again.
const BACKOFF_AFTER_FAILURES: u32 = 3;

/// Polling interval for a speaker that has stopped answering. Its polls cost
/// nothing to the other speakers (each runs in its own task), but there is
/// no point asking twice a second for an answer that is not coming.
const BACKOFF_POLL_INTERVAL_MS: u64 = 5000;

/// Minimum samples needed before emitting latency updates.
const MIN_SAMPLES_FOR_CONFIDENCE: usize = 5;

/// EMA smoothing factor (higher = more responsive to changes).
const EMA_ALPHA: f64 = 0.3;

/// Maximum time since last valid position before considering epoch stale.
/// If we haven't received valid position info in this window, something is wrong.
/// Should be >= 10 * POLL_INTERVAL_MS to avoid false positives during network blips.
const STALE_EPOCH_TIMEOUT_SECS: u64 = 30;

/// Key for identifying a monitoring session (stream_id, canonical speaker IP).
type SessionKey = (String, IpAddr);

/// A session's source of poll dither: `splitmix64`, which is small, fast
/// and uniform enough for spreading polls over a second.
///
/// The dither used to be read from the wall clock's sub-second part at the
/// wake-up that sent the poll. The monitor wakes on a 500 ms grid, so that
/// read took one of two values, `a` or `a + 500`, for a fixed `a` set by when
/// the process started, and the polls' phases walked the lattice
/// `k·a mod 500`. With `a` near 0 or 250 that lattice has two to four
/// points, and the reserve bounds cannot narrow past the gaps between them.
#[derive(Debug, Clone)]
struct DitherRng(u64);

impl DitherRng {
    /// A generator starting from `seed`.
    fn new(seed: u64) -> Self {
        Self(seed)
    }

    /// The next 64 random bits.
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// Uniform in `[0, span)`; zero when `span` is zero.
    fn below(&mut self, span: u64) -> u64 {
        ((u128::from(self.next_u64()) * u128::from(span)) >> 64) as u64
    }
}

/// Seed for a session's poll dither: random per process (std's
/// [`RandomState`](std::collections::hash_map::RandomState) keys), mixed with
/// the session's key so speakers polled from the same process draw apart.
fn dither_seed(key: &SessionKey) -> u64 {
    use std::hash::BuildHasher;
    std::collections::hash_map::RandomState::new().hash_one(key)
}

/// What a spawned poll task hands back to the monitor loop, which alone owns
/// session state and applies it.
struct PollResult {
    key: SessionKey,
    /// Identifies the poll, so a late answer is applied only to the session
    /// that is still waiting for it.
    poll_id: u64,
    /// Epoch the poll was measured against.
    epoch_id: u64,
    /// Time since the epoch's audio T0, read just before the request.
    stream_elapsed_ms: u64,
    /// Request round-trip time.
    rtt_ms: u32,
    /// When the request was sent and when its answer (or timeout) came back.
    /// The speaker read its position somewhere in between.
    sent_at: Instant,
    answered_at: Instant,
    /// Milliseconds of audio handed to the connection when the request was
    /// sent and when it was answered; `None` for a compressed codec.
    delivered_ms_at_send: Option<u64>,
    delivered_ms_at_answer: Option<u64>,
    /// Audio drift correction had inserted (positive) or removed when the
    /// answer arrived, in ms; 0 when it corrects nothing.
    net_inserted_ms: f64,
    /// The speaker's answer, or why there was none.
    outcome: Result<PositionInfo, String>,
    /// The speaker's transport state, when the poll also asked for it.
    transport: Option<Result<TransportState, String>>,
}

/// Incremental least-squares fit of cushion against time.
///
/// Answers one question: is the speaker's cushion shrinking, and how fast?
/// A steady negative slope means the speaker consumes audio faster than the
/// source produces it (its DAC clock runs ahead of the capture clock), and
/// since a live source can only ever deliver at its own rate, the cushion is
/// never replenished until playback restarts. Sample noise from the speaker's
/// one-second position precision averages out over a fit spanning minutes.
#[derive(Debug, Default, Clone, Copy)]
struct CushionTrend {
    n: f64,
    sum_x: f64,
    sum_y: f64,
    sum_xx: f64,
    sum_xy: f64,
    sum_yy: f64,
    /// Seconds of samples covered so far.
    span_secs: f64,
}

/// A fitted trend: the slope and how sure the fit is of it.
#[derive(Debug, Clone, Copy)]
struct Trend {
    /// Milliseconds of cushion per minute of wall clock; negative is draining.
    slope_ms_per_min: f64,
    /// Standard error of the slope, in the same unit.
    error_ms_per_min: f64,
}

impl Trend {
    /// Whether the slope is far enough from zero to be more than noise.
    fn is_significant(&self) -> bool {
        self.slope_ms_per_min.abs() >= TREND_MIN_SIGMA * self.error_ms_per_min
    }
}

impl CushionTrend {
    /// Adds a sample: `x_secs` since the first sample, `y_ms` of cushion.
    fn add(&mut self, x_secs: f64, y_ms: f64) {
        self.n += 1.0;
        self.sum_x += x_secs;
        self.sum_y += y_ms;
        self.sum_xx += x_secs * x_secs;
        self.sum_xy += x_secs * y_ms;
        self.sum_yy += y_ms * y_ms;
        self.span_secs = x_secs;
    }

    /// Least-squares slope of cushion against time with its standard error,
    /// once there are enough samples spread in time to fit one.
    fn fit(&self) -> Option<Trend> {
        if self.n < 3.0 {
            return None;
        }
        let sxx = self.sum_xx - self.sum_x * self.sum_x / self.n;
        if sxx <= f64::EPSILON {
            return None;
        }
        let sxy = self.sum_xy - self.sum_x * self.sum_y / self.n;
        let syy = self.sum_yy - self.sum_y * self.sum_y / self.n;
        let slope = sxy / sxx;
        let residual_variance = ((syy - slope * sxy) / (self.n - 2.0)).max(0.0);
        let error = (residual_variance / sxx).sqrt();
        Some(Trend {
            slope_ms_per_min: slope * 60.0,
            error_ms_per_min: error * 60.0,
        })
    }
}

/// Tracks latency measurement state for a single speaker.
struct LatencySession {
    /// Whether measurements are sent to clients (video sync). Every session
    /// is logged; only these emit events.
    emit_events: bool,
    /// The speaker's current connection, held weakly (its response body owns
    /// it). `None` for a video-sync request whose speaker has not fetched yet.
    tap: Option<Weak<ConnectionTap>>,
    /// Whether speaker monitoring was on for the current connection. A
    /// session is polled when this or `emit_events` is set.
    monitor: bool,
    /// When the current connection was found closed, while no newer one has
    /// taken its place.
    tap_lost_at: Option<Instant>,
    /// The speaker reported a track that is not this stream, so it is not
    /// polled until it fetches the stream again.
    dormant: bool,
    /// Polls in a row that reported another track.
    uri_mismatches: u32,
    /// Whether the speaker is playing, from evidence that can be trusted.
    gate: TransportGate,
    /// When the speaker was last polled, and the dithered interval before the next poll.
    last_poll: Option<Instant>,
    next_poll_after: Duration,
    /// Where the dither of each interval is drawn from.
    dither: DitherRng,
    /// Cushion trend over the current epoch.
    trend: CushionTrend,
    /// When the first trend sample of the current epoch was taken.
    trend_started: Option<Instant>,
    /// Most recent raw (unsmoothed) cushion, and its extremes since the last log line.
    last_raw_ms: i64,
    window_min_ms: i64,
    window_max_ms: i64,
    /// When the cushion and trend were last written to the log.
    last_diag_log: Option<Instant>,
    /// Whether the low-cushion warning is armed (re-armed once it recovers).
    low_cushion_warned: bool,
    /// When the shrinking-trend warning was last written.
    last_trend_warning: Option<Instant>,
    /// Last observed Sonos RelTime (ms) for detecting track restarts.
    /// When RelTime goes backwards, we know the track restarted.
    last_sonos_reltime_ms: Option<u64>,
    /// Cumulative offset to add to Sonos RelTime when track restarts.
    /// This maintains continuity across metadata-triggered restarts.
    sonos_offset_ms: u64,
    /// Exponential moving average of latency.
    ema_latency: f64,
    /// Number of samples collected (for confidence calculation).
    sample_count: usize,
    /// Running mean for incremental variance (Welford's algorithm).
    running_mean: f64,
    /// Running M2 for incremental variance (sum of squared differences).
    running_m2: f64,
    /// When we last emitted an update.
    last_emit: Option<Instant>,
    /// Last epoch ID we measured against.
    /// If this changes, Sonos reconnected and we need to reset.
    last_epoch_id: u64,
    /// When we last saw valid position info (for stale detection).
    last_valid_position: Option<Instant>,
    /// Whether we've already emitted a Stale event for the current stale state.
    /// Prevents spamming stale events; cleared when valid data resumes.
    stale_emitted: bool,
    /// The poll currently outstanding for this speaker, if any. A speaker is
    /// never polled again until its previous poll has answered or timed out.
    in_flight: Option<u64>,
    /// Polls in a row that timed out or failed; resets on any answer.
    consecutive_failures: u32,
    /// Reserve and clock tracking across the speaker's connections.
    tracker: ReserveTracker,
    /// When the current connection was accepted: the origin of the times
    /// fed to the tracker.
    connected_at: Option<Instant>,
    /// Whether the current connection is PCM, whose reserve is measured.
    /// A compressed one keeps the wall-clock cushion line.
    pcm: bool,
    /// When the reserve and clock were last reported.
    last_report: Option<Instant>,
    /// Polls measured since the last report.
    polls_since_report: u32,
    /// Where each of those polls fell in the second, in ms from the
    /// connection's start modulo 1000: the midpoint of its round trip.
    /// Against the speaker's own second this is shifted by a constant, so
    /// the gaps between them are the gaps the reserve bounds see.
    phases_since_report: Vec<f64>,
    /// How far the speaker's acknowledgements lagged the delivered count at
    /// each monitor tick since the last report, in ms of audio (PCM, where
    /// acknowledgements are reported). Joins the pipeline snapshots' lags,
    /// which a stall that stops the body being polled holds back.
    tick_lags_ms: Vec<f64>,
    /// Whether the connection came near its declared end (see
    /// [`ConnectionTap::near_declared_end`]) at any tick since the last
    /// report. Such a window is the end of the item: it measures no stall
    /// and decides no notice, and the drift controller holds through it.
    declared_end_in_window: bool,
    /// Whether the current connection has handed over everything up to its
    /// declared end, for its summary.
    declared_end_reached: bool,
    /// Where the last transport verdict came from.
    last_transport_source: TransportSource,
    /// Whether the draining warning has fired. It is re-armed only once the
    /// projection recovers past [`DRAINING_CLEAR_SECS`] or the clock stops
    /// draining, not when the projection merely lapses (the estimate
    /// unlocking, an offset step, a new connection), so it does not repeat
    /// while the speaker drains on.
    draining_warned: bool,
    /// Whether the current connection is owed an end-of-connection summary.
    summary_owed: bool,
    /// When the previous connection was found closed, and the gap from
    /// then to the current connection.
    previous_connection_ended: Option<Instant>,
    reconnect_gap: Option<Duration>,
    /// The state last sent to clients in a speaker health event, so a
    /// change between reports is sent at once.
    health_reported: Option<MonitorState>,
    /// Household changes concerning this speaker since the last report, for
    /// its next `[SpeakerMonitor]` line (at most [`MAX_TOPOLOGY_NOTES`]).
    topology_since_report: Vec<MemberChange>,
    /// Household changes concerning this speaker during the current
    /// connection, for its summary.
    connection_topology_changes: u32,
    /// What the user is told about this speaker, decided at each report
    /// and kept for the rest of the cast (the session's life), so notice
    /// ids count per stream and speaker.
    notices: NoticeState,
    /// Clock drift correction for the speaker, stepped at each report.
    drift: DriftController,
    /// Origin of the drift controller's clock, which runs on across the
    /// session's connections.
    drift_origin: Instant,
    /// What the drift controller's state is kept under between sessions:
    /// the speaker's UUID, or its address until the topology knows it.
    control_key: Option<String>,
}

impl LatencySession {
    /// Creates a new monitoring session with no connection yet, drawing its
    /// poll dither from `dither_seed` (see [`dither_seed`]).
    fn new(emit_events: bool, dither_seed: u64) -> Self {
        Self {
            emit_events,
            tap: None,
            monitor: false,
            tap_lost_at: None,
            dormant: false,
            uri_mismatches: 0,
            gate: TransportGate::new(Instant::now()),
            last_poll: None,
            next_poll_after: Duration::ZERO,
            dither: DitherRng::new(dither_seed),
            trend: CushionTrend::default(),
            trend_started: None,
            last_raw_ms: 0,
            window_min_ms: i64::MAX,
            window_max_ms: i64::MIN,
            last_diag_log: None,
            low_cushion_warned: false,
            last_trend_warning: None,
            last_sonos_reltime_ms: None,
            sonos_offset_ms: 0,
            ema_latency: 0.0,
            sample_count: 0,
            running_mean: 0.0,
            running_m2: 0.0,
            last_emit: None,
            last_epoch_id: 0,
            last_valid_position: None,
            stale_emitted: false,
            in_flight: None,
            consecutive_failures: 0,
            tracker: ReserveTracker::new(),
            connected_at: None,
            pcm: false,
            last_report: None,
            polls_since_report: 0,
            phases_since_report: Vec::new(),
            tick_lags_ms: Vec::new(),
            declared_end_in_window: false,
            declared_end_reached: false,
            last_transport_source: TransportSource::None,
            draining_warned: false,
            summary_owed: false,
            previous_connection_ended: None,
            reconnect_gap: None,
            health_reported: None,
            topology_since_report: Vec::new(),
            connection_topology_changes: 0,
            notices: NoticeState::new(),
            drift: DriftController::default(),
            drift_origin: Instant::now(),
            control_key: None,
        }
    }

    /// Resets all state when switching to a different stream or epoch.
    /// This clears everything including the position offset.
    fn reset_all(&mut self) {
        self.trend = CushionTrend::default();
        self.trend_started = None;
        self.window_min_ms = i64::MAX;
        self.window_max_ms = i64::MIN;
        self.low_cushion_warned = false;
        self.last_sonos_reltime_ms = None;
        self.sonos_offset_ms = 0;
        self.ema_latency = 0.0;
        self.sample_count = 0;
        self.running_mean = 0.0;
        self.running_m2 = 0.0;
        self.last_valid_position = None;
        self.stale_emitted = false;
    }

    /// Takes over a connection that has started its epoch: the speaker's
    /// first fetch, or a later one replacing the last. Whatever the previous
    /// connection concluded about the track playing no longer holds, and
    /// the reserve is measured afresh: the new connection restarts both the
    /// delivered count and the speaker's RelTime.
    fn attach(&mut self, tap: &Arc<ConnectionTap>) {
        let now = Instant::now();
        // A connection replaced before a tick noticed it closing still gets
        // its summary.
        self.end_connection(&tap.stream_id, tap.speaker_ip, now);
        self.reconnect_gap = self
            .previous_connection_ended
            .take()
            .map(|ended| tap.connected_at.saturating_duration_since(ended));
        self.tap = Some(Arc::downgrade(tap));
        self.monitor = tap.monitor;
        self.tap_lost_at = None;
        self.dormant = false;
        self.uri_mismatches = 0;
        // Sync now rather than on the next tick, so a late answer to a poll
        // of the old connection is recognised as such.
        if let Some(epoch) = tap.epoch() {
            self.sync_epoch(epoch);
        }
        self.pcm = tap.byte_rate > 0;
        self.connected_at = Some(tap.connected_at);
        self.tracker.start_connection(self.pcm, tap.head_start());
        // Only a PCM connection's reserve can be steered.
        let drift = if self.pcm {
            tap.drift_mode()
        } else {
            DriftMode::Off
        };
        self.drift
            .start_connection(drift, tap.rate_control().is_some());
        self.tracker.set_command_ppm(self.command_in_force(tap));
        self.last_report = Some(now);
        self.polls_since_report = 0;
        self.phases_since_report.clear();
        self.tick_lags_ms.clear();
        self.declared_end_in_window = false;
        self.declared_end_reached = false;
        self.connection_topology_changes = 0;
        self.summary_owed = self.wants_polls();
    }

    /// Adds a household change concerning this speaker (a satellite of its
    /// home theatre dropping, a device in its group rebooting) to its
    /// timeline: the next report line lists it, and the connection's summary
    /// counts it.
    fn note_topology(&mut self, change: MemberChange) {
        self.connection_topology_changes = self.connection_topology_changes.saturating_add(1);
        if self.topology_since_report.len() < MAX_TOPOLOGY_NOTES {
            self.topology_since_report.push(change);
        }
    }

    /// Logs the end-of-connection summary, if the current connection is
    /// owed one: how long it lasted, its reserve at the start, the end and
    /// the lowest, the clock rate, polls, segment breaks by reason, suspected
    /// underruns, inconsistent reserve estimates and the gap before it.
    /// Returns whether it logged one.
    fn end_connection(&mut self, stream_id: &str, speaker_ip: IpAddr, now: Instant) -> bool {
        if !std::mem::take(&mut self.summary_owed) {
            return false;
        }
        self.previous_connection_ended = Some(now);
        let Some(connected_at) = self.connected_at else {
            return false;
        };
        let c = self.tracker.connection();
        let ms = |v: Option<f64>| v.map_or_else(|| "?".to_string(), |v| format!("{v:.0}"));
        let head_start = self.tracker.head_start().map_or_else(
            || "\u{2014}".to_string(),
            |h| format!("{}/{}ms", h.sent_ms, h.configured_ms),
        );
        let breaks: Vec<String> = SegmentBreak::ALL
            .iter()
            .filter(|r| **r != SegmentBreak::NewConnection)
            .map(|r| format!("{}={}", r, self.tracker.connection_breaks(*r)))
            .collect();
        let (estimates, inconsistent) = self.tracker.connection_estimate_counts();
        // Taken out here: the log macro skips its arguments when the level is
        // off, and the flag must not outlive the connection either way.
        let end_note = if std::mem::take(&mut self.declared_end_reached) {
            " at its declared end"
        } else {
            ""
        };
        log::info!(
            "[SpeakerMonitor] {} stream={} connection ended after {}{}: head_start={} reserve \
             start={}ms end={}ms min={}ms{} calib={} clock={} polls={} breaks[{}] \
             underruns_suspected={} incons={}/{} topology_changes={} reconnect_gap={}",
            speaker_ip,
            stream_id,
            format_duration(now.saturating_duration_since(connected_at)),
            end_note,
            head_start,
            ms(c.reserve_start_ms),
            ms(c.reserve_end_ms),
            ms(c.reserve_min_ms),
            if c.acked_measured { "(acked)" } else { "" },
            ms(self.tracker.calib_ms()),
            format_clock(self.tracker.clock()),
            c.polls,
            breaks.join(" "),
            self.tracker.connection_breaks(SegmentBreak::OffsetStep),
            inconsistent,
            estimates,
            self.connection_topology_changes,
            self.reconnect_gap
                .map_or_else(|| "none".to_string(), format_duration),
        );
        true
    }

    /// Samples how far the speaker's acknowledgements lag the delivered
    /// count right now, for the next report's window. Called on every
    /// monitor tick, so the window sees a stall even while it stops the
    /// connection's pipeline snapshots.
    ///
    /// Near the connection's declared end nothing is sampled, and the window
    /// is marked as the end of the item instead.
    fn sample_ack_lag(&mut self, tap: &ConnectionTap) {
        if tap.near_declared_end() {
            self.declared_end_in_window = true;
            self.declared_end_reached |= tap.reached_declared_end();
            return;
        }
        if self.tick_lags_ms.len() >= MAX_TICK_LAGS {
            return;
        }
        if let Some(lag) = tap.unacked_ms_now() {
            self.tick_lags_ms.push(lag);
        }
    }

    /// Whether the reserve and clock are due another report.
    fn report_due(&self, now: Instant) -> bool {
        self.last_report.map_or(true, |at| {
            now.saturating_duration_since(at) >= SPEAKER_REPORT_INTERVAL
        })
    }

    /// Estimates the reserve and clock, publishes them to the connection's
    /// pipeline snapshots, writes the rolled-up `[SpeakerMonitor]` line and
    /// sends it to clients as a speaker health event, warning when the
    /// reserve is draining towards empty or has stepped as an underrun would.
    ///
    /// A window in which the connection came near its declared end is the
    /// end of the item (see [`ConnectionTap::near_declared_end`]): the
    /// speaker reads to about there, plays out and stops, and nothing its
    /// acknowledgements or reserve do on the way is a stall, a reserve
    /// running low or drift. Such a window measures no ack
    /// lag, decides no notice and warns of nothing, and the drift controller
    /// holds through it.
    fn report(
        &mut self,
        stream_id: &str,
        speaker_ip: IpAddr,
        tap: &ConnectionTap,
        now: Instant,
        emitter: &dyn EventEmitter,
    ) {
        let window = self.last_report.map_or(SPEAKER_REPORT_INTERVAL, |at| {
            now.saturating_duration_since(at)
        });
        self.last_report = Some(now);
        let polls = std::mem::take(&mut self.polls_since_report);
        let phase_gap = largest_phase_gap_ms(&mut self.phases_since_report);
        self.phases_since_report.clear();

        let at_declared_end =
            std::mem::take(&mut self.declared_end_in_window) || tap.near_declared_end();
        let now_ms = ms_between(tap.connected_at, now);
        // The correction in force over the window just ended.
        self.tracker.set_command_ppm(self.command_in_force(tap));
        let (estimate, brk) = self.tracker.estimate(now_ms);
        if let Some(outcome) = self.tracker.take_switch_outcome() {
            log_switch_outcome(stream_id, speaker_ip, outcome);
        }
        // Measuring a continuation switch: the estimate is the one from
        // before it, carried forward, and decides nothing.
        let settling = self.tracker.settling();
        if brk == Some(SegmentBreak::OffsetStep) && !at_declared_end {
            log::warn!(
                "[SpeakerMonitor] {} stream={}: underrun suspected: the reserve stepped and \
                 stayed stepped; measuring it afresh",
                speaker_ip,
                stream_id
            );
        }
        // Copies the window out under the pipeline timeline's lock, which
        // the cadence loop also takes every 500 ms. Unlike everything else
        // the monitor reads, this is not an atomic, but the lock is held
        // only for the copy (about 60 entries every 30 s) and never across
        // an await.
        let pipeline = tap.recent_pipeline(window);
        let was_low = self.tracker.is_low();
        let tick_lags = std::mem::take(&mut self.tick_lags_ms);
        let mut lags_ms: Vec<f64> = if tap.byte_rate > 0 && !at_declared_end {
            pipeline
                .iter()
                .filter_map(|s| s.unacked_bytes)
                .map(|b| b as f64 * 1000.0 / f64::from(tap.byte_rate))
                .chain(tick_lags)
                .collect()
        } else {
            Vec::new()
        };
        let acked = if at_declared_end {
            self.tracker.observe_declared_end();
            None
        } else {
            self.tracker.observe_ack_lag(&mut lags_ms)
        };
        let clock = self.tracker.clock();
        // Nothing near the end says where the reserve is heading: hold.
        self.step_drift(tap, now, estimate.filter(|_| !at_declared_end));
        if !at_declared_end {
            note_debt_repaid(
                stream_id,
                speaker_ip,
                tap,
                estimate,
                self.tracker.target_ms(),
            );
        }
        tap.publish_speaker(SpeakerFigures {
            reserve: estimate.map(|e| (e.reserve_ms, e.half_width_ms)),
            clock_ppm: clock.map(|c| (c.ppm, c.se_ppm)),
        });

        let state = self.health_state();
        let reserve = match (&estimate, self.pcm) {
            (Some(e), _) => format!(
                "{:.0}\u{b1}{:.0}ms{}{}",
                e.reserve_ms,
                e.half_width_ms,
                if e.inconsistent { "(incons)" } else { "" },
                format_acked(acked, self.tracker.target_ms()),
            ),
            (None, true) => "\u{2014}".to_string(),
            (None, false) => "n/a(compressed)".to_string(),
        };
        let ttf = self.tracker.time_to_floor_s();
        let (estimates, inconsistent) = self.tracker.connection_estimate_counts();
        let per_min = f64::from(polls) * 60.0 / window.as_secs_f64().max(1.0);
        let topology = format_topology(&std::mem::take(&mut self.topology_since_report));
        let opt_ms =
            |v: Option<f64>| v.map_or_else(|| "\u{2014}".to_string(), |v| format!("{v:.0}"));
        log::info!(
            "[SpeakerMonitor] {} stream={} state={} reserve={} lock={} {} stall={} ttf={} \
             calib={} clock={} {} polls={}({:.0}/min) phase_gap={} incons={}/{} j={:.0}ms {} \
             link={} transport={}{}{}{}",
            speaker_ip,
            stream_id,
            state,
            reserve,
            estimate.map_or("\u{2014}", |e| e.lock_reason.as_str()),
            format_head_start(&self.tracker),
            opt_ms(self.tracker.stall_ms()),
            ttf.map_or_else(
                || "\u{2014}".to_string(),
                |s| format_duration(Duration::from_secs_f64(s))
            ),
            opt_ms(self.tracker.calib_ms()),
            format_clock(clock),
            format_drift(
                &self.drift,
                tap.net_inserted_ms(),
                tap.rate_control().and_then(|c| c.forced_ppm()),
                tap.rate_control().is_some_and(|c| c.is_pinned())
            ),
            polls,
            per_min,
            phase_gap.map_or_else(|| "\u{2014}".to_string(), |g| format!("{g:.0}ms")),
            inconsistent,
            estimates,
            self.tracker.jitter_ms(),
            format_pipeline(&pipeline),
            tap.link_verdict().map_or_else(
                || "\u{2014}".to_string(),
                |q| format!("{q:?}").to_lowercase()
            ),
            self.last_transport_source,
            topology,
            if at_declared_end { " end=declared" } else { "" },
            if settling { " switch=settling" } else { "" },
        );

        // The end of the item: the notice stands as it was, and the low,
        // recovered and draining warnings below say nothing true about it.
        if at_declared_end {
            self.emit_health(stream_id, speaker_ip, state, emitter);
            return;
        }

        // While a switch settles the notice stands as it was too.
        if !settling {
            self.decide_notice(
                stream_id,
                speaker_ip,
                tap,
                now,
                estimate.is_some_and(|e| e.locked()),
                acked,
                brk,
                ttf,
            );
        }

        let is_low = self.tracker.is_low();
        if is_low && !was_low {
            if let (Some(a), Some(floor)) = (acked, self.tracker.floor_ms()) {
                log::warn!(
                    "[SpeakerMonitor] {} stream={}: reserve low: the speaker's buffer spent a \
                     tenth of the last window at or below {:.0}ms of {} audio, under the {:.0}ms \
                     floor for its {}ms head start; it may cut out (reserve={})",
                    speaker_ip,
                    stream_id,
                    a.p10_ms,
                    if a.measured {
                        "acknowledged"
                    } else {
                        "delivered"
                    },
                    floor,
                    self.tracker.head_start().map_or(0, |h| h.sent_ms),
                    reserve
                );
            }
        } else if was_low && !is_low {
            log::info!(
                "[SpeakerMonitor] {} stream={}: reserve recovered (reserve={})",
                speaker_ip,
                stream_id,
                reserve
            );
        }

        let due = draining_warning_due(
            &mut self.draining_warned,
            state,
            ttf,
            self.tracker.clock_drains(),
        );
        if let (true, Some(secs)) = (due, ttf) {
            log::warn!(
                "[SpeakerMonitor] {} stream={}: reserve draining: the speaker plays {} faster \
                 than the audio arrives, leaving about {} before it runs low (reserve={}). A live \
                 source cannot catch up; expect dropouts after that until playback is restarted",
                speaker_ip,
                stream_id,
                format_clock(clock),
                format_duration(Duration::from_secs_f64(secs)),
                reserve
            );
        }

        self.emit_health(stream_id, speaker_ip, state, emitter);
    }

    /// Steps the drift controller with this report's estimate and hands the
    /// connection's adapter the command at once, rather than at the next
    /// monitor tick.
    fn step_drift(
        &mut self,
        tap: &ConnectionTap,
        now: Instant,
        estimate: Option<crate::services::speaker_monitor::ReserveEstimate>,
    ) {
        // A forced rate drives the reserve for a listening test: the
        // controller would learn from a level it is not steering and wind its
        // integral up towards the cap, then hand that to the next connection.
        if tap.rate_control().is_some_and(|c| c.forced_ppm().is_some()) {
            return;
        }
        let stale = self.consecutive_failures >= BACKOFF_AFTER_FAILURES || self.is_stale();
        self.drift.update(&ControlInput {
            now_s: now
                .saturating_duration_since(self.drift_origin)
                .as_secs_f64(),
            estimate,
            target_ms: self.tracker.target_ms(),
            head_start_ms: self.tracker.head_start().map(|h| h.sent_ms),
            clock: self.tracker.clock(),
            stale,
            settling: self.tracker.control_hold(),
            carry: self.tracker.carry(),
        });
        self.refresh_rate_command(tap);
    }

    /// The rate correction in force on `tap`'s audio, in ppm: the rate
    /// `THAUMIC_DRIFT_FORCE_PPM` fixed its adapter at for a listening test,
    /// else what the controller applies. The reserve's net drain follows the
    /// audio actually sent, so a forced rate counts even with the mode off,
    /// and nothing counts once the net-insertion guard has pinned the
    /// adapter at 0 ppm.
    fn command_in_force(&self, tap: &ConnectionTap) -> f64 {
        match tap.rate_control() {
            Some(c) if c.is_pinned() => 0.0,
            Some(c) => c.forced_ppm().unwrap_or_else(|| self.drift.applied_ppm()),
            None => self.drift.applied_ppm(),
        }
    }

    /// Writes the drift command into the connection's rate control, if its
    /// audio is corrected. Called on every monitor tick as well as each
    /// report, so the cadence's watchdog only lapses the command if the
    /// monitor has stopped.
    fn refresh_rate_command(&self, tap: &ConnectionTap) {
        if let Some(control) = tap.rate_control() {
            control.set_ppm(self.drift.applied_ppm());
        }
    }

    /// Steps the speaker's notice with what this report found, and logs a
    /// new or escalated one.
    #[allow(clippy::too_many_arguments)]
    fn decide_notice(
        &mut self,
        stream_id: &str,
        speaker_ip: IpAddr,
        tap: &ConnectionTap,
        now: Instant,
        locked: bool,
        acked: Option<crate::services::speaker_monitor::AckedReserve>,
        brk: Option<SegmentBreak>,
        time_to_floor_s: Option<f64>,
    ) {
        let input = NoticeInput {
            locked,
            acked,
            offset_step: brk == Some(SegmentBreak::OffsetStep),
            pre_break: self.tracker.pre_break(),
            head_start: self.tracker.head_start(),
            stall_ms: self.tracker.stall_ms(),
            link_poor: tap.link_verdict() == Some(LinkQuality::Poor),
            time_to_floor_s,
            net_drift_ppm: self.tracker.net_drain_ppm(),
            clock_drained_ms: self.tracker.clock_drained_ms(),
            target_ms: self.tracker.target_ms(),
            drift_active: drift_active(self.drift.mode(), tap.rate_control().map(|c| &**c)),
            saturated: self.drift.saturated(),
        };
        let before = self.notices.active();
        let notice = self.notices.update(now, &input);
        let before_cause = before.and_then(|n| n.cause);
        let before = before.map(|n| n.notice_id);
        if let Some(n) = notice.filter(|n| Some(n.notice_id) == before && n.cause != before_cause) {
            // A standing notice that gained its cause in place keeps its id,
            // so a client does not show it again; the log still says why.
            log::info!(
                "[SpeakerMonitor] {} stream={}: notice {} id={} cause={}",
                speaker_ip,
                stream_id,
                n.kind,
                n.notice_id,
                n.cause.map_or("\u{2014}", |c| c.as_str())
            );
        } else if let Some(n) = notice.filter(|n| Some(n.notice_id) != before) {
            let opt = |v: Option<u32>| v.map_or_else(|| "\u{2014}".to_string(), |v| v.to_string());
            log::warn!(
                "[SpeakerMonitor] {} stream={}: notice {} id={}: stall={}ms left={}ms H={}ms \
                 suggested={}ms minutes={} restart_helps={} cause={}",
                speaker_ip,
                stream_id,
                n.kind,
                n.notice_id,
                opt(n.stall_ms),
                n.left_ms
                    .map_or_else(|| "\u{2014}".to_string(), |v| v.to_string()),
                opt(n.head_start_ms),
                opt(n.suggested_head_start_ms),
                opt(n.minutes),
                n.restart_helps,
                n.cause.map_or("\u{2014}", |c| c.as_str())
            );
        } else if notice.is_none() {
            if let Some(id) = before {
                log::info!(
                    "[SpeakerMonitor] {} stream={}: notice id={} cleared",
                    speaker_ip,
                    stream_id,
                    id
                );
            }
        }
    }

    /// The monitor's view of the speaker, from its latest report and what
    /// the polls have shown since.
    fn health_state(&self) -> MonitorState {
        let stale = self.consecutive_failures >= BACKOFF_AFTER_FAILURES || self.is_stale();
        self.tracker.state(self.dormant, stale)
    }

    /// Whether clients are told about this speaker's health: whenever it is
    /// polled, or would be but for playing something else.
    fn reports_health(&self) -> bool {
        self.monitor || self.emit_events
    }

    /// Sends the speaker's health, with the figures of its latest report, to
    /// clients.
    fn emit_health(
        &mut self,
        stream_id: &str,
        speaker_ip: IpAddr,
        state: MonitorState,
        emitter: &dyn EventEmitter,
    ) {
        self.health_reported = Some(state);
        emitter.emit_network(self.health_event(stream_id, speaker_ip, state));
    }

    /// The speaker health event for `state`, with the figures of the latest
    /// report.
    fn health_event(
        &self,
        stream_id: &str,
        speaker_ip: IpAddr,
        state: MonitorState,
    ) -> NetworkEvent {
        let estimate = self.tracker.last_estimate();
        let acked = self.tracker.last_acked();
        let clock = self.tracker.clock();
        let ms = |v: f64| v.round() as i32;
        let unsigned_ms = |v: f64| v.max(0.0).round() as u32;
        let head_start = self.tracker.head_start();
        NetworkEvent::SpeakerHealth {
            stream_id: stream_id.to_string(),
            speaker_ip: speaker_ip.to_string(),
            epoch_id: self.last_epoch_id,
            state: state.into(),
            reserve_ms: estimate.map(|e| ms(e.reserve_ms)),
            reserve_precision_ms: estimate.map(|e| e.half_width_ms.max(0.0).round() as u32),
            reserve_min_ms: acked.map(|a| ms(a.min_ms)),
            reserve_p10_ms: acked.map(|a| ms(a.p10_ms)),
            reserve_acked: acked.is_some_and(|a| a.measured),
            target_ms: self.tracker.target_ms().map(ms),
            head_start_ms: head_start.map(|h| h.sent_ms),
            head_start_configured_ms: head_start.map(|h| h.configured_ms),
            floor_ms: self.tracker.floor_ms().map(unsigned_ms),
            stall_ms: self.tracker.stall_ms().map(unsigned_ms),
            clock_ppm: clock.map(|c| c.ppm as f32),
            clock_se_ppm: clock.map(|c| c.se_ppm as f32),
            time_to_floor_s: self.tracker.time_to_floor_s().map(unsigned_ms),
            drift_mode: self.pcm.then(|| self.drift.mode()),
            command_ppm: (self.pcm && self.drift.mode() != DriftMode::Off)
                .then(|| self.drift.command_ppm() as f32),
            net_inserted_ms: self.live_tap().and_then(|t| t.net_inserted_ms()).map(ms),
            notice: self.notices.active(),
            timestamp: now_millis(),
        }
    }

    /// The current connection, if it is still open.
    fn live_tap(&self) -> Option<Arc<ConnectionTap>> {
        self.tap.as_ref().and_then(Weak::upgrade)
    }

    /// Whether the speaker is to be polled at all while its connection is open.
    fn wants_polls(&self) -> bool {
        (self.emit_events || self.monitor) && !self.dormant
    }

    /// Whether this session counts against the monitor-only poll ceiling.
    fn polls_for_monitoring_only(&self) -> bool {
        self.monitor
            && !self.emit_events
            && !self.dormant
            && self.tap.as_ref().is_some_and(|t| t.strong_count() > 0)
    }

    /// Syncs with the epoch of the speaker's current connection.
    ///
    /// Resets session if epoch changed, but seeds EMA with previous value
    /// to avoid "jump to 0 then climb back" behavior.
    fn sync_epoch(&mut self, epoch: PlaybackEpoch) {
        if epoch.id != self.last_epoch_id {
            if self.last_epoch_id > 0 {
                log::info!(
                    "[LatencyMonitor] Epoch changed {} -> {}, resetting (seeding with {}ms)",
                    self.last_epoch_id,
                    epoch.id,
                    self.ema_latency as u64
                );
                // Preserve last EMA as seed for new epoch
                let seed_latency = self.ema_latency;
                self.reset_all();
                self.ema_latency = seed_latency;
            }
            self.last_epoch_id = epoch.id;
        }
    }

    /// Whether the session has had no valid position for
    /// [`STALE_EPOCH_TIMEOUT_SECS`], having had one before.
    fn is_stale(&self) -> bool {
        self.last_valid_position
            .is_some_and(|at| at.elapsed().as_secs() > STALE_EPOCH_TIMEOUT_SECS)
    }

    /// Records that we received valid position info (for stale detection).
    /// Also clears stale_emitted flag so we can emit again if it goes stale later.
    fn record_valid_position(&mut self) {
        self.last_valid_position = Some(Instant::now());
        self.stale_emitted = false;
    }

    /// Marks that we've emitted a stale event (to prevent spam).
    fn mark_stale_emitted(&mut self) {
        self.stale_emitted = true;
    }

    /// Returns true if we should emit a stale event (not already emitted).
    fn should_emit_stale(&self) -> bool {
        !self.stale_emitted
    }

    /// Returns the last epoch ID we measured against.
    fn last_epoch_id(&self) -> u64 {
        self.last_epoch_id
    }

    /// Calculates absolute end-to-end latency for video sync.
    ///
    /// Latency = stream_elapsed - (sonos_reltime + offset)
    /// - `stream_elapsed` = time since audio epoch (T0 for this Sonos connection)
    /// - `sonos_reltime` = Sonos playback position (adjusted for RTT and offset)
    ///
    /// When Sonos restarts its track position (due to metadata updates), we
    /// recalculate the offset to maintain the current latency estimate, avoiding
    /// accumulation of errors from Sonos's 1-second precision.
    ///
    /// This measures the total pipeline delay: the time between audio being
    /// captured at the source and being played by Sonos.
    fn calculate_latency(
        &mut self,
        stream_elapsed_ms: u64,
        sonos_reltime_ms: u64,
        rtt_ms: u32,
    ) -> i64 {
        // Detect track restart: RelTime went backwards
        // When this happens, recalculate offset to maintain current latency estimate
        // This avoids accumulating errors from Sonos's 1-second precision
        if let Some(last_reltime) = self.last_sonos_reltime_ms {
            if sonos_reltime_ms < last_reltime.saturating_sub(100) {
                // Calculate offset to maintain current EMA latency
                // latency = stream - (sonos + offset) => offset = stream - sonos - latency
                let target_latency = self.ema_latency.max(0.0) as u64;
                let rtt_adj = (rtt_ms / 2) as u64;
                self.sonos_offset_ms = stream_elapsed_ms
                    .saturating_sub(sonos_reltime_ms)
                    .saturating_sub(rtt_adj)
                    .saturating_sub(target_latency);
                log::info!(
                    "[LatencyMonitor] Track restart: reltime {} -> {}, maintaining ~{}ms latency (offset={}ms)",
                    last_reltime,
                    sonos_reltime_ms,
                    target_latency,
                    self.sonos_offset_ms
                );
            }
        }
        self.last_sonos_reltime_ms = Some(sonos_reltime_ms);

        // Apply offset and RTT adjustment to get continuous Sonos position
        let continuous_sonos_ms = sonos_reltime_ms
            .saturating_add(self.sonos_offset_ms)
            .saturating_add((rtt_ms / 2) as u64);

        // Absolute latency = (time since audio epoch) - (continuous Sonos position)
        // Positive = audio in pipeline waiting to be played (normal)
        let latency_ms = (stream_elapsed_ms as i64) - (continuous_sonos_ms as i64);

        log::trace!(
            "[LatencyMonitor] stream={}ms, sonos={}ms (continuous={}ms, offset={}ms), latency={}ms",
            stream_elapsed_ms,
            sonos_reltime_ms,
            continuous_sonos_ms,
            self.sonos_offset_ms,
            latency_ms
        );

        latency_ms
    }

    /// Records a new latency measurement and updates statistics.
    ///
    /// Uses Welford's online algorithm for incremental variance calculation,
    /// avoiding heap allocation on each update.
    fn record_latency(&mut self, latency_ms: i64) {
        let value = latency_ms as f64;

        let started = *self.trend_started.get_or_insert_with(Instant::now);
        self.trend.add(started.elapsed().as_secs_f64(), value);
        self.last_raw_ms = latency_ms;
        self.window_min_ms = self.window_min_ms.min(latency_ms);
        self.window_max_ms = self.window_max_ms.max(latency_ms);

        // Update EMA
        if self.sample_count == 0 {
            self.ema_latency = value;
        } else {
            self.ema_latency = EMA_ALPHA * value + (1.0 - EMA_ALPHA) * self.ema_latency;
        }

        // Welford's online algorithm for incremental mean and variance
        self.sample_count += 1;
        let delta = value - self.running_mean;
        self.running_mean += delta / self.sample_count as f64;
        let delta2 = value - self.running_mean;
        self.running_m2 += delta * delta2;
    }

    /// Returns the current latency estimate in milliseconds.
    fn latency_ms(&self) -> u64 {
        self.ema_latency.max(0.0) as u64
    }

    /// Returns the current jitter (standard deviation) in milliseconds.
    ///
    /// Uses incrementally computed standard deviation from Welford's algorithm.
    fn jitter_ms(&self) -> u64 {
        if self.sample_count < 2 {
            return 0;
        }
        let variance = self.running_m2 / self.sample_count as f64;
        variance.sqrt().max(0.0) as u64
    }

    /// Returns the confidence score (0.0 - 1.0) based on measurement stability.
    ///
    /// Uses incrementally computed standard deviation - no heap allocation.
    fn confidence(&self) -> f32 {
        if self.sample_count < MIN_SAMPLES_FOR_CONFIDENCE {
            return 0.3; // Low confidence until we have enough samples
        }

        // Calculate standard deviation from running variance
        let variance = self.running_m2 / self.sample_count as f64;
        let std_dev = variance.sqrt();

        // Higher confidence if measurements are consistent
        match std_dev {
            d if d < 50.0 => 0.95,
            d if d < 100.0 => 0.85,
            d if d < 200.0 => 0.70,
            d if d < 500.0 => 0.50,
            _ => 0.30,
        }
    }

    /// Returns true if enough time has passed to emit an update (rate limiting).
    fn should_emit(&self) -> bool {
        match self.last_emit {
            Some(last) => last.elapsed() >= Duration::from_millis(1000),
            None => self.sample_count >= MIN_SAMPLES_FOR_CONFIDENCE,
        }
    }

    /// Marks that we just emitted an update.
    fn mark_emitted(&mut self) {
        self.last_emit = Some(Instant::now());
    }

    /// How long after `now` the speaker's next position poll should be sent,
    /// if that falls before `now + horizon`; `None` if it is due later.
    ///
    /// The monitor only wakes every [`POLL_INTERVAL_MS`], so a poll sent on
    /// the wake-up that noticed it was due would land on that 500 ms grid,
    /// and every poll would hit one of two points in the speaker's second.
    /// The dither is then lost and the reserve bounds cannot narrow below
    /// half a second. Returning the delay lets the poll be sent at its own
    /// dithered moment instead.
    fn poll_start_delay(&self, now: Instant, horizon: Duration) -> Option<Duration> {
        let Some(at) = self.last_poll else {
            return Some(Duration::ZERO);
        };
        let due = at + self.next_poll_after;
        (due < now + horizon).then(|| due.saturating_duration_since(now))
    }

    /// Records a poll and draws the dithered interval before the next one.
    ///
    /// Video sync polls every [`POLL_INTERVAL_MS`] plus up to
    /// [`POLL_DITHER_MS`]; a monitor-only speaker every
    /// [`MONITOR_POLL_INTERVAL_MS`] plus up to [`MONITOR_POLL_DITHER_MS`],
    /// stretched when `monitor_only_sessions` would otherwise exceed
    /// [`SPEAKER_MONITOR_MAX_POLLS_PER_MIN`]. The dither is a random draw
    /// (see [`DitherRng`]), so it is independent of the speaker's own second
    /// boundaries and of when the monitor wakes. A speaker that has stopped
    /// answering is polled every [`BACKOFF_POLL_INTERVAL_MS`].
    #[cfg(test)]
    fn mark_polled(&mut self, monitor_only_sessions: usize) {
        self.mark_polled_at(Instant::now(), monitor_only_sessions);
    }

    /// As [`Self::mark_polled`], for a poll that will be sent at `sent_at`.
    fn mark_polled_at(&mut self, sent_at: Instant, monitor_only_sessions: usize) {
        self.last_poll = Some(sent_at);
        if self.consecutive_failures >= BACKOFF_AFTER_FAILURES {
            self.next_poll_after = Duration::from_millis(BACKOFF_POLL_INTERVAL_MS);
            return;
        }
        let interval_ms = if self.emit_events {
            POLL_INTERVAL_MS + self.next_dither_ms(POLL_DITHER_MS)
        } else {
            let dither_ms = self.next_dither_ms(MONITOR_POLL_DITHER_MS);
            monitor_poll_interval_ms(dither_ms, monitor_only_sessions)
        };
        self.next_poll_after = Duration::from_millis(interval_ms);
    }

    /// Draws a poll dither, uniform in `[0, span)` milliseconds.
    fn next_dither_ms(&mut self, span: u64) -> u64 {
        self.dither.below(span)
    }

    /// Writes the cushion, its extremes since the last line and its trend to
    /// the log every [`DIAGNOSTIC_LOG_INTERVAL_SECS`], and warns when the
    /// cushion is nearly gone or shrinking fast enough to be gone soon.
    ///
    /// This is what tells a field log apart: a stream whose server-side
    /// pipeline looks perfect can still go choppy for good if the speaker's
    /// cushion drains, and nothing else in the log can see that.
    fn log_diagnostics(&mut self, stream_id: &str, speaker_ip: &str, rtt_ms: u32) {
        let raw = self.last_raw_ms;
        if raw < LOW_CUSHION_MS && !self.low_cushion_warned {
            self.low_cushion_warned = true;
            log::warn!(
                "[LatencyMonitor] stream={}, speaker={}: cushion nearly exhausted ({}ms of audio \
                 ahead of the playhead); expect dropouts until playback is restarted",
                stream_id,
                speaker_ip,
                raw
            );
        } else if raw >= LOW_CUSHION_CLEAR_MS {
            self.low_cushion_warned = false;
        }

        let due = match self.last_diag_log {
            None => self.sample_count >= MIN_SAMPLES_FOR_CONFIDENCE,
            Some(at) => at.elapsed().as_secs() >= DIAGNOSTIC_LOG_INTERVAL_SECS,
        };
        if !due {
            return;
        }
        self.last_diag_log = Some(Instant::now());

        let fitted = self.trend.fit();
        let trend = match fitted {
            Some(t) if self.trend.span_secs >= TREND_MIN_SPAN_SECS => format!(
                "{:+.1}\u{b1}{:.1}ms/min over {:.0}s",
                t.slope_ms_per_min, t.error_ms_per_min, self.trend.span_secs
            ),
            Some(_) => format!("(settling, {:.0}s of samples)", self.trend.span_secs),
            None => "(no trend yet)".to_string(),
        };
        log::info!(
            "[LatencyMonitor] stream={}, speaker={}: cushion={}ms (last {}ms, {}..{}ms since last \
             line, jitter {}ms), trend {}, rtt={}ms",
            stream_id,
            speaker_ip,
            self.latency_ms(),
            raw,
            self.window_min_ms,
            self.window_max_ms,
            self.jitter_ms(),
            trend,
            rtt_ms
        );
        self.window_min_ms = i64::MAX;
        self.window_max_ms = i64::MIN;

        if let Some(t) = fitted {
            let v = t.slope_ms_per_min;
            if self.trend.span_secs >= TREND_MIN_SPAN_SECS
                && v <= -TREND_WARN_MS_PER_MIN
                && t.is_significant()
            {
                let minutes_left = self.ema_latency.max(0.0) / -v;
                let warn_due = self
                    .last_trend_warning
                    .map_or(true, |at| at.elapsed().as_secs() >= 60);
                if minutes_left <= TREND_WARN_HORIZON_MIN && warn_due {
                    self.last_trend_warning = Some(Instant::now());
                    log::warn!(
                        "[LatencyMonitor] stream={}, speaker={}: cushion shrinking {:.1}\u{b1}{:.1}ms/min; \
                         at this rate the speaker runs dry in ~{:.1} min. The speaker is consuming audio \
                         faster than the source produces it (clock drift), and a live source cannot catch up.",
                        stream_id,
                        speaker_ip,
                        v,
                        t.error_ms_per_min,
                        minutes_left
                    );
                }
            }
        }
    }
}

/// The widest gap between the polls' phases in the second, `phases` being
/// each poll's position in the second in ms (`[0, 1000)`), counting the gap
/// that wraps from the last phase round to the first. `None` without polls.
///
/// The reserve bounds narrow only as far as the polls fill the second, so
/// this is what limits how tight an estimate can get: ~72 well-spread polls
/// leave gaps of a few tens of ms, a lattice of four points leaves 250.
fn largest_phase_gap_ms(phases: &mut [f64]) -> Option<f64> {
    phases.sort_unstable_by(f64::total_cmp);
    let (first, last) = (*phases.first()?, *phases.last()?);
    let inner = phases.windows(2).map(|w| w[1] - w[0]).fold(0.0, f64::max);
    Some(inner.max(first + 1000.0 - last))
}

/// Interval before a monitor-only speaker's next poll, given its dither and
/// how many monitor-only speakers share the process ceiling.
fn monitor_poll_interval_ms(dither_ms: u64, monitor_only_sessions: usize) -> u64 {
    let base = MONITOR_POLL_INTERVAL_MS + dither_ms;
    let demand = monitor_only_sessions as u64 * MONITOR_POLLS_PER_MIN;
    if demand <= SPEAKER_MONITOR_MAX_POLLS_PER_MIN {
        base
    } else {
        base * demand / SPEAKER_MONITOR_MAX_POLLS_PER_MIN
    }
}

/// Polls each of `monitor_only_sessions` monitor-only speakers gets over a
/// reserve window, at the mean dither and under the process ceiling.
fn monitor_polls_per_window(monitor_only_sessions: usize) -> f64 {
    let interval = monitor_poll_interval_ms(MONITOR_POLL_DITHER_MS / 2, monitor_only_sessions);
    RESERVE_WINDOW_MS / interval as f64
}

/// Whether `monitor_only_sessions` share the process ceiling so thinly that
/// each gets fewer than [`HOLD_MIN_POLLS`] polls a window, and so cannot hold
/// a reserve lock.
fn monitor_capacity_exceeded(monitor_only_sessions: usize) -> bool {
    monitor_polls_per_window(monitor_only_sessions) < HOLD_MIN_POLLS as f64
}

/// Time since a connection's audio epoch, counting audio drift correction
/// inserted (or removed) as if it had been captured: the speaker's playhead
/// runs through it, so the latency is measured against it too.
fn elapsed_with_inserted(stream_elapsed_ms: u64, net_inserted_ms: f64) -> u64 {
    (stream_elapsed_ms as f64 + net_inserted_ms)
        .round()
        .max(0.0) as u64
}

/// Milliseconds from `origin` to `at`, zero if `at` is earlier.
fn ms_between(origin: Instant, at: Instant) -> f64 {
    at.saturating_duration_since(origin).as_secs_f64() * 1000.0
}

/// A duration for the log: `4.5s`, `12m05s`, `1h23m`.
fn format_duration(d: Duration) -> String {
    let secs = d.as_secs();
    if secs < 60 {
        format!("{:.1}s", d.as_secs_f64())
    } else if secs < 3600 {
        format!("{}m{:02}s", secs / 60, secs % 60)
    } else {
        format!("{}h{:02}m", secs / 3600, (secs % 3600) / 60)
    }
}

/// Steps the draining warning's hysteresis for one report and returns
/// whether to warn now. It fires once on entering [`MonitorState::Draining`]
/// and is re-armed only when the projection recovers past
/// [`DRAINING_CLEAR_SECS`], or lapses because the clock no longer drains.
/// A projection that lapses while the clock still drains (the estimate
/// briefly unlocked, or cleared by an offset step) leaves it fired.
fn draining_warning_due(
    warned: &mut bool,
    state: MonitorState,
    tte: Option<f64>,
    clock_drains: bool,
) -> bool {
    let draining = state == MonitorState::Draining
        || (state == MonitorState::Low
            && tte.is_some_and(|s| {
                s < crate::services::speaker_monitor::tracker::DRAINING_WARN_SECS
            }));
    match tte {
        Some(_) if draining => !std::mem::replace(warned, true),
        Some(secs) if secs >= DRAINING_CLEAR_SECS => {
            *warned = false;
            false
        }
        None if !clock_drains => {
            *warned = false;
            false
        }
        _ => false,
    }
}

/// Logs what a continuation switch came to: one line per switch, at info
/// (debug for a switch between segments too short to measure, which comes
/// round every few seconds in a test configuration).
fn log_switch_outcome(stream_id: &str, speaker_ip: IpAddr, outcome: SwitchOutcome) {
    match outcome {
        SwitchOutcome::Absorbed { offset_ms } => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: the speaker counts RelTime \
             {:+.0}ms differently on the new segment; absorbed, the reserve carries on",
            speaker_ip,
            stream_id,
            offset_ms
        ),
        SwitchOutcome::Steady { offset_ms } => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: the reserve carries on \
             ({:+.0}ms measured, within measuring error); nothing absorbed",
            speaker_ip,
            stream_id,
            offset_ms
        ),
        SwitchOutcome::Rejected { offset_ms } => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: the reserve stepped {:+.0}ms, \
             too far for a reporting offset; not absorbed",
            speaker_ip,
            stream_id,
            offset_ms
        ),
        SwitchOutcome::Unmeasured(SwitchUnmeasured::ShortSegment) => log::debug!(
            "[SpeakerMonitor] {} stream={}: continuation switch after a short segment; \
             offset not measured",
            speaker_ip,
            stream_id
        ),
        SwitchOutcome::Unmeasured(SwitchUnmeasured::NotTight) => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: offset not measured yet \
             (not_tight); reporting the new segment's own reserve, the drift controller \
             holds until it is measured",
            speaker_ip,
            stream_id
        ),
        SwitchOutcome::Unmeasured(why) => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: offset not measured ({})",
            speaker_ip,
            stream_id,
            why.as_str()
        ),
    }
}

/// A clock estimate for the log: `+39.8±7.1ppm(31m)`, positive when the
/// speaker plays faster than we deliver.
fn format_clock(clock: Option<crate::services::speaker_monitor::ClockEstimate>) -> String {
    clock.map_or_else(
        || "\u{2014}".to_string(),
        |c| {
            format!(
                "{:+.1}\u{b1}{:.1}ppm({}m)",
                c.ppm,
                c.se_ppm,
                (c.span_ms / 60_000.0).round()
            )
        },
    )
}

/// The acknowledged reserve over a report's window, for the log, and how
/// far its 10th percentile has dropped from the level the connection
/// settled at: ` (acked min30s=431 p10=470) dropped=70`. The acknowledged
/// part is left out where acknowledgements are not measured, and `dropped`
/// until the level is learned.
fn format_acked(
    acked: Option<crate::services::speaker_monitor::AckedReserve>,
    target_ms: Option<f64>,
) -> String {
    let measured = acked
        .filter(|a| a.measured)
        .map(|a| format!(" (acked min30s={:.0} p10={:.0})", a.min_ms, a.p10_ms))
        .unwrap_or_default();
    let dropped = acked
        .zip(target_ms)
        .map(|(a, t)| format!(" dropped={:.0}", t - a.p10_ms))
        .unwrap_or_default();
    format!("{measured}{dropped}")
}

/// The head start the connection was sent and the low floor and clear
/// levels sized from it, for the log: `H=500 Hcfg=500 floor=150 clear=250`,
/// with dashes for a compressed connection.
fn format_head_start(tracker: &ReserveTracker) -> String {
    let dash = || "\u{2014}".to_string();
    let head_start = tracker.head_start();
    format!(
        "H={} Hcfg={} floor={} clear={}",
        head_start.map_or_else(dash, |h| h.sent_ms.to_string()),
        head_start.map_or_else(dash, |h| h.configured_ms.to_string()),
        tracker.floor_ms().map_or_else(dash, |f| format!("{f:.0}")),
        tracker.clear_ms().map_or_else(dash, |c| format!("{c:.0}")),
    )
}

/// The cadence queue, delivery gaps and retransmissions over a report's
/// window, for the log.
fn format_pipeline(samples: &[crate::stream::cadence::PipelineSample]) -> String {
    let mut queue: Vec<f64> = samples.iter().map(|s| s.queue_len as f64).collect();
    let queue = WindowStats::of(&mut queue).map_or_else(
        || "\u{2014}".to_string(),
        |q| format!("{:.0}/{:.0}/{:.0}", q.min, q.p10, q.max),
    );
    let gap_max = samples.iter().map(|s| s.max_gap_ms).max();
    let retransmitted: Option<u64> = samples
        .iter()
        .filter_map(|s| s.retransmitted)
        .fold(None, |acc, r| Some(acc.unwrap_or(0) + r));
    format!(
        "queue[min/p10/max]={} gap_max={} retx={}",
        queue,
        gap_max.map_or_else(|| "\u{2014}".to_string(), |g| format!("{g}ms")),
        retransmitted.map_or_else(|| "\u{2014}".to_string(), |r| r.to_string()),
    )
}

/// What drift correction is doing, for the log: `drift=on cmd=+18.0ppm
/// I=+17.6 ins=+54ms` when it corrects the audio, `drift=observe
/// would_cmd=+18.0ppm I=+17.6` when it only works out what it would do, and
/// `drift=off` otherwise. The controller's reason is added when it is not
/// steering (holding, ramping, no target yet, or a distrusted target).
///
/// A rate `THAUMIC_DRIFT_FORCE_PPM` fixed the adapter at is shown as
/// `forced=+150ppm` (with what it has inserted) whatever the mode, since it
/// is what the audio actually gets, and as `forced=+150ppm(pinned)` once
/// the net-insertion guard (`pinned`) holds the adapter at 0 ppm instead.
fn format_drift(
    drift: &DriftController,
    net_inserted_ms: Option<f64>,
    forced_ppm: Option<f64>,
    pinned: bool,
) -> String {
    let base = format_drift_mode(drift, net_inserted_ms.filter(|_| forced_ppm.is_none()));
    match forced_ppm {
        Some(ppm) => {
            let inserted =
                net_inserted_ms.map_or_else(String::new, |ms| format!(" ins={ms:+.0}ms"));
            let pinned = if pinned { "(pinned)" } else { "" };
            format!("{base} forced={ppm:+}ppm{pinned}{inserted}")
        }
        None => base,
    }
}

/// [`format_drift`] without a forced rate.
fn format_drift_mode(drift: &DriftController, net_inserted_ms: Option<f64>) -> String {
    use crate::services::speaker_monitor::ControlHold;
    let mode = drift.mode();
    if mode == DriftMode::Off {
        return "drift=off".to_string();
    }
    let label = if mode == DriftMode::On {
        "cmd"
    } else {
        "would_cmd"
    };
    let hold = match drift.hold() {
        ControlHold::Steering => String::new(),
        other => format!("({})", other.as_str()),
    };
    let saturated = if drift.saturated() { " saturated" } else { "" };
    let inserted = net_inserted_ms.map_or_else(String::new, |ms| format!(" ins={ms:+.0}ms"));
    format!(
        "drift={mode} {label}={:+.1}ppm{hold} I={:+.1}{saturated}{inserted}",
        drift.command_ppm(),
        drift.integral_ppm(),
    )
}

/// What the drift controller learned about a speaker, kept after its session
/// ends so its next cast starts from it.
struct KeptControlState {
    state: SpeakerControlState,
    kept_at: Instant,
}

/// Keeps what a finished session's drift controller learned about its
/// speaker, under the session's key.
fn keep_control_state(
    kept: &mut HashMap<String, KeptControlState>,
    session: &LatencySession,
    now: Instant,
) {
    if let Some(key) = &session.control_key {
        kept.insert(
            key.clone(),
            KeptControlState {
                state: session.drift.state().clone(),
                kept_at: now,
            },
        );
    }
}

/// How close to its target a reserve must come back for the latency a PCM
/// restart added to count as repaid, in ms.
const DEBT_REPAID_MS: f64 = 50.0;

/// Logs, once, that the latency a PCM restart added (see
/// [`crate::stream::Rejoin`]) has been paid back: the locked reserve is
/// back within [`DEBT_REPAID_MS`] of the target the connection settled at
/// before the restart.
fn note_debt_repaid(
    stream_id: &str,
    speaker_ip: IpAddr,
    tap: &ConnectionTap,
    estimate: Option<crate::services::speaker_monitor::ReserveEstimate>,
    target_ms: Option<f64>,
) {
    let Some(debt) = tap.stats().playout.debt() else {
        return;
    };
    let (Some(est), Some(target)) = (estimate.filter(|e| e.locked()), target_ms) else {
        return;
    };
    if est.reserve_ms - target < DEBT_REPAID_MS {
        tap.stats().playout.clear_debt();
        log::info!(
            "[Stream] Continuation debt repaid: stream={} speaker={} seg={} debt_ms={} \
             after_s={}",
            stream_id,
            speaker_ip,
            debt.seg,
            debt.debt_ms,
            debt.since.elapsed().as_secs()
        );
    }
}

/// Household changes noted since the last report, for the end of its line:
/// nothing when there were none.
fn format_topology(changes: &[MemberChange]) -> String {
    if changes.is_empty() {
        return String::new();
    }
    let listed: Vec<String> = changes.iter().map(ToString::to_string).collect();
    format!(" topology[{}]", listed.join("; "))
}

/// Command sent to the latency monitor background task.
enum MonitorCommand {
    /// Send a speaker's measurements to clients for video sync.
    StartVideoSync {
        stream_id: String,
        speaker_ip: IpAddr,
    },
    /// Stop monitoring for a single speaker.
    StopSpeaker {
        stream_id: String,
        speaker_ip: IpAddr,
    },
    /// Stop all monitoring for a stream.
    StopStream { stream_id: String },
    /// Note a household change on every session of a speaker.
    MemberChanged {
        speaker_ip: IpAddr,
        change: MemberChange,
    },
}

/// Where the topology monitor reports household changes that concern a
/// speaker fetching one of our streams.
///
/// Cheap to clone. Nothing it does blocks: a change the monitor cannot take
/// at once is dropped, since it is also in the topology monitor's own log.
#[derive(Clone)]
pub struct MemberChangeSink {
    tx: mpsc::Sender<MonitorCommand>,
    stream_registry: Arc<StreamRegistry>,
}

impl MemberChangeSink {
    /// The streams the speaker at `ip` is fetching right now.
    pub fn streams_fetched_by(&self, ip: IpAddr) -> Vec<String> {
        self.stream_registry.streams_fetched_by(ip)
    }

    /// Adds `change` to the timeline of every session watching the speaker
    /// at `speaker_ip`, whatever stream it is fetching.
    pub fn record(&self, speaker_ip: IpAddr, change: MemberChange) {
        let command = MonitorCommand::MemberChanged {
            speaker_ip: speaker_ip.to_canonical(),
            change,
        };
        if let Err(mpsc::error::TrySendError::Full(_)) = self.tx.try_send(command) {
            log::debug!(
                "[LatencyMonitor] Busy; topology change for {} not added to its timeline",
                speaker_ip
            );
        }
    }
}

/// Latency monitoring service.
///
/// Measures audio playback latency by comparing stream position against
/// Sonos-reported playback position. Uses high-frequency polling and
/// statistical enhancement to achieve sub-second accuracy despite
/// `RelTime` only having second precision.
pub struct LatencyMonitor {
    /// Command sender for the background task.
    command_tx: mpsc::Sender<MonitorCommand>,
    /// Command receiver (taken when start() is called).
    command_rx: parking_lot::Mutex<Option<mpsc::Receiver<MonitorCommand>>>,
    /// Where stream connections register for monitoring.
    registrar: MonitorRegistrar,
    /// Registration receiver (taken when start() is called).
    register_rx: parking_lot::Mutex<Option<mpsc::Receiver<Weak<ConnectionTap>>>>,
    /// Dependencies for the background task.
    sonos: Arc<dyn SonosPlayback>,
    stream_registry: Arc<StreamRegistry>,
    emitter: Arc<dyn EventEmitter>,
    transport_view: Arc<dyn TransportStateView>,
    cancel: CancellationToken,
    /// Task spawner for background tasks.
    spawner: TokioSpawner,
}

impl LatencyMonitor {
    /// Creates a new LatencyMonitor.
    ///
    /// Note: Call `start()` to spawn the background monitoring task.
    /// This must be done from within an async context (Tokio runtime).
    ///
    /// # Arguments
    /// * `sonos` - Sonos client for position queries
    /// * `stream_registry` - Stream registry, to prune sessions of removed streams
    /// * `emitter` - Event emitter for latency updates
    /// * `transport_view` - GENA's view of each speaker's transport state
    /// * `cancel` - Cancellation token for graceful shutdown
    /// * `spawner` - Task spawner for background tasks
    pub fn new(
        sonos: Arc<dyn SonosPlayback>,
        stream_registry: Arc<StreamRegistry>,
        emitter: Arc<dyn EventEmitter>,
        transport_view: Arc<dyn TransportStateView>,
        cancel: CancellationToken,
        spawner: TokioSpawner,
    ) -> Self {
        let (command_tx, command_rx) = mpsc::channel(32);
        let (registrar, register_rx) = MonitorRegistrar::channel();

        Self {
            command_tx,
            command_rx: parking_lot::Mutex::new(Some(command_rx)),
            registrar,
            register_rx: parking_lot::Mutex::new(Some(register_rx)),
            sonos,
            stream_registry,
            emitter,
            transport_view,
            cancel,
            spawner,
        }
    }

    /// Starts the background monitoring task.
    ///
    /// Must be called from within a Tokio runtime context.
    /// Can only be called once; subsequent calls are no-ops.
    pub fn start(&self) {
        let command_rx = self.command_rx.lock().take();
        let register_rx = self.register_rx.lock().take();
        if let (Some(rx), Some(register_rx)) = (command_rx, register_rx) {
            let deps = MonitorDeps {
                sonos: Arc::clone(&self.sonos),
                stream_registry: Arc::clone(&self.stream_registry),
                emitter: Arc::clone(&self.emitter),
                transport_view: Arc::clone(&self.transport_view),
                spawner: self.spawner.clone(),
            };
            let cancel = self.cancel.clone();
            self.spawner.spawn(async move {
                Self::run_monitor(deps, rx, register_rx, cancel).await;
            });
        }
    }

    /// Where stream connections register for monitoring (see
    /// [`crate::stream::EpochHook::with_monitor`]).
    pub fn registrar(&self) -> MonitorRegistrar {
        self.registrar.clone()
    }

    /// Where the topology monitor reports household changes, for the
    /// timelines of the speakers they concern.
    pub fn member_change_sink(&self) -> MemberChangeSink {
        MemberChangeSink {
            tx: self.command_tx.clone(),
            stream_registry: Arc::clone(&self.stream_registry),
        }
    }

    /// Sends a speaker's latency measurements to clients, for video sync.
    ///
    /// Call this when playback starts with video sync. It does not decide
    /// which speaker is polled — the speaker's own fetch does that — but it
    /// makes sure the speaker is polled at the video-sync cadence whatever the
    /// speaker-monitor setting says. If the speaker has not fetched yet, the
    /// request waits for its first fetch; a speaker that never fetches (a
    /// grouped slave) is never polled.
    pub async fn start_video_sync(&self, stream_id: &str, speaker_ip: &str) {
        let Ok(ip) = speaker_ip.parse::<IpAddr>() else {
            log::warn!("[LatencyMonitor] Invalid speaker IP: {}", speaker_ip);
            return;
        };
        let _ = self
            .command_tx
            .send(MonitorCommand::StartVideoSync {
                stream_id: stream_id.to_string(),
                speaker_ip: ip.to_canonical(),
            })
            .await;
    }

    /// Stops all monitoring for a stream (all speakers).
    ///
    /// Call this when a stream is removed.
    pub async fn stop_stream(&self, stream_id: &str) {
        let _ = self
            .command_tx
            .send(MonitorCommand::StopStream {
                stream_id: stream_id.to_string(),
            })
            .await;
    }

    /// Stops monitoring for a single speaker.
    ///
    /// Call this when a speaker is removed from a multi-group cast.
    pub async fn stop_speaker(&self, stream_id: &str, speaker_ip: &str) {
        let Ok(ip) = speaker_ip.parse::<IpAddr>() else {
            return;
        };
        let _ = self
            .command_tx
            .send(MonitorCommand::StopSpeaker {
                stream_id: stream_id.to_string(),
                speaker_ip: ip.to_canonical(),
            })
            .await;
    }

    /// Background task that performs the actual monitoring.
    ///
    /// The loop never awaits a speaker. Each due poll runs in its own task,
    /// bounded by [`POSITION_POLL_TIMEOUT_MS`], and sends its result back on
    /// a channel; the loop applies it to the session, which it alone owns.
    /// A speaker that hangs therefore delays only its own next poll.
    async fn run_monitor(
        deps: MonitorDeps,
        mut command_rx: mpsc::Receiver<MonitorCommand>,
        mut register_rx: mpsc::Receiver<Weak<ConnectionTap>>,
        cancel: CancellationToken,
    ) {
        let MonitorDeps {
            sonos,
            stream_registry,
            emitter,
            transport_view,
            spawner,
        } = deps;
        let mut sessions: HashMap<SessionKey, LatencySession> = HashMap::new();
        // What drift correction learned about speakers whose sessions have
        // ended, by UUID (or address), for their next cast.
        let mut kept_control: HashMap<String, KeptControlState> = HashMap::new();
        // Unbounded is safe: each session has at most one poll in flight.
        let (result_tx, mut result_rx) = mpsc::unbounded_channel::<PollResult>();
        let mut next_poll_id: u64 = 0;
        // Whether the warning that monitor-only speakers are too many to
        // hold a lock has been logged; once per process is enough.
        let mut capacity_warned = false;

        // Use interval instead of sleep to reduce timer allocations and prevent drift.
        // Delay mode skips missed ticks rather than bursting to catch up.
        let mut poll_interval = tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));
        poll_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        log::info!("[LatencyMonitor] Background task started");

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    log::info!("[LatencyMonitor] Shutting down");
                    break;
                }

                Some(tap) = register_rx.recv() => {
                    // A connection that closed before its registration was read
                    // has nothing left to monitor.
                    if let Some(tap) = tap.upgrade() {
                        let uuid = transport_view.speaker_uuid(&tap.speaker_ip.to_string());
                        register_connection(&mut sessions, &mut kept_control, &tap, uuid);
                    }
                }

                Some(cmd) = command_rx.recv() => {
                    match cmd {
                        MonitorCommand::StartVideoSync { stream_id, speaker_ip } => {
                            let key = (stream_id.clone(), speaker_ip);
                            match sessions.get_mut(&key) {
                                Some(existing) => {
                                    existing.emit_events = true;
                                    // Polled from now on, so its connection is
                                    // owed a summary even if monitoring is off.
                                    if existing.live_tap().is_some() {
                                        existing.summary_owed = true;
                                    }
                                }
                                None => {
                                    log::info!(
                                        "[LatencyMonitor] Video sync requested before the speaker's \
                                         first fetch: stream={}, speaker={}",
                                        stream_id, speaker_ip
                                    );
                                    let seed = dither_seed(&key);
                                    sessions.insert(key, LatencySession::new(true, seed));
                                }
                            }
                        }
                        MonitorCommand::StopSpeaker { stream_id, speaker_ip } => {
                            let key = (stream_id.clone(), speaker_ip);
                            if let Some(mut session) = sessions.remove(&key) {
                                let now = Instant::now();
                                session.end_connection(&stream_id, speaker_ip, now);
                                keep_control_state(&mut kept_control, &session, now);
                                log::info!(
                                    "[LatencyMonitor] Stopped monitoring: stream={}, speaker={}",
                                    stream_id, speaker_ip
                                );
                            }
                        }
                        MonitorCommand::StopStream { stream_id } => {
                            let now = Instant::now();
                            sessions.retain(|k, session| {
                                if k.0 != stream_id {
                                    return true;
                                }
                                session.end_connection(&k.0, k.1, now);
                                keep_control_state(&mut kept_control, session, now);
                                false
                            });
                            log::info!(
                                "[LatencyMonitor] Stopped all monitoring for stream={}",
                                stream_id
                            );
                        }
                        MonitorCommand::MemberChanged { speaker_ip, change } => {
                            for ((_, ip), session) in sessions.iter_mut() {
                                if *ip == speaker_ip {
                                    session.note_topology(change.clone());
                                }
                            }
                        }
                    }
                }

                Some(result) = result_rx.recv() => {
                    // The session may have been stopped while its poll was out.
                    if let Some(session) = sessions.get_mut(&result.key) {
                        let gena = transport_view.gena_transport(&result.key.1.to_string());
                        apply_poll_result(session, result, emitter.as_ref(), gena);
                    }
                }

                _ = poll_interval.tick() => {
                    // Walk the sessions, spawning a poll for each one that is due and
                    // collecting finished ones for cleanup. Nothing here awaits.
                    // Use Option to avoid Vec allocation on every poll (common case: none).
                    let now = Instant::now();
                    let tick = Duration::from_millis(POLL_INTERVAL_MS);
                    let monitor_only = sessions
                        .values()
                        .filter(|s| s.polls_for_monitoring_only())
                        .count();
                    if !capacity_warned && monitor_capacity_exceeded(monitor_only) {
                        capacity_warned = true;
                        log::warn!(
                            "[SpeakerMonitor] {} speakers share the monitor's {} polls a minute, \
                             leaving each about {:.0} polls a window against the {} a reserve \
                             estimate needs to stay locked; their reserves will not hold a lock",
                            monitor_only,
                            SPEAKER_MONITOR_MAX_POLLS_PER_MIN,
                            monitor_polls_per_window(monitor_only),
                            HOLD_MIN_POLLS
                        );
                    }
                    let mut finished: Option<Vec<(SessionKey, &'static str)>> = None;
                    kept_control.retain(|_, kept| {
                        now.saturating_duration_since(kept.kept_at) < CONTROL_STATE_IDLE
                    });

                    for (key, session) in sessions.iter_mut() {
                        let (stream_id, speaker_ip) = key;

                        // Sessions are orphaned when StreamGuard::drop removes the stream
                        // without calling stop_stream (e.g., WS handler panic/unexpected exit).
                        if stream_registry.get_stream(stream_id).is_none() {
                            finished
                                .get_or_insert_with(Vec::new)
                                .push((key.clone(), "stream no longer exists"));
                            continue;
                        }

                        let tap = session.live_tap();
                        match &tap {
                            Some(tap) => {
                                if let Some(epoch) = tap.epoch() {
                                    session.sync_epoch(epoch);
                                }
                            }
                            // The connection closed. A monitor-only session waits a
                            // while for the speaker's next fetch to take it over; a
                            // video-sync one is owned by the client that asked for it.
                            None if session.tap.is_some() => {
                                session.end_connection(stream_id, *speaker_ip, now);
                                let lost = *session.tap_lost_at.get_or_insert(now);
                                if !session.emit_events
                                    && now.saturating_duration_since(lost) >= CONNECTION_LOST_GRACE
                                {
                                    finished
                                        .get_or_insert_with(Vec::new)
                                        .push((key.clone(), "connection closed"));
                                    continue;
                                }
                            }
                            // Video sync asked for a speaker that has not fetched yet.
                            None => continue,
                        }

                        // Emit stale once per stale transition. Polling carries on
                        // (at the backoff rate if the speaker has stopped answering),
                        // so the session recovers as soon as it answers again.
                        if !session.dormant && session.is_stale() && session.should_emit_stale() {
                            let epoch_id = session.last_epoch_id();
                            if session.emit_events {
                                emitter.emit_latency(LatencyEvent::Stale {
                                    stream_id: stream_id.clone(),
                                    speaker_ip: speaker_ip.to_string(),
                                    epoch_id,
                                    timestamp: now_millis(),
                                });
                            }
                            session.mark_stale_emitted();
                            log::warn!(
                                "[LatencyMonitor] No valid position for {}s: stream={}, speaker={}, epoch={}",
                                STALE_EPOCH_TIMEOUT_SECS,
                                stream_id,
                                speaker_ip,
                                epoch_id
                            );
                        }

                        let Some(tap) = tap else { continue };
                        // Every tick, so the cadence's watchdog lapses the
                        // command only if this loop stops.
                        session.refresh_rate_command(&tap);
                        let Some(epoch) = tap.epoch() else { continue };
                        if session.wants_polls() && session.pcm {
                            session.sample_ack_lag(&tap);
                        }
                        if session.wants_polls() && session.report_due(now) {
                            session.report(stream_id, *speaker_ip, &tap, now, emitter.as_ref());
                        }
                        // A state change between reports (the speaker paused,
                        // stopped answering or started playing something else)
                        // is sent at once rather than at the next report.
                        if session.reports_health() {
                            let state = session.health_state();
                            if session.health_reported != Some(state) {
                                session.emit_health(stream_id, *speaker_ip, state, emitter.as_ref());
                            }
                        }
                        if !session.wants_polls() || session.in_flight.is_some() {
                            continue;
                        }
                        // Due before the next wake-up: the poll task waits out the
                        // rest so the request goes at its dithered moment.
                        let Some(start_delay) = session.poll_start_delay(now, tick) else {
                            continue;
                        };

                        let gena = transport_view.gena_transport(&speaker_ip.to_string());
                        if session.gate.take_stale_notice(gena.as_ref(), now) {
                            log::info!(
                                "[LatencyMonitor] {}: GENA transport state stale; using polled state",
                                speaker_ip
                            );
                        }
                        let want_transport = session.gate.take_transport_poll(gena.as_ref(), now);

                        session.mark_polled_at(now + start_delay, monitor_only);
                        next_poll_id += 1;
                        session.in_flight = Some(next_poll_id);

                        let poll = poll_position(
                            Arc::clone(&sonos),
                            key.clone(),
                            next_poll_id,
                            epoch,
                            tap,
                            want_transport,
                            result_tx.clone(),
                        );
                        // Send at the poll's own dithered moment, not on the tick.
                        spawner.spawn(async move {
                            if !start_delay.is_zero() {
                                tokio::time::sleep(start_delay).await;
                            }
                            poll.await;
                        });
                    }

                    if let Some(keys) = finished {
                        for (key, reason) in keys {
                            if let Some(mut session) = sessions.remove(&key) {
                                session.end_connection(&key.0, key.1, now);
                                keep_control_state(&mut kept_control, &session, now);
                            }
                            log::info!(
                                "[LatencyMonitor] Ended monitoring ({}): stream={}, speaker={}",
                                reason,
                                key.0,
                                key.1
                            );
                        }
                    }
                }
            }
        }
    }
}

/// What the monitor loop needs besides its channels.
struct MonitorDeps {
    sonos: Arc<dyn SonosPlayback>,
    stream_registry: Arc<StreamRegistry>,
    emitter: Arc<dyn EventEmitter>,
    transport_view: Arc<dyn TransportStateView>,
    spawner: TokioSpawner,
}

/// Hands a connection that has started its epoch to its speaker's session,
/// creating the session on the speaker's first fetch.
///
/// `uuid` is the speaker's RINCON UUID where the topology knows it. What
/// drift correction learned about the speaker is kept under it (under its
/// address until then): a new session starts from what `kept` holds for it,
/// and a session whose key has changed hands over what it had.
fn register_connection(
    sessions: &mut HashMap<SessionKey, LatencySession>,
    kept: &mut HashMap<String, KeptControlState>,
    tap: &Arc<ConnectionTap>,
    uuid: Option<String>,
) {
    let key = (tap.stream_id.clone(), tap.speaker_ip);
    let session = sessions
        .entry(key)
        .or_insert_with_key(|key| LatencySession::new(false, dither_seed(key)));
    let control_key = uuid.unwrap_or_else(|| tap.speaker_ip.to_string());
    if session.control_key.as_deref() != Some(control_key.as_str()) {
        let state = match session.control_key.take() {
            // The topology has named a speaker known so far by address: it
            // is the same speaker, so it keeps what it has learned.
            Some(_) if kept.get(&control_key).is_none() => session.drift.state().clone(),
            _ => kept
                .remove(&control_key)
                .map(|k| k.state)
                .unwrap_or_default(),
        };
        session.drift = DriftController::new(state);
        session.control_key = Some(control_key);
    }
    session.attach(tap);
    let polling = if session.emit_events {
        "video sync"
    } else if tap.monitor {
        "monitoring"
    } else {
        "not polled: speaker monitoring is off"
    };
    log::info!(
        "[LatencyMonitor] Connection registered: stream={}, speaker={}, epoch=#{}, {}",
        tap.stream_id,
        tap.speaker_ip,
        tap.epoch().map_or(0, |e| e.id),
        polling
    );
}

/// Queries one speaker's position, and its transport state when asked, and
/// sends the result back to the monitor.
///
/// Runs as its own task. Each request is abandoned after
/// [`POSITION_POLL_TIMEOUT_MS`] whatever the transport's own timeout, so the
/// session is free to poll again soon after a speaker stops answering.
async fn poll_position(
    sonos: Arc<dyn SonosPlayback>,
    key: SessionKey,
    poll_id: u64,
    epoch: PlaybackEpoch,
    tap: Arc<ConnectionTap>,
    want_transport: bool,
    results: mpsc::UnboundedSender<PollResult>,
) {
    let timeout = Duration::from_millis(POSITION_POLL_TIMEOUT_MS);
    let ip = key.1.to_string();

    // Get time elapsed since audio epoch (T0 for this Sonos connection)
    let stream_elapsed_ms = epoch.audio_epoch.elapsed().as_millis() as u64;

    // Query Sonos position with RTT measurement, bracketed by the audio
    // delivered on either side of it.
    let sent_at = Instant::now();
    let delivered_ms_at_send = tap.delivered_ms();
    let outcome = match tokio::time::timeout(timeout, sonos.get_position_info(&ip)).await {
        Ok(Ok(position)) => Ok(position),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!("no answer within {}ms", POSITION_POLL_TIMEOUT_MS)),
    };
    let answered_at = Instant::now();
    let delivered_ms_at_answer = tap.delivered_ms();
    let net_inserted_ms = tap.net_inserted_ms().unwrap_or(0.0);
    let rtt_ms = answered_at.duration_since(sent_at).as_millis() as u32;
    drop(tap);

    let transport = if want_transport && outcome.is_ok() {
        Some(
            match tokio::time::timeout(timeout, sonos.get_transport_info(&ip)).await {
                Ok(Ok(state)) => Ok(state),
                Ok(Err(e)) => Err(e.to_string()),
                Err(_) => Err(format!("no answer within {}ms", POSITION_POLL_TIMEOUT_MS)),
            },
        )
    } else {
        None
    };

    // The monitor has shut down if this fails; nothing to do.
    let _ = results.send(PollResult {
        key,
        poll_id,
        epoch_id: epoch.id,
        stream_elapsed_ms,
        rtt_ms,
        sent_at,
        answered_at,
        delivered_ms_at_send,
        delivered_ms_at_answer,
        net_inserted_ms,
        outcome,
        transport,
    });
}

/// Applies a finished poll to its session: the latency sample, the
/// diagnostics log and, for video sync, the client event.
///
/// `gena` is what GENA currently says about the speaker's transport.
fn apply_poll_result(
    session: &mut LatencySession,
    poll: PollResult,
    emitter: &dyn EventEmitter,
    gena: Option<GenaTransport>,
) {
    if session.in_flight != Some(poll.poll_id) {
        // An answer for a poll this session is no longer waiting for.
        return;
    }
    session.in_flight = None;
    let (stream_id, speaker_ip) = &poll.key;
    let speaker_ip = speaker_ip.to_string();

    let position = match poll.outcome {
        Ok(p) => p,
        Err(e) => {
            session.consecutive_failures = session.consecutive_failures.saturating_add(1);
            if session.consecutive_failures == BACKOFF_AFTER_FAILURES {
                log::info!(
                    "[LatencyMonitor] speaker={}: {} position polls in a row failed ({}); \
                     polling every {}s until it answers",
                    speaker_ip,
                    BACKOFF_AFTER_FAILURES,
                    e,
                    BACKOFF_POLL_INTERVAL_MS / 1000
                );
            } else {
                log::trace!(
                    "[LatencyMonitor] Failed to get position from {}: {}",
                    speaker_ip,
                    e
                );
            }
            return;
        }
    };
    if session.consecutive_failures >= BACKOFF_AFTER_FAILURES {
        log::info!(
            "[LatencyMonitor] speaker={}: answering position polls again after {} failures",
            speaker_ip,
            session.consecutive_failures
        );
    }
    session.consecutive_failures = 0;

    match poll.transport {
        Some(Ok(state)) => session.gate.observe_polled(state, poll.answered_at),
        Some(Err(e)) => log::trace!(
            "[LatencyMonitor] Failed to get transport state from {}: {}",
            speaker_ip,
            e
        ),
        None => {}
    }

    // The speaker reconnected while the poll was out; the next tick resets
    // the session for the new epoch, and this sample belongs to the old one.
    if poll.epoch_id != session.last_epoch_id() {
        return;
    }

    // Verify Sonos is playing OUR stream (not previous content)
    // Our stream URLs look like: http://192.168.x.x:port/stream/{stream_id}/live.wav
    // (or .../live/{n}.wav for a later segment of a PCM cast, the same stream).
    // A speaker playing something else is left alone until it fetches the
    // stream again, which starts a new epoch and re-arms the session.
    if !position.track_uri.contains(stream_id.as_str()) {
        session.uri_mismatches += 1;
        if session.uri_mismatches >= DORMANT_AFTER_MISMATCHES {
            session.dormant = true;
            log::info!(
                "[LatencyMonitor] stream={}, speaker={}: playing something else ({}); not polling \
                 it until it fetches the stream again",
                stream_id,
                speaker_ip,
                position.track_uri
            );
        } else {
            log::debug!(
                "[LatencyMonitor] Waiting for stream {} (current URI: {})",
                stream_id,
                position.track_uri
            );
        }
        return;
    }
    session.uri_mismatches = 0;

    log::trace!(
        "[LatencyMonitor] URI matched: {} contains {}",
        position.track_uri,
        stream_id
    );

    // A later segment of a PCM cast is the same item to everything below: its
    // URL is taken for the stream's own and its RelTime counted from the
    // playout's start, so a switch of segment is neither a new track nor
    // RelTime going backwards (see `ConnectionTap::continuous_position`).
    // The segment it was counted on tells the tracker when the speaker moves
    // on to the next one.
    let (track_uri, rel_time_ms, timeline) = match session.live_tap() {
        Some(tap) => {
            let mapped = tap.continuous_position(position.track_uri, position.rel_time_ms);
            (mapped.track_uri, mapped.rel_ms, mapped.timeline)
        }
        None => (position.track_uri, position.rel_time_ms, None),
    };

    // The speaker answered about our stream, so the position is valid (for
    // stale detection) even if it is not playing.
    session.record_valid_position();
    session.gate.observe_rel_time(rel_time_ms, poll.answered_at);
    let (verdict, source) = session.gate.verdict(gena.as_ref(), poll.answered_at);
    session.last_transport_source = source;

    // Bound the reserve and the clock from this poll. A poll while the
    // speaker is known not to be playing ends the segment instead.
    if let Some(origin) = session.connected_at {
        let not_playing = matches!(verdict, TransportVerdict::NotPlaying(_));
        let obs = PollObservation {
            ts: ms_between(origin, poll.sent_at),
            tr: ms_between(origin, poll.answered_at),
            rel_ms: rel_time_ms,
            d_ts_ms: poll.delivered_ms_at_send.unwrap_or(0) as f64,
            d_tr_ms: poll.delivered_ms_at_answer.unwrap_or(0) as f64,
        };
        if let Some(brk) = session
            .tracker
            .observe_on(&obs, &track_uri, not_playing, timeline)
        {
            log::info!(
                "[SpeakerMonitor] {} stream={}: segment break ({}); measuring afresh",
                speaker_ip,
                stream_id,
                brk
            );
        }
        if !not_playing {
            session.polls_since_report += 1;
            session
                .phases_since_report
                .push(((obs.ts + obs.tr) / 2.0).rem_euclid(1000.0));
        }
    }

    log::debug!(
        "[LatencyMonitor] poll stream={}, speaker={}: rel={}ms rtt={}ms delivered={:?}..{:?}ms \
         span={}ms transport={:?} ({})",
        stream_id,
        speaker_ip,
        rel_time_ms,
        poll.rtt_ms,
        poll.delivered_ms_at_send,
        poll.delivered_ms_at_answer,
        poll.answered_at.duration_since(poll.sent_at).as_millis(),
        verdict,
        source
    );

    // A speaker known not to be playing says nothing about its reserve: its
    // RelTime stands still while the clock runs on.
    if let TransportVerdict::NotPlaying(state) = verdict {
        log::trace!(
            "[LatencyMonitor] speaker={}: {} ({}), poll not measured",
            speaker_ip,
            state,
            source
        );
        return;
    }

    // Calculate absolute latency (handles track restarts via offset). Audio
    // drift correction inserted is played but was never captured, so it
    // counts as source time: without it video sync would drift by as much.
    let latency_ms = session.calculate_latency(
        elapsed_with_inserted(poll.stream_elapsed_ms, poll.net_inserted_ms),
        rel_time_ms,
        poll.rtt_ms,
    );

    session.record_latency(latency_ms);
    // The wall-clock cushion is inflated by our own queue and by the epoch's
    // anchoring, so it is only logged where the reserve cannot be measured.
    if !session.pcm {
        session.log_diagnostics(stream_id, &speaker_ip, poll.rtt_ms);
    }

    // Emit update if appropriate
    if session.emit_events && session.should_emit() {
        let event = LatencyEvent::Updated {
            stream_id: stream_id.clone(),
            speaker_ip: speaker_ip.clone(),
            epoch_id: poll.epoch_id,
            latency_ms: session.latency_ms(),
            jitter_ms: session.jitter_ms(),
            confidence: session.confidence(),
            timestamp: now_millis(),
        };
        emitter.emit_latency(event);
        session.mark_emitted();

        log::debug!(
            "[LatencyMonitor] stream={}, speaker={}: latency={}ms, jitter={}ms, confidence={:.2}",
            stream_id,
            speaker_ip,
            session.latency_ms(),
            session.jitter_ms(),
            session.confidence()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds `minutes` of samples along `cushion(t)`, polled the way the
    /// monitor polls a monitor-only speaker: every two seconds plus a dither
    /// of up to a second, with the speaker's position reported in whole
    /// seconds, so each sample of the cushion is off by up to a second
    /// depending on the phase of the poll.
    fn fit(minutes: f64, cushion: impl Fn(f64) -> f64) -> Trend {
        let mut trend = CushionTrend::default();
        let mut t: f64 = 0.0;
        // Small deterministic LCG for the dither so the test is repeatable.
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        while t <= minutes * 60.0 {
            trend.add(t, observed_cushion(t, cushion(t)));
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let dither = (seed >> 33) as f64 / (1u64 << 31) as f64;
            t +=
                (MONITOR_POLL_INTERVAL_MS as f64 + dither * MONITOR_POLL_DITHER_MS as f64) / 1000.0;
        }
        trend.fit().expect("enough samples")
    }

    /// The cushion the monitor computes at time `t` when the true cushion is
    /// `true_ms`: the speaker reports its playhead floored to a whole second.
    fn observed_cushion(t: f64, true_ms: f64) -> f64 {
        let playhead_ms = t * 1000.0 - true_ms;
        let reported_ms = (playhead_ms / 1000.0).floor() * 1000.0;
        t * 1000.0 - reported_ms
    }

    #[test]
    fn a_steady_cushion_fits_a_flat_trend_within_its_own_error() {
        let trend = fit(10.0, |_| 800.0);
        assert!(
            !trend.is_significant(),
            "flat cushion read as a trend: {trend:?}"
        );
        assert!(trend.error_ms_per_min < 8.0, "{trend:?}");
    }

    #[test]
    fn a_draining_cushion_is_measured_through_the_position_precision() {
        // 40 ms/min: the rate that empties a 200 ms prefill in five minutes.
        let trend = fit(10.0, |t| 800.0 - t * (40.0 / 60.0));
        assert!(trend.is_significant(), "{trend:?}");
        assert!(
            (trend.slope_ms_per_min + 40.0).abs() <= TREND_MIN_SIGMA * trend.error_ms_per_min,
            "{trend:?}"
        );
        assert!(trend.error_ms_per_min < 8.0, "{trend:?}");
    }

    #[test]
    fn a_fixed_poll_phase_would_report_a_confidently_wrong_drift() {
        // Why the poll is dithered: on a fixed cadence the whole-second
        // reporting error creeps with the drift, so the fit sees a clean line
        // with a tiny error at the wrong slope. This documents the failure.
        let mut trend = CushionTrend::default();
        let mut t: f64 = 0.0;
        while t <= 600.0 {
            trend.add(t, observed_cushion(t, 800.0 - t * (40.0 / 60.0)));
            t += 1.0;
        }
        let fitted = trend.fit().expect("enough samples");
        assert!(
            (fitted.slope_ms_per_min + 40.0).abs() > TREND_MIN_SIGMA * fitted.error_ms_per_min,
            "fixed-phase fit happened to be right: {fitted:?}"
        );
    }

    mod dither {
        use super::super::*;

        /// Kolmogorov-Smirnov critical value at p = 0.01 for `n` samples.
        fn ks_critical(n: usize) -> f64 {
            1.628 / (n as f64).sqrt()
        }

        /// Kolmogorov-Smirnov statistic of `samples` against the uniform
        /// distribution on `[0, span)`.
        fn ks_uniform(samples: &mut [f64], span: f64) -> f64 {
            samples.sort_unstable_by(f64::total_cmp);
            let n = samples.len() as f64;
            samples
                .iter()
                .enumerate()
                .map(|(i, x)| {
                    let f = x / span;
                    (f - i as f64 / n).max((i as f64 + 1.0) / n - f)
                })
                .fold(0.0, f64::max)
        }

        /// Sends `count` polls from `session` the way the monitor loop does,
        /// each at its own dithered moment and the first `start_ms` into the
        /// second, and returns where in the second each one went.
        fn poll_phases(session: &mut LatencySession, start_ms: u64, count: usize) -> Vec<f64> {
            let origin = Instant::now();
            let mut sent_ms = start_ms;
            (0..count)
                .map(|_| {
                    session.mark_polled_at(origin + Duration::from_millis(sent_ms), 1);
                    let phase = (sent_ms % 1000) as f64;
                    sent_ms += session.next_poll_after.as_millis() as u64;
                    phase
                })
                .collect()
        }

        /// The same polls under the old dither: read from the wall clock's
        /// sub-second part at the 500 ms wake-up that sent each poll, the
        /// wall clock running `wall_offset_ms` ahead of the wake-ups' grid.
        fn wall_clock_phases(wall_offset_ms: u64, count: usize) -> Vec<f64> {
            let mut sent_ms = 0;
            (0..count)
                .map(|_| {
                    let wake = sent_ms / POLL_INTERVAL_MS * POLL_INTERVAL_MS;
                    let dither = (wake + wall_offset_ms) % MONITOR_POLL_DITHER_MS;
                    let phase = (sent_ms % 1000) as f64;
                    sent_ms += MONITOR_POLL_INTERVAL_MS + dither;
                    phase
                })
                .collect()
        }

        #[test]
        fn dither_draws_cover_the_second() {
            let critical = ks_critical(500);
            for start_ms in [0, 250, 500] {
                let mut session = LatencySession::new(false, 42);
                let mut phases = poll_phases(&mut session, start_ms, 500);
                let d = ks_uniform(&mut phases, 1000.0);
                assert!(
                    d < critical,
                    "monitor-only polls from phase {start_ms}: D={d:.3}"
                );

                let mut video = LatencySession::new(true, 42);
                let mut phases = poll_phases(&mut video, start_ms, 500);
                let d = ks_uniform(&mut phases, 1000.0);
                assert!(
                    d < critical,
                    "video sync polls from phase {start_ms}: D={d:.3}"
                );
            }
            let mut session = LatencySession::new(false, 7);
            let mut draws: Vec<f64> = (0..500)
                .map(|_| session.next_dither_ms(1000) as f64)
                .collect();
            assert!(draws.iter().all(|d| (0.0..1000.0).contains(d)));
            let d = ks_uniform(&mut draws, 1000.0);
            assert!(d < critical, "raw draws: D={d:.3}");
            assert_eq!(session.next_dither_ms(0), 0);
        }

        #[test]
        fn dither_is_independent_of_wall_clock_phase() {
            // The draws depend on the seed alone: the same seed gives the
            // same intervals whenever they are drawn.
            let mut straight = LatencySession::new(false, 99);
            let mut paused = LatencySession::new(false, 99);
            for i in 0..40 {
                straight.mark_polled(1);
                if i % 10 == 0 {
                    std::thread::sleep(Duration::from_millis(3));
                }
                paused.mark_polled(1);
                assert_eq!(straight.next_poll_after, paused.next_poll_after);
            }

            // Where the old wall-clock dither collapsed onto a few points,
            // the draw still fills the second.
            for wall_offset_ms in [0, 2, 250, 252] {
                let mut old = wall_clock_phases(wall_offset_ms, 72);
                let old_gap = largest_phase_gap_ms(&mut old).expect("polls");
                assert!(
                    old_gap >= 245.0,
                    "offset {wall_offset_ms}: the old dither left {old_gap:.0} ms"
                );
                let mut session = LatencySession::new(false, wall_offset_ms);
                let mut new = poll_phases(&mut session, wall_offset_ms, 72);
                let new_gap = largest_phase_gap_ms(&mut new).expect("polls");
                assert!(
                    new_gap < 120.0,
                    "offset {wall_offset_ms}: the draw left {new_gap:.0} ms"
                );
            }
        }

        #[test]
        fn phase_gap_reported_under_120ms_at_72_polls() {
            for seed in 1..=20 {
                let mut session = LatencySession::new(false, seed);
                let mut phases = poll_phases(&mut session, 0, 72);
                let gap = largest_phase_gap_ms(&mut phases).expect("polls");
                assert!(gap < 120.0, "seed {seed}: {gap:.0} ms");
            }
        }

        #[test]
        fn phase_gap_counts_the_gap_that_wraps_round_the_second() {
            assert_eq!(largest_phase_gap_ms(&mut []), None);
            assert_eq!(largest_phase_gap_ms(&mut [400.0]), Some(1000.0));
            assert_eq!(largest_phase_gap_ms(&mut [990.0, 10.0]), Some(980.0));
            assert_eq!(
                largest_phase_gap_ms(&mut [100.0, 900.0, 500.0]),
                Some(400.0)
            );
            assert_eq!(
                largest_phase_gap_ms(&mut [0.0, 250.0, 500.0, 750.0]),
                Some(250.0)
            );
        }

        #[test]
        fn sessions_seeded_from_different_speakers_draw_apart() {
            let ip = |s: &str| s.parse::<IpAddr>().expect("address");
            let a = dither_seed(&("s".to_string(), ip("192.168.1.10")));
            let b = dither_seed(&("s".to_string(), ip("192.168.1.11")));
            assert_ne!(a, b);
        }
    }

    mod polling {
        use super::super::*;
        use crate::error::SoapResult;
        use crate::events::{NetworkEvent, SonosEvent, StreamEvent, TopologyEvent};
        use crate::state::StreamingConfig;
        use crate::stream::tap::test_support::{
            started_tap, started_tap_with_codec, started_tap_with_declared_end,
            started_tap_with_drift,
        };
        use crate::stream::{AudioCodec, AudioFormat, StreamMetadata};
        use async_trait::async_trait;

        const HUNG_IPS: [&str; 3] = ["192.168.1.10", "192.168.1.12", "192.168.1.13"];
        const HUNG_IP: &str = HUNG_IPS[0];
        const HEALTHY_IP: &str = "192.168.1.11";

        /// How long each test watches the speakers.
        const WATCH: Duration = Duration::from_millis(5500);

        /// Speaker double: the [`HUNG_IPS`] never answer within ten seconds,
        /// every other speaker answers at once. Records when each
        /// `GetPositionInfo` call starts.
        struct FakeSpeakers {
            stream_id: String,
            calls: parking_lot::Mutex<Vec<(String, Instant)>>,
        }

        impl FakeSpeakers {
            fn new(stream_id: &str) -> Arc<Self> {
                Arc::new(Self {
                    stream_id: stream_id.to_string(),
                    calls: parking_lot::Mutex::new(Vec::new()),
                })
            }

            fn calls_to(&self, ip: &str) -> Vec<Instant> {
                self.calls
                    .lock()
                    .iter()
                    .filter(|(called, _)| called == ip)
                    .map(|(_, at)| *at)
                    .collect()
            }
        }

        #[async_trait]
        impl SonosPlayback for FakeSpeakers {
            async fn play_uri(
                &self,
                _: &str,
                _: &str,
                _: AudioCodec,
                _: &AudioFormat,
                _: Option<&StreamMetadata>,
                _: &str,
            ) -> SoapResult<()> {
                Ok(())
            }
            async fn set_next_uri(
                &self,
                _: &str,
                _: &crate::sonos::traits::NextItem<'_>,
            ) -> SoapResult<()> {
                Ok(())
            }
            async fn play(&self, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn stop(&self, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn switch_to_queue(&self, _: &str, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn get_position_info(&self, ip: &str) -> SoapResult<PositionInfo> {
                self.calls.lock().push((ip.to_string(), Instant::now()));
                if HUNG_IPS.contains(&ip) {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
                Ok(PositionInfo {
                    track_uri: format!("http://10.0.0.1:1400/stream/{}/live.wav", self.stream_id),
                    rel_time_ms: 0,
                })
            }
            async fn get_transport_info(&self, _: &str) -> SoapResult<TransportState> {
                Ok(TransportState::Playing)
            }
            async fn join_group(&self, _: &str, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn leave_group(&self, _: &str) -> SoapResult<()> {
                Ok(())
            }
        }

        struct NoEvents;

        impl EventEmitter for NoEvents {
            fn emit_stream(&self, _: StreamEvent) {}
            fn emit_sonos(&self, _: SonosEvent) {}
            fn emit_network(&self, _: NetworkEvent) {}
            fn emit_topology(&self, _: TopologyEvent) {}
            fn emit_latency(&self, _: LatencyEvent) {}
        }

        /// Keeps the network events the monitor sends.
        #[derive(Default)]
        struct NetworkEvents(parking_lot::Mutex<Vec<NetworkEvent>>);

        impl NetworkEvents {
            /// The states of the speaker health events sent for `ip`, in order.
            fn health_states(&self, ip: &str) -> Vec<crate::events::SpeakerHealthState> {
                self.0
                    .lock()
                    .iter()
                    .filter_map(|e| match e {
                        NetworkEvent::SpeakerHealth {
                            speaker_ip, state, ..
                        } if speaker_ip == ip => Some(*state),
                        _ => None,
                    })
                    .collect()
            }
        }

        impl EventEmitter for NetworkEvents {
            fn emit_stream(&self, _: StreamEvent) {}
            fn emit_sonos(&self, _: SonosEvent) {}
            fn emit_network(&self, event: NetworkEvent) {
                self.0.lock().push(event);
            }
            fn emit_topology(&self, _: TopologyEvent) {}
            fn emit_latency(&self, _: LatencyEvent) {}
        }

        /// GENA double that has heard nothing.
        struct NoGena;

        impl TransportStateView for NoGena {
            fn gena_transport(&self, _: &str) -> Option<GenaTransport> {
                None
            }
        }

        /// A running monitor over a live stream, and the speaker double it polls.
        struct Harness {
            monitor: LatencyMonitor,
            speakers: Arc<FakeSpeakers>,
            events: Arc<NetworkEvents>,
            stream_id: String,
        }

        impl Harness {
            async fn start(cancel: &CancellationToken) -> Self {
                let registry = Arc::new(StreamRegistry::new(StreamingConfig::default()));
                let stream_id = registry
                    .create_stream(AudioCodec::Pcm, AudioFormat::default(), 200, 10)
                    .expect("stream");
                let speakers = FakeSpeakers::new(&stream_id);
                let events = Arc::new(NetworkEvents::default());
                let monitor = LatencyMonitor::new(
                    Arc::clone(&speakers) as Arc<dyn SonosPlayback>,
                    registry,
                    Arc::clone(&events) as Arc<dyn EventEmitter>,
                    Arc::new(NoGena),
                    cancel.clone(),
                    TokioSpawner::new(tokio::runtime::Handle::current()),
                );
                monitor.start();
                Self {
                    monitor,
                    speakers,
                    events,
                    stream_id,
                }
            }

            /// `ip` fetches the stream: its connection starts an epoch and
            /// registers. The returned tap is the open connection.
            fn fetch(&self, ip: &str, monitor: bool) -> Arc<ConnectionTap> {
                let tap = started_tap(&self.stream_id, ip, monitor);
                self.monitor.registrar().register(&tap);
                tap
            }
        }

        /// Starts a monitor watching three hung speakers and one healthy one,
        /// all already fetching a live stream with video sync, and returns the
        /// speaker double and the open connections.
        async fn watch_hung_and_healthy_speakers(
            cancel: &CancellationToken,
        ) -> (Arc<FakeSpeakers>, Vec<Arc<ConnectionTap>>) {
            let harness = Harness::start(cancel).await;
            let mut taps = Vec::new();
            for ip in HUNG_IPS.iter().chain([&HEALTHY_IP]) {
                taps.push(harness.fetch(ip, false));
                harness
                    .monitor
                    .start_video_sync(&harness.stream_id, ip)
                    .await;
            }
            (harness.speakers, taps)
        }

        #[tokio::test]
        async fn a_hung_speaker_does_not_delay_another_speakers_polls_by_more_than_50ms() {
            let cancel = CancellationToken::new();
            let (speakers, _taps) = watch_hung_and_healthy_speakers(&cancel).await;
            tokio::time::sleep(WATCH).await;
            cancel.cancel();

            let healthy = speakers.calls_to(HEALTHY_IP);
            // At most 1.5 s apart (500 ms plus the full dither): at least four
            // in 5.5 s. A loop that waited out each hung speaker's 1.5 s
            // timeout in turn would be blocked almost the whole time.
            assert!(
                healthy.len() >= 4,
                "healthy speaker polled {} times in {WATCH:?}",
                healthy.len()
            );
            // Each poll is sent at its own dithered moment, so consecutive
            // polls are never further apart than the longest dithered interval.
            // One held up by the hung speaker would overshoot it.
            let longest = POLL_INTERVAL_MS + POLL_DITHER_MS;
            for pair in healthy.windows(2) {
                let gap = pair[1].saturating_duration_since(pair[0]).as_millis() as u64;
                assert!(
                    gap <= longest + 50,
                    "healthy speaker polled {gap} ms after its previous poll"
                );
            }
        }

        /// The monitor wakes every 500 ms, but polls must not land on that
        /// grid: the reserve bounds only narrow if the polls' phase against the
        /// speaker's whole-second RelTime is spread across the second. On the
        /// grid every poll hits one of two phases and the estimate stalls at
        /// about half a second wide, which is what the first field run showed.
        #[tokio::test]
        async fn polls_are_sent_at_their_dithered_moment_not_on_the_tick() {
            let cancel = CancellationToken::new();
            let (speakers, _taps) = watch_hung_and_healthy_speakers(&cancel).await;
            tokio::time::sleep(WATCH).await;
            cancel.cancel();

            let healthy = speakers.calls_to(HEALTHY_IP);
            let first = *healthy.first().expect("speaker was polled");
            let tick = POLL_INTERVAL_MS as u128;
            let off_grid = healthy
                .iter()
                .skip(1)
                .filter(|at| {
                    let offset = at.saturating_duration_since(first).as_millis() % tick;
                    offset.min(tick - offset) > 50
                })
                .count();
            assert!(
                off_grid >= 1,
                "every one of {} polls landed on the monitor's 500 ms tick",
                healthy.len()
            );
        }

        #[tokio::test]
        async fn a_hung_speaker_is_polled_again_only_after_its_poll_times_out() {
            let cancel = CancellationToken::new();
            let (speakers, _taps) = watch_hung_and_healthy_speakers(&cancel).await;
            tokio::time::sleep(WATCH).await;
            cancel.cancel();

            let hung = speakers.calls_to(HUNG_IP);
            assert!(
                hung.len() >= 2,
                "a poll that never answers must be abandoned, not waited on: {} polls",
                hung.len()
            );
            for pair in hung.windows(2) {
                let gap = pair[1].duration_since(pair[0]);
                assert!(
                    gap >= Duration::from_millis(POSITION_POLL_TIMEOUT_MS),
                    "second poll issued {gap:?} after the first, while it was still in flight"
                );
            }
        }

        /// Replaces `a_plain_cast_never_polls_the_speakers`: with monitoring on
        /// (the default) a plain cast polls the speaker that fetches, at the
        /// monitor-only cadence, and never a speaker that does not fetch — a
        /// grouped slave, here one that video sync was even asked for.
        #[tokio::test]
        async fn a_plain_cast_polls_only_fetching_speakers_within_budget() {
            const FETCHING: &str = "192.168.1.20";
            const SLAVE: &str = "192.168.1.21";
            let cancel = CancellationToken::new();
            let harness = Harness::start(&cancel).await;
            let _tap = harness.fetch(FETCHING, true);
            harness
                .monitor
                .start_video_sync(&harness.stream_id, SLAVE)
                .await;

            let watch = Duration::from_millis(6200);
            tokio::time::sleep(watch).await;
            cancel.cancel();

            let polls = harness.speakers.calls_to(FETCHING);
            // First poll at once, then every 2-3 s: two or three in 6.2 s.
            assert!(
                (2..=4).contains(&polls.len()),
                "fetching speaker polled {} times in {watch:?}",
                polls.len()
            );
            for pair in polls.windows(2) {
                assert!(
                    pair[1].duration_since(pair[0])
                        >= Duration::from_millis(MONITOR_POLL_INTERVAL_MS),
                    "monitor-only polls closer than the base interval"
                );
            }
            assert!(
                harness.speakers.calls_to(SLAVE).is_empty(),
                "a speaker that never fetches must never be polled"
            );
        }

        /// Off restores the old behaviour: a plain cast is not polled at all,
        /// and video sync still works.
        #[tokio::test]
        async fn speaker_monitor_off_never_polls() {
            const PLAIN: &str = "192.168.1.30";
            const SYNCED: &str = "192.168.1.31";
            let cancel = CancellationToken::new();
            let harness = Harness::start(&cancel).await;
            let _plain = harness.fetch(PLAIN, false);
            let _synced = harness.fetch(SYNCED, false);
            harness
                .monitor
                .start_video_sync(&harness.stream_id, SYNCED)
                .await;

            tokio::time::sleep(Duration::from_millis(2600)).await;
            cancel.cancel();

            assert!(
                harness.speakers.calls_to(PLAIN).is_empty(),
                "with monitoring off a cast without video sync must not poll"
            );
            assert!(
                harness.speakers.calls_to(SYNCED).len() >= 2,
                "video sync keeps polling whatever the setting"
            );
        }

        /// A monitored speaker's health reaches clients from its first tick,
        /// naming its stream, so a client learns the speaker is measured
        /// before the first 30 s report; an unmonitored plain cast sends none.
        #[tokio::test]
        async fn a_monitored_speaker_reports_its_health_and_an_unmonitored_one_does_not() {
            use crate::events::SpeakerHealthState;
            const MONITORED: &str = "192.168.1.40";
            const PLAIN: &str = "192.168.1.41";
            let cancel = CancellationToken::new();
            let harness = Harness::start(&cancel).await;
            let _monitored = harness.fetch(MONITORED, true);
            let _plain = harness.fetch(PLAIN, false);

            tokio::time::sleep(Duration::from_millis(1200)).await;
            cancel.cancel();

            assert_eq!(
                harness.events.health_states(MONITORED),
                vec![SpeakerHealthState::Locking],
                "one event on the first tick, and no repeat while the state holds"
            );
            let named_stream = harness.events.0.lock().iter().all(|e| match e {
                NetworkEvent::SpeakerHealth { stream_id, .. } => *stream_id == harness.stream_id,
                _ => true,
            });
            assert!(
                named_stream,
                "the event names the stream the speaker fetches"
            );
            assert!(
                harness.events.health_states(PLAIN).is_empty(),
                "a speaker that is not polled has no health to report"
            );
        }

        /// A speaker found playing something else is reported dormant without
        /// the figures of a reserve it is no longer building.
        #[test]
        fn a_dormant_speaker_reports_dormant() {
            let mut session = LatencySession::new(false, 0);
            session.monitor = true;
            session.dormant = true;
            assert!(session.reports_health());
            assert_eq!(session.health_state(), MonitorState::Dormant);
            match session.health_event("stream", HUNG_IP.parse().unwrap(), MonitorState::Dormant) {
                NetworkEvent::SpeakerHealth {
                    state,
                    reserve_ms,
                    target_ms,
                    ..
                } => {
                    assert_eq!(state, crate::events::SpeakerHealthState::Dormant);
                    assert_eq!(reserve_ms, None);
                    assert_eq!(target_ms, None);
                }
                other => panic!("not a speaker health event: {other:?}"),
            }
        }

        fn poll(poll_id: u64, outcome: Result<PositionInfo, String>) -> PollResult {
            PollResult {
                key: ("stream".to_string(), HUNG_IP.parse().unwrap()),
                poll_id,
                epoch_id: 0,
                stream_elapsed_ms: 1000,
                rtt_ms: 10,
                sent_at: Instant::now(),
                answered_at: Instant::now(),
                delivered_ms_at_send: None,
                delivered_ms_at_answer: None,
                net_inserted_ms: 0.0,
                outcome,
                transport: None,
            }
        }

        fn ours(rel_time_ms: u64) -> PositionInfo {
            PositionInfo {
                track_uri: "http://10.0.0.1:1400/stream/stream/live.wav".to_string(),
                rel_time_ms,
            }
        }

        #[test]
        fn three_failed_polls_back_off_until_the_speaker_answers() {
            let mut session = LatencySession::new(true, 0);
            for poll_id in 1..=BACKOFF_AFTER_FAILURES as u64 {
                session.mark_polled(0);
                assert!(session.next_poll_after < Duration::from_millis(BACKOFF_POLL_INTERVAL_MS));
                session.in_flight = Some(poll_id);
                apply_poll_result(
                    &mut session,
                    poll(poll_id, Err("timeout".into())),
                    &NoEvents,
                    None,
                );
                assert_eq!(session.in_flight, None);
            }
            session.mark_polled(0);
            assert_eq!(
                session.next_poll_after,
                Duration::from_millis(BACKOFF_POLL_INTERVAL_MS)
            );

            session.in_flight = Some(99);
            let answer = PositionInfo {
                track_uri: String::new(),
                rel_time_ms: 0,
            };
            apply_poll_result(&mut session, poll(99, Ok(answer)), &NoEvents, None);
            assert_eq!(session.consecutive_failures, 0);
            session.mark_polled(0);
            assert!(session.next_poll_after < Duration::from_millis(BACKOFF_POLL_INTERVAL_MS));
        }

        #[test]
        fn an_answer_to_a_poll_the_session_no_longer_awaits_is_ignored() {
            let mut session = LatencySession::new(true, 0);
            session.in_flight = Some(2);
            apply_poll_result(
                &mut session,
                poll(1, Err("timeout".into())),
                &NoEvents,
                None,
            );
            assert_eq!(session.in_flight, Some(2));
            assert_eq!(session.consecutive_failures, 0);
        }

        #[test]
        fn a_speaker_playing_another_track_is_left_alone_until_it_fetches_again() {
            let mut session = LatencySession::new(false, 0);
            let tap = started_tap("stream", HUNG_IP, true);
            session.attach(&tap);
            assert!(session.wants_polls());

            let elsewhere = || PositionInfo {
                track_uri: "x-sonos-spotify:track".to_string(),
                rel_time_ms: 5000,
            };
            // Attaching syncs the session to the connection's epoch, so the
            // answers must belong to it to count.
            let epoch_id = tap.epoch().expect("started").id;
            let answer = |poll_id| PollResult {
                epoch_id,
                ..poll(poll_id, Ok(elsewhere()))
            };
            session.in_flight = Some(1);
            apply_poll_result(&mut session, answer(1), &NoEvents, None);
            assert!(
                session.wants_polls(),
                "one odd answer does not end monitoring"
            );
            session.in_flight = Some(2);
            apply_poll_result(&mut session, answer(2), &NoEvents, None);
            assert!(!session.wants_polls(), "dormant until the next fetch");

            let refetch = started_tap("stream", HUNG_IP, true);
            session.attach(&refetch);
            assert!(session.wants_polls(), "a new fetch re-arms the session");
        }

        #[test]
        fn a_poll_while_the_speaker_is_known_paused_is_not_measured() {
            let mut session = LatencySession::new(true, 0);
            session.in_flight = Some(1);
            let mut paused = poll(1, Ok(ours(4000)));
            paused.transport = Some(Ok(TransportState::Paused));
            apply_poll_result(&mut session, paused, &NoEvents, None);
            assert_eq!(session.sample_count, 0, "a paused poll is not a sample");
            assert!(
                session.last_valid_position.is_some(),
                "but it is a valid answer, so the session does not go stale"
            );

            session.in_flight = Some(2);
            apply_poll_result(&mut session, poll(2, Ok(ours(4000))), &NoEvents, None);
            assert_eq!(session.sample_count, 0, "the polled state still holds");

            let mut playing = poll(3, Ok(ours(4000)));
            playing.transport = Some(Ok(TransportState::Playing));
            session.in_flight = Some(3);
            apply_poll_result(&mut session, playing, &NoEvents, None);
            assert_eq!(session.sample_count, 1);
        }

        /// Audio drift correction inserted is played by the speaker but was
        /// never captured: without counting it, video sync would read the
        /// latency that much too low, drifting by about 70 ms an hour at the
        /// field's 20 ppm.
        #[test]
        fn video_sync_counts_the_audio_drift_correction_inserted() {
            let measure = |net_inserted_ms: f64| {
                let mut session = LatencySession::new(true, 0);
                session.in_flight = Some(1);
                let mut answered = poll(1, Ok(ours(4000)));
                answered.net_inserted_ms = net_inserted_ms;
                apply_poll_result(&mut session, answered, &NoEvents, None);
                assert_eq!(session.sample_count, 1);
                session.last_raw_ms
            };
            assert_eq!(measure(54.0) - measure(0.0), 54);
            assert_eq!(measure(-20.0) - measure(0.0), -20);
            assert_eq!(elapsed_with_inserted(10, -50.0), 0);
        }

        #[test]
        fn a_pcm_session_estimates_the_reserve_and_publishes_it() {
            use crate::services::speaker_monitor::test_support::PollGen;

            let tap = started_tap("stream", HUNG_IP, true);
            let mut session = LatencySession::new(false, 0);
            session.attach(&tap);
            let epoch_id = tap.epoch().expect("started").id;
            let origin = tap.connected_at;
            let at = |ms: f64| origin + Duration::from_secs_f64(ms / 1000.0);

            // Four minutes of polls of a speaker holding 600 ms, answered as
            // the real poll task would report them.
            let mut gen = PollGen::new(61);
            let mut poll_id = 0;
            gen.run_until(240_000.0, |p| {
                poll_id += 1;
                session.in_flight = Some(poll_id);
                let result = PollResult {
                    key: ("stream".to_string(), HUNG_IP.parse().unwrap()),
                    poll_id,
                    epoch_id,
                    stream_elapsed_ms: p.ts as u64,
                    rtt_ms: (p.tr - p.ts) as u32,
                    sent_at: at(p.ts),
                    answered_at: at(p.tr),
                    delivered_ms_at_send: Some(p.d_ts_ms as u64),
                    delivered_ms_at_answer: Some(p.d_tr_ms as u64),
                    net_inserted_ms: 0.0,
                    outcome: Ok(ours(p.rel_ms)),
                    transport: None,
                };
                apply_poll_result(&mut session, result, &NoEvents, None);
            });
            assert!(
                session.sample_count > 90,
                "video sync's latency is still measured alongside the reserve"
            );
            // Every measured poll's phase is kept for the report's phase gap.
            assert_eq!(
                session.phases_since_report.len(),
                session.polls_since_report as usize
            );

            let events = NetworkEvents::default();
            session.report(
                "stream",
                HUNG_IP.parse().unwrap(),
                &tap,
                at(240_000.0),
                &events,
            );
            assert!(
                session.phases_since_report.is_empty(),
                "each report measures its own window's phases"
            );
            let est = session.tracker.last_estimate().copied().expect("estimate");
            assert!((est.reserve_ms - 600.0).abs() <= 50.0, "{est:?}");
            let published = tap.speaker_snapshot().expect("published");
            assert_eq!(published.reserve_ms, Some(est.reserve_ms.round() as i32));
            // The report goes to clients with the same figures.
            let sent = events.0.lock();
            match sent.as_slice() {
                [NetworkEvent::SpeakerHealth {
                    reserve_ms,
                    reserve_precision_ms,
                    epoch_id: sent_epoch,
                    ..
                }] => {
                    assert_eq!(*reserve_ms, Some(est.reserve_ms.round() as i32));
                    assert_eq!(
                        *reserve_precision_ms,
                        Some(est.half_width_ms.round() as u32)
                    );
                    assert_eq!(*sent_epoch, epoch_id);
                }
                other => panic!("expected one speaker health event, got {other:?}"),
            }
        }

        /// Answers `count` polls of `session` on `tap`'s connection, a
        /// second apart, from a speaker holding 600 ms.
        fn answer_polls(session: &mut LatencySession, tap: &ConnectionTap, count: u64) {
            let epoch_id = tap.epoch().expect("started").id;
            for poll_id in 1..=count {
                let ts = poll_id * 1000;
                let at = tap.connected_at + Duration::from_millis(ts);
                let delivered = tap.delivered_ms().map(|_| ts);
                session.in_flight = Some(poll_id);
                let result = PollResult {
                    epoch_id,
                    stream_elapsed_ms: ts,
                    sent_at: at,
                    answered_at: at + Duration::from_millis(10),
                    delivered_ms_at_send: delivered,
                    delivered_ms_at_answer: delivered.map(|d| d + 10),
                    ..poll(poll_id, Ok(ours(ts.saturating_sub(600) / 1000 * 1000)))
                };
                apply_poll_result(session, result, &NoEvents, None);
            }
        }

        #[test]
        fn the_wall_clock_cushion_is_logged_only_for_compressed_codecs() {
            let pcm = started_tap("stream", HUNG_IP, true);
            let mut session = LatencySession::new(false, 0);
            session.attach(&pcm);
            answer_polls(&mut session, &pcm, 10);
            assert!(session.sample_count >= 10);
            assert!(
                session.last_diag_log.is_none(),
                "a PCM connection's reserve is measured; the cushion line would mislead"
            );

            let aac = started_tap_with_codec("stream", HUNG_IP, true, AudioCodec::Aac);
            let mut session = LatencySession::new(false, 0);
            session.attach(&aac);
            answer_polls(&mut session, &aac, 10);
            assert!(
                session.last_diag_log.is_some(),
                "a compressed connection keeps the cushion line and its trend"
            );
        }

        #[test]
        fn a_forced_rate_counts_until_the_guard_pins_it() {
            use crate::stream::rate_adapter::RateControl;
            for mode in [DriftMode::Off, DriftMode::Observe, DriftMode::On] {
                let control = Arc::new(RateControl::forced(150.0));
                let tap = started_tap_with_drift(
                    "stream",
                    HUNG_IP,
                    true,
                    AudioCodec::Pcm,
                    mode,
                    Some(control.clone()),
                );
                let mut session = LatencySession::new(false, 0);
                session.attach(&tap);
                assert_eq!(session.tracker.command_ppm(), 150.0, "{mode}");
                // Once the net-insertion guard holds the adapter at 0 ppm,
                // the forced rate no longer reaches the audio.
                control.pin();
                assert_eq!(session.command_in_force(&tap), 0.0, "{mode}");
            }
        }

        #[test]
        fn the_reserve_is_reported_every_30s() {
            let tap = started_tap("stream", HUNG_IP, true);
            let mut session = LatencySession::new(false, 0);
            session.attach(&tap);
            let attached = session.last_report.expect("attaching starts the clock");
            assert!(!session.report_due(attached + Duration::from_secs(29)));
            let due = attached + SPEAKER_REPORT_INTERVAL;
            assert!(session.report_due(due));
            session.report("stream", HUNG_IP.parse().unwrap(), &tap, due, &NoEvents);
            assert!(!session.report_due(due + Duration::from_secs(29)));
            assert!(session.report_due(due + SPEAKER_REPORT_INTERVAL));
        }

        #[test]
        fn a_connection_is_summarised_once_when_it_ends_or_is_replaced() {
            let ip: IpAddr = HUNG_IP.parse().unwrap();
            let mut session = LatencySession::new(false, 0);
            let first = started_tap("stream", HUNG_IP, true);
            session.attach(&first);
            // Replaced before a tick noticed it closing: attaching the next
            // connection summarises the first.
            let second = started_tap("stream", HUNG_IP, true);
            session.attach(&second);
            assert!(
                session.reconnect_gap.is_some(),
                "the replaced connection was summarised, which starts the gap"
            );
            assert!(session.summary_owed, "and the new one is owed its own");
            // The tick that finds it closed, then StopSpeaker or StopStream:
            // only the first logs.
            assert!(session.end_connection("stream", ip, Instant::now()));
            assert!(!session.end_connection("stream", ip, Instant::now()));
        }

        #[test]
        fn no_summary_is_owed_while_the_speaker_is_not_polled() {
            let ip: IpAddr = HUNG_IP.parse().unwrap();
            // Monitoring off and no video sync: never polled, never summarised.
            let mut session = LatencySession::new(false, 0);
            session.attach(&started_tap("stream", HUNG_IP, false));
            assert!(!session.end_connection("stream", ip, Instant::now()));
            // Video sync polls whatever the setting, so it is summarised.
            let mut session = LatencySession::new(true, 0);
            session.attach(&started_tap("stream", HUNG_IP, false));
            assert!(session.end_connection("stream", ip, Instant::now()));
        }

        /// Body bytes a Playbar reads behind the default WAV header before
        /// it takes the item to be over: 44 + 4294967295, 6h12m50s at 48 kHz
        /// stereo.
        const FIELD_DECLARED_END: u64 = 44 + u32::MAX as u64;

        /// A speaker that stops reading at its declared end, reported on: it
        /// holds about 250 ms, is polled for four minutes, and its
        /// acknowledgements lag a steady 20 ms until, half a second before
        /// the report, a single 525 ms lag. Read as a stall that is a 505 ms
        /// one leaving -5 ms, so `head_start_ran_out`.
        ///
        /// A synthetic shape, not the 6h12m field end (see
        /// `the_field_end_reading_on_past_the_declared_end_gets_no_notice`):
        /// it is what a speaker might do at a segment end. `tap` is the
        /// connection, its body `past_end` bytes beyond the declared end
        /// (negative: short of it). Returns the notice the report left
        /// standing and the session.
        fn report_a_stall_at_the_end(
            tap: &Arc<ConnectionTap>,
            past_end: i64,
        ) -> (
            Option<crate::services::speaker_monitor::SpeakerNoticeKind>,
            LatencySession,
        ) {
            let mut lags = vec![20.0; 59];
            lags.push(525.0);
            report_an_end(tap, past_end, &lags)
        }

        /// A speaker holding about 250 ms, polled for four minutes and
        /// reported on every 30 s, whose last window's ticks and pipeline
        /// snapshots saw acknowledgements lag by `lags_ms`. `tap` is the
        /// connection, its body `past_end` bytes beyond the declared end
        /// (negative: short of it) at the last report. Returns the notice
        /// that report left standing and the session.
        fn report_an_end(
            tap: &Arc<ConnectionTap>,
            past_end: i64,
            lags_ms: &[f64],
        ) -> (
            Option<crate::services::speaker_monitor::SpeakerNoticeKind>,
            LatencySession,
        ) {
            use crate::services::speaker_monitor::test_support::PollGen;

            let mut session = LatencySession::new(false, 0);
            session.attach(tap);
            let epoch_id = tap.epoch().expect("started").id;
            let origin = tap.connected_at;
            let at = |ms: f64| origin + Duration::from_secs_f64(ms / 1000.0);
            let mut gen = PollGen::new(61);
            gen.start_ms = 250.0;
            let mut poll_id = 0;
            let ip: IpAddr = HUNG_IP.parse().unwrap();
            for window_end in (30_000..=240_000).step_by(30_000) {
                let window_end = f64::from(window_end);
                gen.run_until(window_end, |p| {
                    poll_id += 1;
                    session.in_flight = Some(poll_id);
                    let result = PollResult {
                        key: ("stream".to_string(), HUNG_IP.parse().unwrap()),
                        poll_id,
                        epoch_id,
                        stream_elapsed_ms: p.ts as u64,
                        rtt_ms: (p.tr - p.ts) as u32,
                        sent_at: at(p.ts),
                        answered_at: at(p.tr),
                        delivered_ms_at_send: Some(p.d_ts_ms as u64),
                        delivered_ms_at_answer: Some(p.d_tr_ms as u64),
                        net_inserted_ms: 0.0,
                        outcome: Ok(ours(p.rel_ms)),
                        transport: None,
                    };
                    apply_poll_result(&mut session, result, &NoEvents, None);
                });
                if window_end < 240_000.0 {
                    session.report("stream", ip, tap, at(window_end), &NoEvents);
                }
            }
            let sent = FIELD_DECLARED_END.saturating_add_signed(past_end);
            tap.record_body_bytes(sent as usize);
            // What the window's ticks and pipeline snapshots saw of the
            // acknowledgements.
            session.tick_lags_ms.extend_from_slice(lags_ms);
            // The report's own tick.
            session.sample_ack_lag(tap);
            session.report("stream", ip, tap, at(240_000.0), &NoEvents);
            (session.notices.active().map(|n| n.kind), session)
        }

        /// The 6h12m field end as the log has it. The Playbar was read at
        /// 192 kB/s with acknowledgements a few kB behind throughout: the
        /// last report (nothing wrong in its lags here) came with the body
        /// about 8.2 s short of the 44 + 4294967295 bytes, the body passed
        /// them and went on being read and acknowledged for 1,793,025 bytes
        /// (9.3 s), and then the speaker hung up with the last delivery
        /// 585 ms old. None of that is a notice, and the end is logged as the
        /// item's.
        ///
        /// The field's `head_start_ran_out` ("Wi-Fi held back 505 ms") came
        /// from that last report, well short of the end, and has another
        /// cause: one 88 ms ack lag on a reserve drift had drained to 83 ms,
        /// on a link judged poor. The declared end does not cover it.
        #[test]
        fn the_field_end_reading_on_past_the_declared_end_gets_no_notice() {
            use crate::stream::cadence::end_suffix;
            use crate::stream::EndedBy;

            const RATE: i64 = 192_000;
            let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
            // Acknowledgements 1.5 to 3 kB (8 to 16 ms) behind, as sampled.
            let lags: Vec<f64> = (0..60).map(|i| 8.0 + f64::from(i % 3) * 4.0).collect();
            let short = -(RATE * 82 / 10);
            let (notice, mut session) = report_an_end(&tap, short, &lags);
            assert_eq!(notice, None);
            assert!(!tap.near_declared_end(), "8.2 s short is measured as usual");
            assert!(session.tracker.stall_ms().is_some());

            // Half-second ticks carry the body on past the end, still read.
            let origin = tap.connected_at;
            let mut sent = FIELD_DECLARED_END.saturating_add_signed(short);
            let close = FIELD_DECLARED_END + 1_793_025;
            while sent < close {
                let step = (RATE as u64 / 2).min(close - sent);
                tap.record_body_bytes(step as usize);
                sent += step;
                session.sample_ack_lag(&tap);
            }
            assert!(tap.near_declared_end() && tap.reached_declared_end());
            assert!(session.declared_end_in_window && session.declared_end_reached);
            // A report landing in those 9 s decides nothing either.
            let ip: IpAddr = HUNG_IP.parse().unwrap();
            session.tick_lags_ms.extend_from_slice(&lags);
            session.report(
                "stream",
                ip,
                &tap,
                origin + Duration::from_secs(270),
                &NoEvents,
            );
            assert_eq!(session.notices.active().map(|n| n.kind), None);
            assert_eq!(session.tracker.stall_ms(), None);

            // The speaker hangs up: the end line and the summary say so.
            assert_eq!(
                end_suffix(EndedBy::Client, tap.reached_declared_end(), 585),
                " at its declared end"
            );
            assert!(session.declared_end_reached, "for the summary");
            // Owed as it is for any speaker being polled.
            session.summary_owed = true;
            assert!(session.end_connection("stream", ip, Instant::now()));
            assert!(!session.declared_end_reached, "taken by the summary");
        }

        #[test]
        fn a_speaker_that_stops_reading_at_its_declared_end_gets_no_notice() {
            // Half a second of audio past the end.
            let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
            let (notice, session) = report_a_stall_at_the_end(&tap, 96_000);
            assert_eq!(notice, None, "the end of the item is not Wi-Fi trouble");
            assert_eq!(session.tracker.stall_ms(), None, "and no stall");
            assert!(session.tracker.last_estimate().is_some_and(|e| e.locked()));
            assert!(!session.declared_end_in_window, "consumed by the report");
            assert!(session.declared_end_reached, "for the summary");

            // Just short of the end the speaker still has audio to read, but
            // the window is already the end's.
            let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
            let (notice, session) = report_a_stall_at_the_end(&tap, -96_000);
            assert_eq!(notice, None);
            assert!(!session.declared_end_reached);
        }

        #[test]
        fn the_same_stall_short_of_the_declared_end_is_still_a_notice() {
            use crate::services::speaker_monitor::SpeakerNoticeKind;

            // A connection with no declared end, as before.
            let tap = started_tap("stream", HUNG_IP, true);
            let (notice, _) = report_a_stall_at_the_end(&tap, 96_000);
            assert_eq!(notice, Some(SpeakerNoticeKind::HeadStartRanOut));
            // Well before the end: a real stall. The field's notice sat
            // about as far short of its end, so the declared end is no guard
            // against it.
            let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
            let (notice, session) = report_a_stall_at_the_end(&tap, -10 * 192_000);
            assert_eq!(notice, Some(SpeakerNoticeKind::HeadStartRanOut));
            assert_eq!(session.tracker.stall_ms(), Some(505.0));
            // A speaker still reading a minute past the end is not honouring it.
            let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
            let (notice, _) = report_a_stall_at_the_end(&tap, 61 * 192_000);
            assert_eq!(notice, Some(SpeakerNoticeKind::HeadStartRanOut));
        }

        #[test]
        fn a_window_that_came_near_the_declared_end_stays_the_ends() {
            let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
            let mut session = LatencySession::new(false, 0);
            session.attach(&tap);
            tap.record_body_bytes(FIELD_DECLARED_END as usize);
            session.sample_ack_lag(&tap);
            assert!(session.declared_end_in_window);
            assert!(session.declared_end_reached);
            // A new connection starts clean.
            session.attach(&started_tap("stream", HUNG_IP, true));
            assert!(!session.declared_end_in_window);
            assert!(!session.declared_end_reached);
        }

        #[test]
        fn a_poll_with_no_trustworthy_transport_state_is_still_measured() {
            let mut session = LatencySession::new(true, 0);
            session.in_flight = Some(1);
            apply_poll_result(&mut session, poll(1, Ok(ours(4000))), &NoEvents, None);
            assert_eq!(session.sample_count, 1);
        }
    }

    #[test]
    fn process_poll_ceiling_stretches_intervals() {
        let mean_dither = MONITOR_POLL_DITHER_MS / 2;
        for sessions in 1..=5 {
            assert_eq!(
                monitor_poll_interval_ms(mean_dither, sessions),
                MONITOR_POLL_INTERVAL_MS + mean_dither,
                "up to five speakers poll at the base interval"
            );
        }
        for sessions in 1..=40usize {
            let interval = monitor_poll_interval_ms(mean_dither, sessions);
            let per_minute = sessions as u64 * 60_000 / interval;
            assert!(
                per_minute <= SPEAKER_MONITOR_MAX_POLLS_PER_MIN,
                "{sessions} speakers poll {per_minute} times a minute"
            );
        }
        assert_eq!(
            monitor_poll_interval_ms(mean_dither, 10),
            2 * (MONITOR_POLL_INTERVAL_MS + mean_dither),
            "ten speakers each poll half as often"
        );
        assert_eq!(MONITOR_POLLS_PER_MIN, 24);
    }

    #[test]
    fn more_than_12_monitor_only_speakers_cannot_hold_a_lock() {
        for sessions in 1..=12 {
            assert!(!monitor_capacity_exceeded(sessions), "{sessions} speakers");
        }
        assert!(monitor_capacity_exceeded(13));
        assert_eq!(monitor_polls_per_window(5), 72.0);
    }

    #[test]
    fn the_speaker_monitor_switch_accepts_on_and_off() {
        for on in ["on", "ON", " true ", "1", "yes"] {
            assert_eq!(parse_speaker_monitor_switch(on), Some(true), "{on:?}");
        }
        for off in ["off", "Off", "false", "0", "no"] {
            assert_eq!(parse_speaker_monitor_switch(off), Some(false), "{off:?}");
        }
        assert_eq!(parse_speaker_monitor_switch("sometimes"), None);
    }

    #[test]
    fn the_environment_overrides_the_setting_and_diagnostics_force_it_on() {
        assert!(resolve_speaker_monitor(true, None, false));
        assert!(!resolve_speaker_monitor(false, None, false));
        assert!(!resolve_speaker_monitor(true, Some(false), false));
        assert!(resolve_speaker_monitor(false, Some(true), false));
        assert!(
            resolve_speaker_monitor(false, Some(false), true),
            "the diagnostics switch still opts in"
        );
    }

    #[test]
    fn the_draining_warning_fires_once_until_the_drain_recovers() {
        use MonitorState::{Draining, Locking, Ok};
        let mut warned = false;
        let mut step =
            |state, tte, clock_drains| draining_warning_due(&mut warned, state, tte, clock_drains);
        assert!(step(Draining, Some(900.0), true), "fires on entering");
        assert!(!step(Draining, Some(880.0), true), "once");
        // The estimate unlocks, or an offset step clears it, while the clock
        // still drains: no new warning when it comes back.
        assert!(!step(Locking, None, true));
        assert!(!step(Draining, Some(860.0), true));
        // Between the warning and clearing thresholds nothing changes.
        assert!(!step(Ok, Some(40.0 * 60.0), true));
        assert!(!step(Draining, Some(850.0), true));
        // Recovering past the clearing threshold re-arms it.
        assert!(!step(Ok, Some(DRAINING_CLEAR_SECS), true));
        assert!(step(Draining, Some(800.0), true));
        // So does the clock ceasing to drain.
        assert!(!step(Ok, None, false));
        assert!(step(Draining, Some(800.0), true));
    }

    #[test]
    fn a_low_speaker_that_is_also_draining_still_gets_the_draining_warning() {
        use MonitorState::{Draining, Low};
        let mut warned = false;
        assert!(
            !draining_warning_due(&mut warned, Low, Some(35.0 * 60.0), true),
            "low, but not projected to reach the floor soon"
        );
        assert!(draining_warning_due(&mut warned, Low, Some(600.0), true));
        assert!(!draining_warning_due(
            &mut warned,
            Draining,
            Some(580.0),
            true
        ));
    }

    #[test]
    fn the_acknowledged_reserve_is_logged_only_when_measured() {
        use crate::services::speaker_monitor::AckedReserve;
        let acked = |measured| {
            Some(AckedReserve {
                min_ms: 431.4,
                p10_ms: 470.0,
                median_ms: 480.0,
                measured,
                stall_ms: None,
            })
        };
        assert_eq!(
            format_acked(acked(true), Some(540.2)),
            " (acked min30s=431 p10=470) dropped=70"
        );
        assert_eq!(format_acked(acked(false), Some(540.0)), " dropped=70");
        assert_eq!(
            format_acked(acked(true), None),
            " (acked min30s=431 p10=470)"
        );
        assert_eq!(format_acked(None, None), "");
    }

    #[test]
    fn topology_changes_go_on_the_next_report_line_and_into_the_summary_count() {
        let rebooted = |to| MemberChange::DeviceRebooted {
            uuid: "RINCON_SUB".to_string(),
            from: 31,
            to,
        };
        let mut session = LatencySession::new(false, 0);
        assert_eq!(format_topology(&session.topology_since_report), "");

        session.note_topology(rebooted(32));
        assert_eq!(
            format_topology(&session.topology_since_report),
            " topology[RINCON_SUB rebooted (BootSeq 31->32)]"
        );

        // A flapping device fills the line up to its cap; the summary still
        // counts every change.
        for to in 33..45 {
            session.note_topology(rebooted(to));
        }
        assert_eq!(session.topology_since_report.len(), MAX_TOPOLOGY_NOTES);
        assert_eq!(session.connection_topology_changes, 13);
    }

    #[test]
    fn a_trend_needs_three_samples_spread_in_time() {
        let mut trend = CushionTrend::default();
        assert!(trend.fit().is_none());
        trend.add(0.0, 500.0);
        trend.add(0.0, 600.0);
        trend.add(0.0, 550.0);
        assert!(trend.fit().is_none(), "no spread in time");
        trend.add(60.0, 400.0);
        assert!(trend.fit().is_some());
    }

    /// What drift correction learns is the speaker's, kept under its UUID:
    /// its next cast starts from it even from a new address, and another
    /// speaker given the old address starts afresh.
    #[test]
    fn control_state_keyed_by_uuid_not_ip() {
        use crate::stream::tap::test_support::started_tap;
        let mut sessions = HashMap::new();
        let mut kept = HashMap::new();
        let now = Instant::now();

        let tap = started_tap("cast-1", "192.168.1.60", true);
        register_connection(&mut sessions, &mut kept, &tap, Some("RINCON_A".into()));
        let key = ("cast-1".to_string(), tap.speaker_ip);
        let learned = SpeakerControlState {
            integral_ppm: 18.5,
            seeded: true,
            ..SpeakerControlState::default()
        };
        sessions.get_mut(&key).unwrap().drift = DriftController::new(learned.clone());
        let session = sessions.remove(&key).unwrap();
        keep_control_state(&mut kept, &session, now);

        // Another speaker takes the address: it learns its own clock.
        let other = started_tap("cast-2", "192.168.1.60", true);
        register_connection(&mut sessions, &mut kept, &other, Some("RINCON_B".into()));
        let session = &sessions[&("cast-2".to_string(), other.speaker_ip)];
        assert_eq!(session.drift.integral_ppm(), 0.0);

        // The first speaker comes back from a new address.
        let moved = started_tap("cast-3", "192.168.1.61", true);
        register_connection(&mut sessions, &mut kept, &moved, Some("RINCON_A".into()));
        let session = &sessions[&("cast-3".to_string(), moved.speaker_ip)];
        assert_eq!(session.drift.state(), &learned);
        assert!(kept.is_empty(), "handed over, not copied");

        // Known by address until the topology names it, then it keeps what
        // it learned under the address.
        let unnamed = started_tap("cast-4", "192.168.1.62", true);
        register_connection(&mut sessions, &mut kept, &unnamed, None);
        let key = ("cast-4".to_string(), unnamed.speaker_ip);
        sessions.get_mut(&key).unwrap().drift = DriftController::new(learned.clone());
        let again = started_tap("cast-4", "192.168.1.62", true);
        register_connection(&mut sessions, &mut kept, &again, Some("RINCON_C".into()));
        assert_eq!(sessions[&key].drift.state(), &learned);
        assert_eq!(sessions[&key].control_key.as_deref(), Some("RINCON_C"));
    }

    #[test]
    fn the_report_line_shows_a_forced_rate_in_every_mode() {
        let mut drift = DriftController::default();
        drift.start_connection(DriftMode::Off, true);
        assert_eq!(format_drift(&drift, Some(0.0), None, false), "drift=off");
        assert_eq!(
            format_drift(&drift, Some(12.4), Some(150.0), false),
            "drift=off forced=+150ppm ins=+12ms"
        );
        assert_eq!(
            format_drift(&drift, Some(2000.0), Some(150.0), true),
            "drift=off forced=+150ppm(pinned) ins=+2000ms"
        );
        drift.start_connection(DriftMode::Observe, true);
        let line = format_drift(&drift, Some(-3.0), Some(-42.5), false);
        assert!(line.starts_with("drift=observe would_cmd="), "{line}");
        assert!(line.ends_with(" forced=-42.5ppm ins=-3ms"), "{line}");
        assert_eq!(line.matches("ins=").count(), 1, "{line}");
    }

    #[test]
    fn the_report_line_shows_the_controller_holding_or_steering_by_a_carried_estimate() {
        let mut drift = DriftController::new(SpeakerControlState {
            integral_ppm: 19.0,
            seeded: true,
            ..SpeakerControlState::default()
        });
        drift.start_connection(DriftMode::On, true);
        drift.update(&ControlInput {
            settling: true,
            ..ControlInput::default()
        });
        assert_eq!(
            format_drift(&drift, Some(431.0), None, false),
            "drift=on cmd=+19.0ppm(settle) I=+19.0 ins=+431ms"
        );
        // Steering by the estimate carried across a switch.
        drift.update(&ControlInput {
            now_s: 30.0,
            estimate: Some(crate::services::speaker_monitor::ReserveEstimate {
                at: 30_000.0,
                reserve_ms: 500.0,
                half_width_ms: 60.0,
                inconsistent: false,
                jitter_ms: 25.0,
                polls: 12,
                lock_reason: crate::services::speaker_monitor::LockReason::Held,
            }),
            target_ms: Some(500.0),
            head_start_ms: Some(500),
            carry: crate::services::speaker_monitor::EstimateCarry::Teaches,
            ..ControlInput::default()
        });
        assert_eq!(
            format_drift(&drift, Some(431.0), None, false),
            "drift=on cmd=+19.0ppm(carried) I=+19.0 ins=+431ms"
        );
    }
}
