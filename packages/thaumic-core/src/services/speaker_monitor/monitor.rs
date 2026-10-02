//! The speaker monitor's polling loop.
//!
//! [`SpeakerMonitor`] watches every speaker that is fetching a stream. It polls
//! each one's `GetPositionInfo`, compares the answer against the stream's own
//! timing, and hands the result to the pure modules beside it in
//! [`crate::services::speaker_monitor`], which decide what the polls mean. This
//! file owns the I/O: the loop, the polls and their timeouts. What it keeps
//! about each speaker, with that speaker's poll schedule and log lines, is a
//! session, in the `session` module beside it.
//!
//! One of its outputs is the end-to-end latency between the audio source and
//! Sonos playback, an absolute figure that video sync uses. The others are the
//! reserve and clock-rate figures described below.
//!
//! # Latency measurement
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
//! for its connection (see [`crate::Config::speaker_monitor`]), or when a client
//! asked for video sync on it, which works whatever the setting says. A
//! video-sync request that arrives before the speaker's first fetch leaves a
//! pending session that the fetch completes.
//!
//! Monitor-only speakers are polled every two to three seconds, and never
//! more than [`SPEAKER_MONITOR_MAX_POLLS_PER_MIN`] times a minute between
//! them. A speaker reporting another track is left alone until it fetches the
//! stream again, and a poll taken while the speaker is known not to be
//! playing is not measured (see
//! [`TransportGate`](crate::services::speaker_monitor::TransportGate)).
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
//! rate and keep the older wall-clock cushion line instead; their speakers
//! are reported as unmeasured, never as locking, since no reserve estimate
//! will ever come.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::events::{EventEmitter, LatencyEvent};
use crate::protocol_constants::POSITION_POLL_TIMEOUT_MS;
use crate::runtime::TokioSpawner;
use crate::services::speaker_monitor::reserve::HOLD_MIN_POLLS;
use crate::services::speaker_monitor::session::{
    dither_seed, monitor_capacity_exceeded, monitor_polls_per_window, PollResult, SessionKey,
    SpeakerSession, BACKOFF_AFTER_FAILURES, BACKOFF_POLL_INTERVAL_MS, POLL_INTERVAL_MS,
    STALE_EPOCH_TIMEOUT_SECS,
};
use crate::services::speaker_monitor::{
    DriftController, GenaTransport, MemberChange, PollObservation, SpeakerControlState,
    TransportStateView, TransportVerdict,
};
use crate::sonos::traits::SonosPlayback;
use crate::stream::{ConnectionTap, MonitorRegistrar, PlaybackEpoch, StreamRegistry};
use crate::utils::now_millis;

/// Environment variable that forces speaker monitoring on for this process,
/// whatever the configuration says. Kept from before monitoring was on by
/// default, for anyone whose setup already sets it. Read once at start-up
/// (see [`crate::companion_settings`]).
pub const SPEAKER_DIAGNOSTICS_ENV: &str = "THAUMIC_SPEAKER_DIAGNOSTICS";

/// Environment variable that sets speaker monitoring: `on` or `off` (also
/// `true`/`false`, `1`/`0`, `yes`/`no`). Read once at start-up (see
/// [`crate::companion_settings`]).
pub const SPEAKER_MONITOR_ENV: &str = "THAUMIC_SPEAKER_MONITOR";

/// Parses a speaker-monitor switch value, or `None` if it is not one.
pub fn parse_speaker_monitor_switch(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "on" | "true" | "1" | "yes" => Some(true),
        "off" | "false" | "0" | "no" => Some(false),
        _ => None,
    }
}

/// Ceiling on monitor-only polls a minute across the whole process. Past
/// five fetching speakers (a large unsynced cast) every monitor-only interval
/// stretches in proportion, so the total stays here. Video-sync polls are
/// exempt: video sync needs its cadence.
pub const SPEAKER_MONITOR_MAX_POLLS_PER_MIN: u64 = 120;

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

/// Time since a connection's audio epoch, counting audio drift correction
/// inserted (or removed) as if it had been captured: the speaker's playhead
/// runs through it, so the latency is measured against it too.
pub(super) fn elapsed_with_inserted(stream_elapsed_ms: u64, net_inserted_ms: f64) -> u64 {
    (stream_elapsed_ms as f64 + net_inserted_ms)
        .round()
        .max(0.0) as u64
}

/// Milliseconds from `origin` to `at`, zero if `at` is earlier.
pub(super) fn ms_between(origin: Instant, at: Instant) -> f64 {
    at.saturating_duration_since(origin).as_secs_f64() * 1000.0
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
    session: &SpeakerSession,
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
pub struct SpeakerMonitor {
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

impl SpeakerMonitor {
    /// Creates a new SpeakerMonitor.
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
        let mut sessions: HashMap<SessionKey, SpeakerSession> = HashMap::new();
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
                                    sessions.insert(key, SpeakerSession::new(true, seed));
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
    sessions: &mut HashMap<SessionKey, SpeakerSession>,
    kept: &mut HashMap<String, KeptControlState>,
    tap: &Arc<ConnectionTap>,
    uuid: Option<String>,
) {
    let key = (tap.stream_id.clone(), tap.speaker_ip);
    let session = sessions
        .entry(key)
        .or_insert_with_key(|key| SpeakerSession::new(false, dither_seed(key)));
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
pub(super) fn apply_poll_result(
    session: &mut SpeakerSession,
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
}
