use std::net::IpAddr;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use crate::services::speaker_monitor::monitor::SPEAKER_MONITOR_MAX_POLLS_PER_MIN;
use crate::services::speaker_monitor::reserve::{HOLD_MIN_POLLS, RESERVE_WINDOW_MS};
use crate::services::speaker_monitor::session::report::{format_clock, format_duration};
use crate::services::speaker_monitor::session::video_sync::CushionTrend;
use crate::services::speaker_monitor::{
    DriftController, DriftMode, MemberChange, MonitorState, NoticeState, ReserveTracker,
    SegmentBreak, TransportGate, TransportSource,
};
use crate::sonos::types::{PositionInfo, TransportState};
use crate::stream::{ConnectionTap, PlaybackEpoch};

mod drift;
mod health;
mod report;
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

/// Most household changes listed on one report line. A flapping satellite
/// between two reports is still counted in the connection's summary.
const MAX_TOPOLOGY_NOTES: usize = 8;

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
