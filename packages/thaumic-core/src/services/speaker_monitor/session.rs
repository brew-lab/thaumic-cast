use std::net::IpAddr;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use crate::events::{EventEmitter, LinkQuality, NetworkEvent};
use crate::services::speaker_monitor::monitor::{ms_between, SPEAKER_MONITOR_MAX_POLLS_PER_MIN};
use crate::services::speaker_monitor::reserve::{HOLD_MIN_POLLS, RESERVE_WINDOW_MS};
use crate::services::speaker_monitor::session::video_sync::CushionTrend;
use crate::services::speaker_monitor::{
    drift_active, ControlInput, DriftController, DriftMode, MemberChange, MonitorState,
    NoticeInput, NoticeState, ReserveTracker, SegmentBreak, SwitchOutcome, SwitchUnmeasured,
    TransportGate, TransportSource, WindowStats,
};
use crate::sonos::types::{PositionInfo, TransportState};
use crate::stream::{ConnectionTap, PlaybackEpoch, SpeakerFigures};
use crate::utils::now_millis;

mod video_sync;

#[cfg(test)]
mod tests;

/// Polling interval for position queries.
/// 500ms is sufficient since Sonos RelTime only has 1-second precision.
pub(super) const POLL_INTERVAL_MS: u64 = 500;

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

/// How often each watched speaker's reserve and clock are estimated and
/// written to the log.
pub(super) const SPEAKER_REPORT_INTERVAL: Duration = Duration::from_secs(30);

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

/// Random delay added to every poll, in milliseconds.
///
/// The speaker reports its position in whole seconds, so each sample of the
/// cushion carries an error that depends on where in the speaker's second
/// the poll lands. Polling on a fixed cadence keeps that phase almost
/// constant, and under a slow drift it creeps linearly, which a trend fit
/// cannot tell from the drift itself. Spreading each poll by up to a full
/// second makes the phase uniform, so the error averages out instead.
const POLL_DITHER_MS: u64 = 1000;

/// Consecutive failed polls (timeouts or errors) after which a speaker is
/// polled at [`BACKOFF_POLL_INTERVAL_MS`] until it answers again.
pub(super) const BACKOFF_AFTER_FAILURES: u32 = 3;

/// Polling interval for a speaker that has stopped answering. Its polls cost
/// nothing to the other speakers (each runs in its own task), but there is
/// no point asking twice a second for an answer that is not coming.
pub(super) const BACKOFF_POLL_INTERVAL_MS: u64 = 5000;

/// Maximum time since last valid position before considering epoch stale.
/// If we haven't received valid position info in this window, something is wrong.
/// Should be >= 10 * POLL_INTERVAL_MS to avoid false positives during network blips.
pub(super) const STALE_EPOCH_TIMEOUT_SECS: u64 = 30;

/// Key for identifying a monitoring session (stream_id, canonical speaker IP).
pub(super) type SessionKey = (String, IpAddr);

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
pub(super) fn dither_seed(key: &SessionKey) -> u64 {
    use std::hash::BuildHasher;
    std::collections::hash_map::RandomState::new().hash_one(key)
}

/// What a spawned poll task hands back to the monitor loop, which alone owns
/// session state and applies it.
pub(super) struct PollResult {
    pub(super) key: SessionKey,
    /// Identifies the poll, so a late answer is applied only to the session
    /// that is still waiting for it.
    pub(super) poll_id: u64,
    /// Epoch the poll was measured against.
    pub(super) epoch_id: u64,
    /// Time since the epoch's audio T0, read just before the request.
    pub(super) stream_elapsed_ms: u64,
    /// Request round-trip time.
    pub(super) rtt_ms: u32,
    /// When the request was sent and when its answer (or timeout) came back.
    /// The speaker read its position somewhere in between.
    pub(super) sent_at: Instant,
    pub(super) answered_at: Instant,
    /// Milliseconds of audio handed to the connection when the request was
    /// sent and when it was answered; `None` for a compressed codec.
    pub(super) delivered_ms_at_send: Option<u64>,
    pub(super) delivered_ms_at_answer: Option<u64>,
    /// Audio drift correction had inserted (positive) or removed when the
    /// answer arrived, in ms; 0 when it corrects nothing.
    pub(super) net_inserted_ms: f64,
    /// The speaker's answer, or why there was none.
    pub(super) outcome: Result<PositionInfo, String>,
    /// The speaker's transport state, when the poll also asked for it.
    pub(super) transport: Option<Result<TransportState, String>>,
}

/// Tracks latency measurement state for a single speaker.
pub(super) struct SpeakerSession {
    /// Whether measurements are sent to clients (video sync). Every session
    /// is logged; only these emit events.
    pub(super) emit_events: bool,
    /// The speaker's current connection, held weakly (its response body owns
    /// it). `None` for a video-sync request whose speaker has not fetched yet.
    pub(super) tap: Option<Weak<ConnectionTap>>,
    /// Whether speaker monitoring was on for the current connection. A
    /// session is polled when this or `emit_events` is set.
    monitor: bool,
    /// When the current connection was found closed, while no newer one has
    /// taken its place.
    pub(super) tap_lost_at: Option<Instant>,
    /// The speaker reported a track that is not this stream, so it is not
    /// polled until it fetches the stream again.
    pub(super) dormant: bool,
    /// Polls in a row that reported another track.
    pub(super) uri_mismatches: u32,
    /// Whether the speaker is playing, from evidence that can be trusted.
    pub(super) gate: TransportGate,
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
    pub(super) in_flight: Option<u64>,
    /// Polls in a row that timed out or failed; resets on any answer.
    pub(super) consecutive_failures: u32,
    /// Reserve and clock tracking across the speaker's connections.
    pub(super) tracker: ReserveTracker,
    /// When the current connection was accepted: the origin of the times
    /// fed to the tracker.
    pub(super) connected_at: Option<Instant>,
    /// Whether the current connection is PCM, whose reserve is measured.
    /// A compressed one keeps the wall-clock cushion line.
    pub(super) pcm: bool,
    /// When the reserve and clock were last reported.
    last_report: Option<Instant>,
    /// Polls measured since the last report.
    pub(super) polls_since_report: u32,
    /// Where each of those polls fell in the second, in ms from the
    /// connection's start modulo 1000: the midpoint of its round trip.
    /// Against the speaker's own second this is shifted by a constant, so
    /// the gaps between them are the gaps the reserve bounds see.
    pub(super) phases_since_report: Vec<f64>,
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
    pub(super) last_transport_source: TransportSource,
    /// Whether the draining warning has fired. It is re-armed only once the
    /// projection recovers past [`DRAINING_CLEAR_SECS`] or the clock stops
    /// draining, not when the projection merely lapses (the estimate
    /// unlocking, an offset step, a new connection), so it does not repeat
    /// while the speaker drains on.
    draining_warned: bool,
    /// Whether the current connection is owed an end-of-connection summary.
    pub(super) summary_owed: bool,
    /// When the previous connection was found closed, and the gap from
    /// then to the current connection.
    previous_connection_ended: Option<Instant>,
    reconnect_gap: Option<Duration>,
    /// The state last sent to clients in a speaker health event, so a
    /// change between reports is sent at once.
    pub(super) health_reported: Option<MonitorState>,
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
    pub(super) drift: DriftController,
    /// Origin of the drift controller's clock, which runs on across the
    /// session's connections.
    drift_origin: Instant,
    /// What the drift controller's state is kept under between sessions:
    /// the speaker's UUID, or its address until the topology knows it.
    pub(super) control_key: Option<String>,
}

impl SpeakerSession {
    /// Creates a new monitoring session with no connection yet, drawing its
    /// poll dither from `dither_seed` (see [`dither_seed`]).
    pub(super) fn new(emit_events: bool, dither_seed: u64) -> Self {
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
    pub(super) fn attach(&mut self, tap: &Arc<ConnectionTap>) {
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
    pub(super) fn note_topology(&mut self, change: MemberChange) {
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
    pub(super) fn end_connection(
        &mut self,
        stream_id: &str,
        speaker_ip: IpAddr,
        now: Instant,
    ) -> bool {
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
    pub(super) fn sample_ack_lag(&mut self, tap: &ConnectionTap) {
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
    pub(crate) fn report_due(&self, now: Instant) -> bool {
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
    pub(crate) fn report(
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
    pub(super) fn step_drift(
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
    pub(super) fn command_in_force(&self, tap: &ConnectionTap) -> f64 {
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
    pub(crate) fn refresh_rate_command(&self, tap: &ConnectionTap) {
        if let Some(control) = tap.rate_control() {
            control.set_ppm(self.drift.applied_ppm());
        }
    }

    /// Steps the speaker's notice with what this report found, and logs a
    /// new or escalated one.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn decide_notice(
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
    pub(crate) fn health_state(&self) -> MonitorState {
        let stale = self.consecutive_failures >= BACKOFF_AFTER_FAILURES || self.is_stale();
        self.tracker.state(self.dormant, stale)
    }

    /// Whether clients are told about this speaker's health: whenever it is
    /// polled, or would be but for playing something else.
    pub(crate) fn reports_health(&self) -> bool {
        self.monitor || self.emit_events
    }

    /// Sends the speaker's health, with the figures of its latest report, to
    /// clients.
    pub(crate) fn emit_health(
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
    pub(super) fn health_event(
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
    pub(super) fn live_tap(&self) -> Option<Arc<ConnectionTap>> {
        self.tap.as_ref().and_then(Weak::upgrade)
    }

    /// Whether the speaker is to be polled at all while its connection is open.
    pub(super) fn wants_polls(&self) -> bool {
        (self.emit_events || self.monitor) && !self.dormant
    }

    /// Whether this session counts against the monitor-only poll ceiling.
    pub(super) fn polls_for_monitoring_only(&self) -> bool {
        self.monitor
            && !self.emit_events
            && !self.dormant
            && self.tap.as_ref().is_some_and(|t| t.strong_count() > 0)
    }

    /// Syncs with the epoch of the speaker's current connection.
    ///
    /// Resets session if epoch changed, but seeds EMA with previous value
    /// to avoid "jump to 0 then climb back" behavior.
    pub(super) fn sync_epoch(&mut self, epoch: PlaybackEpoch) {
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
    pub(super) fn is_stale(&self) -> bool {
        self.last_valid_position
            .is_some_and(|at| at.elapsed().as_secs() > STALE_EPOCH_TIMEOUT_SECS)
    }

    /// Records that we received valid position info (for stale detection).
    /// Also clears stale_emitted flag so we can emit again if it goes stale later.
    pub(super) fn record_valid_position(&mut self) {
        self.last_valid_position = Some(Instant::now());
        self.stale_emitted = false;
    }

    /// Marks that we've emitted a stale event (to prevent spam).
    pub(super) fn mark_stale_emitted(&mut self) {
        self.stale_emitted = true;
    }

    /// Returns true if we should emit a stale event (not already emitted).
    pub(super) fn should_emit_stale(&self) -> bool {
        !self.stale_emitted
    }

    /// Returns the last epoch ID we measured against.
    pub(super) fn last_epoch_id(&self) -> u64 {
        self.last_epoch_id
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
    pub(super) fn poll_start_delay(&self, now: Instant, horizon: Duration) -> Option<Duration> {
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
    pub(super) fn mark_polled_at(&mut self, sent_at: Instant, monitor_only_sessions: usize) {
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
}

/// The widest gap between the polls' phases in the second, `phases` being
/// each poll's position in the second in ms (`[0, 1000)`), counting the gap
/// that wraps from the last phase round to the first. `None` without polls.
///
/// The reserve bounds narrow only as far as the polls fill the second, so
/// this is what limits how tight an estimate can get: ~72 well-spread polls
/// leave gaps of a few tens of ms, a lattice of four points leaves 250.
pub(super) fn largest_phase_gap_ms(phases: &mut [f64]) -> Option<f64> {
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
pub(super) fn monitor_polls_per_window(monitor_only_sessions: usize) -> f64 {
    let interval = monitor_poll_interval_ms(MONITOR_POLL_DITHER_MS / 2, monitor_only_sessions);
    RESERVE_WINDOW_MS / interval as f64
}

/// Whether `monitor_only_sessions` share the process ceiling so thinly that
/// each gets fewer than [`HOLD_MIN_POLLS`] polls a window, and so cannot hold
/// a reserve lock.
pub(super) fn monitor_capacity_exceeded(monitor_only_sessions: usize) -> bool {
    monitor_polls_per_window(monitor_only_sessions) < HOLD_MIN_POLLS as f64
}

/// A duration for the log: `4.5s`, `12m05s`, `1h23m`.
pub(super) fn format_duration(d: Duration) -> String {
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
        SwitchOutcome::Reclocked { offset_ms, by_ms } => log::info!(
            "[SpeakerMonitor] {} stream={}: continuation switch: offset corrected {:+.0}ms \
             for the speaker's clock, now precise; {:+.0}ms absorbed",
            speaker_ip,
            stream_id,
            by_ms,
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
pub(super) fn format_clock(
    clock: Option<crate::services::speaker_monitor::ClockEstimate>,
) -> String {
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
/// I=+17.6 taught=93m pull=+0.12ppm ins=+54ms` when it corrects the audio,
/// `drift=observe would_cmd=+18.0ppm I=+17.6 taught=93m pull=+0.12ppm` when
/// it only works out what it would do, and `drift=off` otherwise. `taught`
/// is how long the loop has taught the speaker's integral, over every cast,
/// and `pull` how far the clock fit drew it on this report (`pull=—` when it
/// did not). The controller's reason is added when it is not steering
/// (holding, ramping, no target yet, or a distrusted target).
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
    let pull = drift
        .pull_ppm()
        .map_or_else(|| "\u{2014}".to_string(), |ppm| format!("{ppm:+.2}ppm"));
    format!(
        "drift={mode} {label}={:+.1}ppm{hold} I={:+.1} taught={:.0}m pull={pull}{saturated}{inserted}",
        drift.command_ppm(),
        drift.integral_ppm(),
        drift.state().taught_s / 60.0,
    )
}

/// How close to its target a reserve must come back for the latency a PCM
/// restart added to count as repaid, in ms.
const DEBT_REPAID_MS: f64 = 50.0;

/// Logs, once, that the latency a PCM restart added (see
/// [`crate::stream::Rejoin`]) has been paid back: the locked reserve is
/// back within [`DEBT_REPAID_MS`] of the target the connection settled at
/// before the restart.
pub(super) fn note_debt_repaid(
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
