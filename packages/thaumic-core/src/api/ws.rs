//! WebSocket handler for real-time client communication.

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{State, WebSocketUpgrade};
use axum::response::IntoResponse;
use bytes::Bytes;
use futures::sink::SinkExt;
use futures::stream::StreamExt;
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::api::AppState;
use crate::events::SpeakerRemovalReason;
use crate::protocol_constants::{
    DEFAULT_JITTER_BUFFER_MS, MAX_FRAME_DURATION_MS, MAX_JITTER_BUFFER_MS, MIN_FRAME_DURATION_MS,
    MIN_JITTER_BUFFER_MS, SILENCE_FRAME_DURATION_MS, SOAP_TIMEOUT_SECS,
    WS_HEARTBEAT_CHECK_INTERVAL_SECS, WS_HEARTBEAT_TIMEOUT_SECS,
};
use crate::services::StreamCoordinator;
use crate::stream::{AudioCodec, AudioFormat, StreamMetadata};

// ─────────────────────────────────────────────────────────────────────────────
// Stream Guard (RAII cleanup)
// ─────────────────────────────────────────────────────────────────────────────

/// RAII guard that ensures stream cleanup on drop.
///
/// This prevents stream leaks if the WebSocket handler panics or exits
/// unexpectedly after a stream has been created.
struct StreamGuard {
    stream_id: String,
    stream_coordinator: Arc<StreamCoordinator>,
    /// Cleared by `disarm()` once the stream has been removed gracefully.
    armed: bool,
}

impl StreamGuard {
    fn new(stream_id: String, stream_coordinator: Arc<StreamCoordinator>) -> Self {
        Self {
            stream_id,
            stream_coordinator,
            armed: true,
        }
    }

    /// Returns a reference to the stream ID.
    fn id(&self) -> &str {
        &self.stream_id
    }

    /// Consumes the guard after the stream was already removed gracefully,
    /// so dropping it does not remove the stream (and emit `Ended`) again.
    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if self.armed {
            self.stream_coordinator.remove_stream(&self.stream_id);
            log::info!("[WS] Stream cleanup: {}", self.stream_id);
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Message Types
// ─────────────────────────────────────────────────────────────────────────────

/// Incoming WebSocket message envelope.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
enum WsIncoming {
    Handshake { payload: HandshakeRequest },
    Heartbeat,
    MetadataUpdate { payload: StreamMetadata },
    SetVolume { payload: WsVolumeRequest },
    SetMute { payload: WsMuteRequest },
    GetVolume { payload: WsSpeakerRequest },
    GetMute { payload: WsSpeakerRequest },
    StartPlayback { payload: StartPlaybackRequest },
    StopPlaybackSpeaker { payload: StopPlaybackSpeakerPayload },
    StartBrowserCapture { payload: StartBrowserCaptureRequest },
    StopBrowserCapture,
}

/// Request payload for starting playback via WebSocket.
/// Supports both single speaker (legacy) and multi-speaker (new).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartPlaybackRequest {
    /// Multiple speaker IPs (multi-group support).
    #[serde(default)]
    speaker_ips: Option<Vec<String>>,
    /// Legacy single speaker IP (backward compatibility).
    #[serde(default)]
    speaker_ip: Option<String>,
    /// Optional initial metadata to display on Sonos.
    /// If not provided, Sonos will show default "Browser Audio".
    #[serde(default)]
    metadata: Option<StreamMetadata>,
    /// Whether to use synchronized group playback (default: false).
    /// When true, uses x-rincon protocol to sync multiple speakers.
    #[serde(default)]
    sync_speakers: bool,
    /// Whether the client has video sync enabled (gates latency monitoring).
    #[serde(default)]
    video_sync_enabled: bool,
}

impl StartPlaybackRequest {
    /// Gets the speaker IPs, preferring the array field over the legacy single field.
    fn get_speaker_ips(&self) -> Vec<String> {
        if let Some(ips) = &self.speaker_ips {
            ips.clone()
        } else if let Some(ip) = &self.speaker_ip {
            vec![ip.clone()]
        } else {
            vec![]
        }
    }
}

/// Request payload for starting browser-wide WASAPI capture.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartBrowserCaptureRequest {
    /// Browser executable name (e.g., "chrome.exe"). Auto-detects if omitted.
    browser_name: Option<String>,
    /// Encoder config from extension (sample rate, channels, bit depth, etc.).
    encoder_config: Option<EncoderConfig>,
}

/// Request payload for volume control via WebSocket.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsVolumeRequest {
    ip: String,
    volume: u8,
    /// When true, sets volume for the entire sync group via GroupRenderingControl
    /// on the coordinator. When false (default), uses sync-aware per-speaker routing.
    #[serde(default)]
    group: bool,
}

/// Request payload for mute control via WebSocket.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsMuteRequest {
    ip: String,
    mute: bool,
    /// When true, sets mute for the entire sync group via GroupRenderingControl
    /// on the coordinator. When false (default), uses sync-aware per-speaker routing.
    #[serde(default)]
    group: bool,
}

/// Request payload for speaker queries via WebSocket.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsSpeakerRequest {
    ip: String,
}

/// Request payload for stopping playback on a single speaker.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StopPlaybackSpeakerPayload {
    stream_id: String,
    ip: String,
    /// Reason for stopping (optional for backward compat).
    #[serde(default)]
    reason: Option<SpeakerRemovalReason>,
}

/// Encoder configuration from extension.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EncoderConfig {
    codec: String,
    #[allow(dead_code)]
    bitrate: Option<u32>,
    sample_rate: Option<u32>,
    channels: Option<u8>,
    /// Bit depth for audio encoding (16 or 24). Only 24-bit is supported for FLAC.
    bits_per_sample: Option<u16>,
    /// Jitter buffer size in milliseconds (100-1000). Only affects PCM codec.
    jitter_buffer_ms: Option<u64>,
    /// Frame size in samples per channel.
    /// Server derives exact duration: duration_ms = samples * 1000 / sample_rate
    frame_size_samples: Option<u32>,
}

/// Handshake request payload from client.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HandshakeRequest {
    /// Legacy codec field (deprecated).
    #[serde(default)]
    codec: Option<String>,
    /// New encoder config from extension.
    #[serde(default)]
    encoder_config: Option<EncoderConfig>,
}

/// Outgoing WebSocket messages.
#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "SCREAMING_SNAKE_CASE")]
enum WsOutgoing {
    HandshakeAck {
        payload: HandshakePayload,
    },
    HeartbeatAck,
    Error {
        message: String,
    },
    InitialState {
        payload: serde_json::Value,
    },
    VolumeState {
        payload: WsVolumePayload,
    },
    MuteState {
        payload: WsMutePayload,
    },
    StreamReady {
        payload: StreamReadyPayload,
    },
    PlaybackError {
        payload: PlaybackErrorPayload,
    },
    /// Multi-group playback results (per-speaker success/failure).
    PlaybackResults {
        payload: PlaybackResultsPayload,
    },
    /// Browser capture error (process exit, device change, etc.).
    BrowserCaptureError {
        payload: BrowserCaptureErrorPayload,
    },
}

/// Payload for browser capture error notification.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserCaptureErrorPayload {
    stream_id: String,
    error: String,
    /// Structured error code for extension dispatch (avoids string matching).
    reason: CaptureErrorReason,
}

/// Structured error reason sent to the extension for dispatch.
#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum CaptureErrorReason {
    ProcessExited,
    DeviceDisconnected,
    CaptureError,
}

/// Payload for stream ready notification.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StreamReadyPayload {
    buffer_size: usize,
}

/// Payload for playback error notification.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackErrorPayload {
    message: String,
}

/// Payload for multi-group playback results.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackResultsPayload {
    /// Per-speaker results (success/failure for each).
    results: Vec<crate::services::PlaybackResult>,
}

/// Payload for volume state responses.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WsVolumePayload {
    ip: String,
    volume: u8,
}

/// Payload for mute state responses.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct WsMutePayload {
    ip: String,
    mute: bool,
}

impl WsOutgoing {
    /// Serializes the message to a WebSocket text message.
    fn to_message(&self) -> Option<Message> {
        serde_json::to_string(self)
            .ok()
            .map(|s| Message::Text(s.into()))
    }
}

/// Handshake acknowledgment payload.
///
/// Carries the assigned `stream_id` only. Companion version metadata
/// (`protocolVersion`, `appVersion`, `appType`) is reported via
/// `INITIAL_STATE`, which fires on every WS connect — so the extension's
/// always-on control connection sees it without waiting for a stream.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HandshakePayload {
    stream_id: String,
}

/// Builds the reply for a command result.
///
/// On success, builds the reply with `response_fn`. On error, builds an
/// `ERROR` message carrying the error text.
fn reply_from_result<T, E, R>(result: Result<T, E>, response_fn: R) -> WsOutgoing
where
    E: std::fmt::Display,
    R: FnOnce(T) -> WsOutgoing,
{
    match result {
        Ok(value) => response_fn(value),
        Err(e) => WsOutgoing::Error {
            message: e.to_string(),
        },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Control Command Worker
// ─────────────────────────────────────────────────────────────────────────────

/// Maximum number of control commands (and replies) queued per connection.
///
/// Commands are dispatched with `try_send`, so a stuck worker (e.g. a speaker
/// that is not answering SOAP calls) never blocks the audio ingest loop; once
/// the queue is full the client gets an `ERROR` reply instead. Replies share the
/// capacity, and the teardown drain keeps reading them (see
/// [`drain_control_worker`]), so the worker can never park on `reply_tx.send`
/// while it finishes its queue.
const CONTROL_COMMAND_QUEUE_CAPACITY: usize = 32;

/// Worst case for a single retried SOAP action.
///
/// `sonos::retry::with_retry` makes four attempts, each bounded by
/// `SOAP_TIMEOUT_SECS`, with 200 + 500 + 1000 ms of backoff in between (rounded
/// up to 2 s here). Mirrors `RETRY_DELAYS_MS`, which is private to
/// `sonos::retry`.
const SOAP_ACTION_WORST_CASE_SECS: u64 = 4 * SOAP_TIMEOUT_SECS + 2;

/// Worst case for a single best-effort SOAP action.
///
/// `leave_group` and `stop` deliberately skip `with_retry` (retrying would delay
/// teardown for unresponsive speakers), so each costs one request bounded by the
/// shared SOAP timeout.
const BEST_EFFORT_SOAP_ACTION_WORST_CASE_SECS: u64 = SOAP_TIMEOUT_SECS;

/// How long the connection waits for the control worker to reach a point in its
/// queue: a queued barrier, or the end of the queue once the connection is
/// finished.
///
/// A control command is *not* one SOAP call. This is sized for the worst case of
/// `START_PLAYBACK` against a single wedged speaker, which is a best-effort
/// prefix plus a retried pair:
///
/// - coordinator/standalone speaker (`start_single_playback`): up to two
///   best-effort actions first — `leave_group` when promoting a slave, `stop`
///   when the speaker is switching away from another stream — then `play_uri`,
///   which is two retried actions (`SetAVTransportURI` + `Play`);
/// - slave of a group start (`join_slave_to_coordinator`): `leave_group` when
///   the slave is re-routed, then `join_group`, also two retried actions.
///
/// Speakers within a phase run concurrently (`join_all`), so the bound covers a
/// whole slave phase as well. A synchronized multi-speaker start still runs the
/// coordinator phase before the slave phase (and then GENA subscription work),
/// so one command can exceed this. Overrunning only costs the ordering guarantee
/// — the command itself is never cancelled (see [`await_control_worker`]).
const CONTROL_WORKER_GRACE: Duration = Duration::from_secs(
    2 * BEST_EFFORT_SOAP_ACTION_WORST_CASE_SECS + 2 * SOAP_ACTION_WORST_CASE_SECS,
);

/// A command taken off the WebSocket ingest path.
///
/// The speaker variants perform SOAP calls (which can take up to the SOAP
/// timeout, multiplied by retries), so they run on the per-connection control
/// worker rather than inline in the `select!` loop that ingests audio frames.
enum ControlCommand {
    SetVolume(WsVolumeRequest),
    SetMute(WsMuteRequest),
    GetVolume(WsSpeakerRequest),
    GetMute(WsSpeakerRequest),
    StartPlayback {
        /// Stream bound to the connection when the command arrived, if any.
        stream_id: Option<String>,
        /// Whether latency monitoring is enabled for the connection.
        latency_monitoring: bool,
        payload: StartPlaybackRequest,
    },
    StopPlaybackSpeaker(StopPlaybackSpeakerPayload),
    /// Stream metadata update. Does no SOAP work, but still runs on the worker
    /// so it stays ordered against the metadata write `START_PLAYBACK` performs
    /// there; applied inline it could be clobbered by the older metadata
    /// snapshot of a `START_PLAYBACK` that is still queued.
    MetadataUpdate {
        stream_id: String,
        metadata: StreamMetadata,
    },
    /// Ordering barrier: the ack fires once every command queued ahead of it
    /// has finished. Used by the inline stream-teardown paths so they never
    /// remove a stream out from under a queued `START_PLAYBACK`.
    Barrier(oneshot::Sender<()>),
}

/// Executes one control command.
///
/// Returns the reply to send to the client, or `None` for commands that have
/// no reply (`STOP_PLAYBACK_SPEAKER`, `METADATA_UPDATE`).
async fn execute_control_command(state: &AppState, command: ControlCommand) -> Option<WsOutgoing> {
    let sc = &state.stream_coordinator;
    match command {
        ControlCommand::SetVolume(payload) => {
            let ip = payload.ip.clone();
            let volume = payload.volume;
            let result = if payload.group {
                sc.set_sync_group_volume(&*state.sonos, &ip, volume).await
            } else {
                sc.set_volume_routed(&*state.sonos, &ip, volume).await
            };
            Some(reply_from_result(result, |()| WsOutgoing::VolumeState {
                payload: WsVolumePayload { ip, volume },
            }))
        }
        ControlCommand::SetMute(payload) => {
            let ip = payload.ip.clone();
            let mute = payload.mute;
            let result = if payload.group {
                sc.set_sync_group_mute(&*state.sonos, &ip, mute).await
            } else {
                sc.set_mute_routed(&*state.sonos, &ip, mute).await
            };
            Some(reply_from_result(result, |()| WsOutgoing::MuteState {
                payload: WsMutePayload { ip, mute },
            }))
        }
        ControlCommand::GetVolume(payload) => {
            let result = sc.get_volume_routed(&*state.sonos, &payload.ip).await;
            Some(reply_from_result(result, |volume| {
                WsOutgoing::VolumeState {
                    payload: WsVolumePayload {
                        ip: payload.ip,
                        volume,
                    },
                }
            }))
        }
        ControlCommand::GetMute(payload) => {
            let result = sc.get_mute_routed(&*state.sonos, &payload.ip).await;
            Some(reply_from_result(result, |mute| WsOutgoing::MuteState {
                payload: WsMutePayload {
                    ip: payload.ip,
                    mute,
                },
            }))
        }
        ControlCommand::StartPlayback {
            stream_id,
            latency_monitoring,
            payload,
        } => Some(handle_start_playback(state, stream_id, latency_monitoring, payload).await),
        ControlCommand::StopPlaybackSpeaker(payload) => {
            // Stop playback; stop latency monitoring for all stopped speakers
            // (when stopping a coordinator, this includes all its slaves)
            let stopped_ips = sc
                .stop_playback_speaker(&payload.stream_id, &payload.ip, payload.reason)
                .await;
            for ip in stopped_ips {
                state
                    .latency_monitor
                    .stop_speaker(&payload.stream_id, &ip)
                    .await;
            }
            None
        }
        ControlCommand::MetadataUpdate {
            stream_id,
            metadata,
        } => {
            handle_metadata_update(state, &stream_id, metadata);
            None
        }
        // Normally intercepted by the worker loop; acked here too so a barrier
        // can never be silently swallowed.
        ControlCommand::Barrier(ack) => {
            let _ = ack.send(());
            None
        }
    }
}

/// Runs the per-connection control worker.
///
/// Commands are executed one at a time in arrival order, so replies reach the
/// client in the same order the commands were sent (the extension correlates
/// replies by message type, not by request id). Each reply is forwarded through
/// `reply_tx`. Dropping the reply receiver says the connection is gone *and*
/// its queue must be abandoned: the worker stops picking up work and exits, so
/// nothing queued runs against a stream that teardown is about to remove. A
/// clean close with no stream to protect instead keeps the receiver alive and
/// drops the command sender, so the worker runs the queue out before exiting
/// (see [`drain_control_worker`]). Cancelling `cancel` likewise stops the worker
/// from starting further commands.
///
/// A command that is already running is always run to completion: aborting it
/// mid-SOAP could leave a speaker joined and playing with no `PlaybackSession`
/// recorded, which no cleanup path could then stop. Callers bound the wait
/// instead (see `CONTROL_WORKER_GRACE`).
async fn run_control_worker<F, Fut>(
    cancel: CancellationToken,
    mut cmd_rx: mpsc::Receiver<ControlCommand>,
    reply_tx: mpsc::Sender<WsOutgoing>,
    mut execute: F,
) where
    F: FnMut(ControlCommand) -> Fut,
    Fut: Future<Output = Option<WsOutgoing>>,
{
    loop {
        // Connection gone or force-closed: never start another queued command.
        // Checked before the `select!` below because that picks randomly among
        // ready branches, which would otherwise let a queued command start even
        // though the token is already cancelled.
        if reply_tx.is_closed() || cancel.is_cancelled() {
            break;
        }
        let command = tokio::select! {
            _ = cancel.cancelled() => break,
            _ = reply_tx.closed() => break,
            command = cmd_rx.recv() => match command {
                Some(command) => command,
                None => break,
            },
        };
        // Barriers are pure ordering markers: acking here (rather than in
        // `execute`) guarantees every command queued ahead of them has finished.
        if let ControlCommand::Barrier(ack) = command {
            let _ = ack.send(());
            continue;
        }
        if let Some(reply) = execute(command).await {
            if reply_tx.send(reply).await.is_err() {
                // Connection closed while the command was running: drop the reply.
                break;
            }
        }
    }
}

/// Waits until the control worker has finished everything queued so far.
///
/// Used by the inline handlers that tear down or replace the connection's
/// stream, so an already-queued `START_PLAYBACK` completes (and registers its
/// `PlaybackSession`) before the stream is removed — otherwise the speaker
/// would be left playing a dead stream with no session for cleanup to find.
///
/// Bounded by `CONTROL_WORKER_GRACE` so a command that runs even longer than one
/// wedged speaker cannot stall teardown indefinitely; the wait is no worse than
/// the inline handling this replaced, which blocked the whole connection for the
/// same SOAP calls. If the barrier does time out, teardown proceeds unordered
/// and the in-flight command can register a session for an already-removed
/// stream — recoverable (the session stays visible to `STOP_PLAYBACK_SPEAKER`
/// and `INITIAL_STATE`), unlike cancelling the command mid-SOAP.
///
/// A full command queue is handled inside that same bound rather than waved
/// through: the barrier waits for a slot, because a backed-up worker is exactly
/// the situation where an unordered teardown does damage.
async fn quiesce_control_worker(cmd_tx: &mpsc::Sender<ControlCommand>) {
    let (ack_tx, ack_rx) = oneshot::channel();
    let barrier = async {
        match cmd_tx.try_send(ControlCommand::Barrier(ack_tx)) {
            Ok(()) => {}
            // The worker is gone, so there is nothing left to order against.
            Err(mpsc::error::TrySendError::Closed(_)) => return,
            Err(mpsc::error::TrySendError::Full(command)) => {
                // A full queue is exactly when ordering matters most, so wait for
                // a slot instead of tearing down unordered. Awaiting here is no
                // worse than the barrier wait itself, and the whole thing is
                // bounded by the timeout below.
                if cmd_tx.send(command).await.is_err() {
                    return;
                }
            }
        }
        let _ = ack_rx.await;
    };
    if tokio::time::timeout(CONTROL_WORKER_GRACE, barrier)
        .await
        .is_err()
    {
        log::warn!("[WS] Control worker did not drain in time; proceeding");
    }
}

/// Waits for the control worker to finish, then lets go of it.
///
/// The worker is never aborted. A SOAP call torn apart mid-flight can leave a
/// speaker joined or playing while `PlaybackSession` registration (which happens
/// only after the call returns) never runs, so no cleanup path can stop or
/// un-group it afterwards — `with_retry` also retries transient SOAP *faults*,
/// where an individual call returns quickly and a later attempt can land right
/// as the abort would. If the worker is still busy after `CONTROL_WORKER_GRACE`
/// the handle is simply dropped: the command runs to completion detached (its
/// task owns a clone of `AppState`), the worker then sees the closed reply
/// channel and exits without touching the rest of its queue, and the reply is
/// discarded because the connection is gone.
async fn await_control_worker(worker: tokio::task::JoinHandle<()>) {
    if tokio::time::timeout(CONTROL_WORKER_GRACE, worker)
        .await
        .is_err()
    {
        log::warn!(
            "[WS] Control worker still busy after {}s; leaving it to finish detached",
            CONTROL_WORKER_GRACE.as_secs()
        );
    }
}

/// Lets the control worker finish the commands still queued for it.
///
/// The caller must have dropped the command sender first: that is what makes
/// `cmd_rx` return `None` once the queue is empty, so the worker exits on its
/// own. `reply_rx` is kept until then — not because anything still reads the
/// replies (the socket is gone, so they are discarded) but because dropping it
/// is the signal to abandon the queue, and because reading keeps the worker from
/// parking on a full reply channel.
///
/// Used for a clean close of a connection that owns no stream: nothing in that
/// teardown removes a stream a queued command could race, and a discarded
/// command is a lost user action — `STOP_PLAYBACK_SPEAKER` has no ack and is
/// never retried, so dropping it leaves a speaker playing.
///
/// Bounded by `CONTROL_WORKER_GRACE`, which covers one wedged speaker; a longer
/// queue than that is abandoned when `reply_rx` drops on timeout, and whatever
/// is in flight then finishes detached (never cancelled mid-SOAP).
async fn drain_control_worker(mut reply_rx: mpsc::Receiver<WsOutgoing>) {
    // `recv` yields the worker's replies and returns `None` once the worker has
    // dropped `reply_tx`, which it does only as it exits.
    let drained = tokio::time::timeout(CONTROL_WORKER_GRACE, async {
        while reply_rx.recv().await.is_some() {}
    })
    .await;
    if drained.is_err() {
        log::warn!(
            "[WS] Control worker still draining after {}s; abandoning the rest of its queue",
            CONTROL_WORKER_GRACE.as_secs()
        );
    }
}

/// Queues a control command for the connection's worker without blocking.
///
/// Returns the `ERROR` reply to send when the command could not be queued
/// (queue full, or the worker is gone).
fn dispatch_control_command(
    cmd_tx: &mpsc::Sender<ControlCommand>,
    command: ControlCommand,
) -> Result<(), WsOutgoing> {
    cmd_tx.try_send(command).map_err(|e| {
        let message = match e {
            mpsc::error::TrySendError::Full(_) => {
                "Too many pending control commands; try again shortly".to_string()
            }
            mpsc::error::TrySendError::Closed(_) => {
                "Control command worker is not available".to_string()
            }
        };
        log::warn!("[WS] Control command dropped: {}", message);
        WsOutgoing::Error { message }
    })
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Message Handlers
// ─────────────────────────────────────────────────────────────────────────────

/// Builds the initial state message for WebSocket clients.
///
/// Includes Sonos state (groups, transport, volume, mute), active playback
/// sessions, current network health status, and the companion's version
/// metadata (`appVersion`, `protocolVersion`, `appType`).
///
/// `INITIAL_STATE` fires on every WebSocket connect — including the always-on
/// control connection the extension uses purely for state monitoring — so
/// putting the version fields here means the extension's mismatch warning
/// fires immediately, without waiting for the user to start a stream.
fn build_initial_state(state: &AppState) -> Option<Message> {
    let mut payload = state.sonos_state.to_json();

    // Add sessions to the initial state
    if let serde_json::Value::Object(ref mut map) = payload {
        let sessions = state.stream_coordinator.get_all_sessions();
        let sessions_json = match serde_json::to_value(&sessions) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[WS] Failed to serialize sessions: {}", e);
                serde_json::Value::Array(vec![])
            }
        };
        map.insert("sessions".to_string(), sessions_json);

        // Add network health to the initial state
        let health_state = state
            .discovery_service
            .topology_monitor()
            .get_network_health();
        let health_json = match serde_json::to_value(health_state.health) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[WS] Failed to serialize networkHealth: {}", e);
                serde_json::Value::Null
            }
        };
        map.insert("networkHealth".to_string(), health_json);
        if let Some(reason) = &health_state.reason {
            map.insert(
                "networkHealthReason".to_string(),
                serde_json::Value::String(reason.clone()),
            );
        }

        // Companion version metadata — same fields as HANDSHAKE_ACK so the
        // extension's control connection can drive the version-mismatch
        // warning without waiting for the user to start a stream.
        map.insert(
            "protocolVersion".to_string(),
            serde_json::Value::String(crate::protocol_constants::PROTOCOL_VERSION.to_string()),
        );
        map.insert(
            "appVersion".to_string(),
            serde_json::Value::String(state.app_info.app_version.to_string()),
        );
        if let Ok(app_type_json) = serde_json::to_value(state.app_info.app_type) {
            map.insert("appType".to_string(), app_type_json);
        }
    }

    WsOutgoing::InitialState { payload }.to_message()
}

/// Result of handling a handshake request.
enum HandshakeResult {
    /// Successfully created stream with this ID.
    Success(String),
    /// Failed to create stream, connection should close.
    Error(String),
}

/// Resolves input codec string to output codec.
///
/// Maps extension codec names to the `AudioCodec` enum used for HTTP Content-Type
/// and Sonos transport configuration.
fn resolve_codec(codec_str: Option<&str>) -> AudioCodec {
    match codec_str {
        Some("pcm") => {
            log::info!("[WS] PCM codec selected");
            AudioCodec::Pcm
        }
        Some("aac") | Some("aac-lc") | Some("he-aac") | Some("he-aac-v2") => AudioCodec::Aac,
        Some("mp3") => AudioCodec::Mp3,
        Some("flac") => AudioCodec::Flac,
        Some("wav") => AudioCodec::Pcm, // Legacy alias
        _ => {
            log::warn!("[WS] Unknown codec {:?}, defaulting to PCM", codec_str);
            AudioCodec::Pcm
        }
    }
}

/// Parsed and validated stream configuration from a handshake request.
struct StreamConfig {
    codec: AudioCodec,
    audio_format: AudioFormat,
    jitter_buffer_ms: u64,
    frame_duration_ms: u32,
}

/// Parses and validates stream configuration from a handshake request.
///
/// Extracts codec, sample rate, channels, bit depth, buffer size, and frame duration
/// from the encoder config (or legacy fields), applying defaults and validation.
fn parse_stream_config(payload: &HandshakeRequest) -> Result<StreamConfig, String> {
    let codec_str = payload
        .encoder_config
        .as_ref()
        .map(|c| c.codec.as_str())
        .or(payload.codec.as_deref());

    let codec = resolve_codec(codec_str);

    let sample_rate = payload
        .encoder_config
        .as_ref()
        .and_then(|c| c.sample_rate)
        .unwrap_or(48000);

    // Validate channels (1 or 2 only).
    // Multi-channel (>2) is not supported - crossfade utilities assume stereo or mono.
    let channels = match payload
        .encoder_config
        .as_ref()
        .and_then(|c| c.channels)
        .unwrap_or(2)
    {
        valid @ (1 | 2) => valid,
        other => {
            log::error!(
                "[WS] Invalid channels {}, must be 1 (mono) or 2 (stereo)",
                other
            );
            return Err(format!(
                "Invalid channels: {}. Must be 1 (mono) or 2 (stereo).",
                other
            ));
        }
    };

    let jitter_buffer_ms = payload
        .encoder_config
        .as_ref()
        .and_then(|c| c.jitter_buffer_ms)
        .unwrap_or(DEFAULT_JITTER_BUFFER_MS)
        .clamp(MIN_JITTER_BUFFER_MS, MAX_JITTER_BUFFER_MS);

    // Derive frame duration from frame_size_samples.
    // Using samples avoids floating-point rounding errors in the extension.
    // Formula: duration_ms = samples * 1000 / sample_rate
    let frame_duration_ms = payload
        .encoder_config
        .as_ref()
        .and_then(|c| c.frame_size_samples)
        .map(|samples| (samples as u64 * 1000 / sample_rate as u64) as u32)
        .unwrap_or(SILENCE_FRAME_DURATION_MS)
        .clamp(MIN_FRAME_DURATION_MS, MAX_FRAME_DURATION_MS);

    // Validate bit depth (16 or 24), defaulting to 16.
    // 24-bit is only supported for FLAC codec on Sonos S2 speakers.
    let bits_per_sample = match payload
        .encoder_config
        .as_ref()
        .and_then(|c| c.bits_per_sample)
        .unwrap_or(16)
    {
        24 if codec == AudioCodec::Flac => 24,
        24 => {
            log::warn!(
                "[WS] 24-bit audio requested but codec is {:?}, falling back to 16-bit",
                codec
            );
            16
        }
        16 => 16,
        other => {
            log::error!("[WS] Invalid bits_per_sample {}, must be 16 or 24", other);
            return Err(format!(
                "Invalid bits_per_sample: {}. Must be 16 or 24.",
                other
            ));
        }
    };

    Ok(StreamConfig {
        codec,
        audio_format: AudioFormat::new(sample_rate, channels as u16, bits_per_sample),
        jitter_buffer_ms,
        frame_duration_ms,
    })
}

/// Handles a HANDSHAKE message: creates a stream and returns ack or error.
fn handle_handshake(state: &AppState, payload: HandshakeRequest) -> HandshakeResult {
    let config = match parse_stream_config(&payload) {
        Ok(c) => c,
        Err(e) => return HandshakeResult::Error(e),
    };

    log::info!(
        "[WS] Creating stream: codec={:?}, format={:?}, buffer={}ms, frame={}ms",
        config.codec,
        config.audio_format,
        config.jitter_buffer_ms,
        config.frame_duration_ms
    );

    match state.stream_coordinator.create_stream(
        config.codec,
        config.audio_format,
        config.jitter_buffer_ms,
        config.frame_duration_ms,
    ) {
        Ok(id) => HandshakeResult::Success(id),
        Err(e) => HandshakeResult::Error(e),
    }
}

/// Handles a METADATA_UPDATE message: updates stream metadata.
fn handle_metadata_update(state: &AppState, stream_id: &str, metadata: StreamMetadata) {
    // [DIAG] Log metadata updates from extension
    log::info!(
        "[WS] METADATA_UPDATE for stream {}: title={:?}, artist={:?}, source={:?}",
        stream_id,
        metadata.title,
        metadata.artist,
        metadata.source
    );
    state
        .stream_coordinator
        .update_metadata(stream_id, metadata);
}

/// Handles binary audio data: pushes frame to stream buffer.
///
/// Returns `true` if this was the first frame (stream just became ready),
/// `false` otherwise.
fn handle_binary_data(state: &AppState, stream_id: &str, data: Bytes) -> bool {
    state
        .stream_coordinator
        .push_frame(stream_id, data)
        .unwrap_or(false)
}

/// Browser capture state grouped together — these always travel as a unit.
struct BrowserCaptureState {
    session: Option<crate::services::CaptureStreamSession>,
    error_rx: Option<tokio::sync::mpsc::Receiver<crate::capture::CaptureError>>,
}

impl BrowserCaptureState {
    fn new() -> Self {
        Self {
            session: None,
            error_rx: None,
        }
    }
}

/// Handles a START_BROWSER_CAPTURE message: starts capture and creates a stream.
///
/// Uses the `CaptureSourceFactory` from `AppState` to create a platform-specific
/// capture source. The capture thread pushes Float32 audio through the
/// `StreamSinkBridge`, which converts to PCM16 and calls `push_frame()`.
/// When the first frame arrives, `ready_notify` fires and we send `STREAM_READY`.
async fn handle_start_browser_capture(
    state: &AppState,
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    stream_guard: &mut Option<StreamGuard>,
    capture: &mut BrowserCaptureState,
    payload: StartBrowserCaptureRequest,
) {
    // Reject if already capturing
    if capture.session.is_some() {
        let msg = WsOutgoing::Error {
            message: "Browser capture already active on this connection".into(),
        };
        if let Some(msg) = msg.to_message() {
            let _ = sender.send(msg).await;
        }
        return;
    }

    // Check that a capture factory is available
    let factory = match &state.capture_factory {
        Some(f) if f.available() => f,
        _ => {
            let msg = WsOutgoing::Error {
                message: "Browser capture is not available on this platform".into(),
            };
            if let Some(msg) = msg.to_message() {
                let _ = sender.send(msg).await;
            }
            return;
        }
    };

    // Create capture source via factory
    let source = match factory.create_source(payload.browser_name.as_deref()) {
        Ok(s) => s,
        Err(e) => {
            let msg = WsOutgoing::Error {
                message: format!("Failed to create capture source: {}", e),
            };
            if let Some(msg) = msg.to_message() {
                let _ = sender.send(msg).await;
            }
            return;
        }
    };

    // Parse stream config from encoder config (same validation as tab capture handshake)
    let stream_config = match parse_stream_config(&HandshakeRequest {
        codec: None,
        encoder_config: payload.encoder_config,
    }) {
        Ok(c) => c,
        Err(e) => {
            let msg = WsOutgoing::Error {
                message: format!("Invalid encoder config: {}", e),
            };
            if let Some(msg) = msg.to_message() {
                let _ = sender.send(msg).await;
            }
            return;
        }
    };

    let metadata = StreamMetadata {
        title: Some("Browser Audio".into()),
        source: payload.browser_name.clone(),
        ..Default::default()
    };

    // Only the buffering parameters apply: the wire format (PCM at the
    // source's negotiated rate and channel count) is decided by the source.
    //
    // Starting the source blocks until the platform has negotiated a format
    // (WASAPI activation and initialization can take seconds when an endpoint
    // misbehaves), so run it on the blocking pool rather than a runtime worker.
    let coordinator = Arc::clone(&state.stream_coordinator);
    let jitter_buffer_ms = stream_config.jitter_buffer_ms;
    let frame_duration_ms = stream_config.frame_duration_ms;
    let started = tokio::task::spawn_blocking(move || {
        coordinator.start_capture_stream(
            source,
            jitter_buffer_ms,
            frame_duration_ms,
            Some(metadata),
        )
    })
    .await
    .unwrap_or_else(|e| Err(format!("Failed to start capture: {}", e)));

    match started {
        Ok(mut session) => {
            let stream_id = session.stream_id.clone();
            let ready = Arc::clone(&session.ready_notify);

            // Create stream guard for RAII cleanup
            let guard = StreamGuard::new(stream_id.clone(), Arc::clone(&state.stream_coordinator));

            // Send handshake ack with the stream ID
            let ack = WsOutgoing::HandshakeAck {
                payload: HandshakePayload {
                    stream_id: stream_id.clone(),
                },
            };
            if let Some(msg) = ack.to_message() {
                let _ = sender.send(msg).await;
            }

            *stream_guard = Some(guard);

            // Extract the error receiver for monitoring in the select loop
            capture.error_rx = session.handle.errors.take();
            capture.session = Some(session);

            // Wait for first audio frame (with timeout)
            let ready_result = tokio::time::timeout(Duration::from_secs(5), ready.notified()).await;

            if ready_result.is_ok() {
                if let Some(stream) = state.stream_coordinator.get_stream(&stream_id) {
                    let msg = WsOutgoing::StreamReady {
                        payload: StreamReadyPayload {
                            buffer_size: stream.buffer_len(),
                        },
                    };
                    if let Some(msg) = msg.to_message() {
                        let _ = sender.send(msg).await;
                    }
                }
            } else {
                log::warn!("[WS] Browser capture: timeout waiting for first audio frame");
                let msg = WsOutgoing::Error {
                    message: "Timeout waiting for audio from browser. Is audio playing?".into(),
                };
                if let Some(msg) = msg.to_message() {
                    let _ = sender.send(msg).await;
                }
            }
        }
        Err(e) => {
            let msg = WsOutgoing::Error { message: e };
            if let Some(msg) = msg.to_message() {
                let _ = sender.send(msg).await;
            }
        }
    }
}

/// Handles a STOP_BROWSER_CAPTURE message: stops the capture, then removes
/// the stream with the same graceful speaker cleanup as a disconnect (SOAP
/// Stop, sync slave restoration, `PlaybackStopped`).
async fn handle_stop_browser_capture(
    state: &AppState,
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    stream_guard: &mut Option<StreamGuard>,
    capture: &mut BrowserCaptureState,
) {
    if let Some(session) = capture.session.take() {
        log::info!(
            "[WS] Stopping browser capture for stream {}",
            session.stream_id
        );
        capture.error_rx = None;
        session.handle.stop_and_wait();
        if let Some(guard) = stream_guard.take() {
            state.latency_monitor.stop_stream(guard.id()).await;
            state
                .stream_coordinator
                .remove_stream_async(guard.id())
                .await;
            guard.disarm();
        }
    } else {
        let msg = WsOutgoing::Error {
            message: "No active browser capture to stop".into(),
        };
        if let Some(msg) = msg.to_message() {
            let _ = sender.send(msg).await;
        }
    }
}

/// Handles a START_PLAYBACK message: starts playback on the requested speakers.
///
/// Runs on the control worker; returns the reply for the client.
async fn handle_start_playback(
    state: &AppState,
    stream_id: Option<String>,
    latency_monitoring: bool,
    payload: StartPlaybackRequest,
) -> WsOutgoing {
    // [DIAG] Log START_PLAYBACK request with initial metadata
    log::info!(
        "[WS] START_PLAYBACK: metadata={:?}",
        payload.metadata.as_ref().map(|m| format!(
            "title={:?}, artist={:?}, source={:?}",
            m.title, m.artist, m.source
        ))
    );

    let Some(stream_id) = stream_id else {
        return WsOutgoing::PlaybackError {
            payload: PlaybackErrorPayload {
                message: "No active stream on this connection".into(),
            },
        };
    };

    let speaker_ips = payload.get_speaker_ips();

    if speaker_ips.is_empty() {
        return WsOutgoing::PlaybackError {
            payload: PlaybackErrorPayload {
                message: "No speaker IPs provided".into(),
            },
        };
    }

    // Update stream's stored metadata BEFORE starting playback
    // This ensures ICY metadata is available immediately,
    // not just when METADATA_UPDATE arrives later
    if let Some(ref metadata) = payload.metadata {
        state
            .stream_coordinator
            .update_metadata(&stream_id, metadata.clone());
    }

    // Start playback on all speakers (multi-group support)
    let artwork_url = state.artwork_metadata_url();
    let results = state
        .stream_coordinator
        .start_playback_multi(
            &speaker_ips,
            &stream_id,
            payload.metadata.as_ref(),
            &artwork_url,
            payload.sync_speakers,
        )
        .await;

    // Only start latency monitoring if video sync is enabled
    if latency_monitoring {
        for result in &results {
            if result.success {
                state
                    .latency_monitor
                    .start_monitoring(&stream_id, &result.speaker_ip)
                    .await;
            }
        }
    }

    // Reply with PLAYBACK_RESULTS carrying per-speaker outcomes
    WsOutgoing::PlaybackResults {
        payload: PlaybackResultsPayload { results },
    }
}

/// WebSocket upgrade handler.
pub async fn ws_handler(ws: WebSocketUpgrade, State(state): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

/// Main WebSocket connection handler.
async fn handle_ws(socket: WebSocket, state: AppState) {
    let (mut sender, mut receiver) = socket.split();
    let mut stream_guard: Option<StreamGuard> = None;
    let mut capture = BrowserCaptureState::new();
    let mut broadcast_rx = state.event_bridge.subscribe();
    let mut last_activity = Instant::now();
    let mut latency_monitoring = false;

    // Register connection for tracking and force-close capability
    let conn_guard = state.ws_manager.register();
    let cancel_token = conn_guard.cancel_token().clone();

    log::info!("[WS] New connection established: {}", conn_guard.id());

    // Speaker control commands run on a per-connection worker so that a slow
    // or unresponsive speaker (SOAP timeout x retries) never stalls audio
    // frame ingestion in the select loop below. Replies come back through
    // `reply_rx` and are forwarded to the client in command order.
    let (cmd_tx, cmd_rx) = mpsc::channel::<ControlCommand>(CONTROL_COMMAND_QUEUE_CAPACITY);
    let (reply_tx, mut reply_rx) = mpsc::channel::<WsOutgoing>(CONTROL_COMMAND_QUEUE_CAPACITY);
    let control_worker = tokio::spawn({
        let state = state.clone();
        let cancel = cancel_token.clone();
        run_control_worker(cancel, cmd_rx, reply_tx, move |command| {
            let state = state.clone();
            async move { execute_control_command(&state, command).await }
        })
    });

    // Send initial state immediately on connect (before any handshake)
    // This allows clients to monitor speaker state without creating a stream
    if let Some(msg) = build_initial_state(&state) {
        if sender.send(msg).await.is_err() {
            log::warn!("[WS] Failed to send initial state, client disconnected");
            return;
        }
    }

    // Use interval instead of sleep to reduce timer allocations and prevent drift.
    // Delay mode skips missed ticks rather than bursting to catch up.
    let mut heartbeat_interval =
        tokio::time::interval(Duration::from_secs(WS_HEARTBEAT_CHECK_INTERVAL_SECS));
    heartbeat_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            // Handle force-close request
            _ = cancel_token.cancelled() => {
                log::info!("[WS] Connection force-closed: {}", conn_guard.id());
                break;
            }
            // Handle incoming messages from the client
            msg = receiver.next() => {
                last_activity = Instant::now();
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        let parsed = serde_json::from_str::<WsIncoming>(&text);
                        match parsed {
                            Ok(WsIncoming::Handshake { payload }) => {
                                match handle_handshake(&state, payload) {
                                    HandshakeResult::Success(id) => {
                                        // Replacing a live stream drops its guard
                                        // (sync removal), so let any queued command
                                        // for that stream finish first.
                                        if stream_guard.is_some() {
                                            quiesce_control_worker(&cmd_tx).await;
                                        }
                                        // Create guard immediately - cleanup happens on drop
                                        let guard = StreamGuard::new(
                                            id.clone(),
                                            Arc::clone(&state.stream_coordinator),
                                        );
                                        let ack = WsOutgoing::HandshakeAck {
                                            payload: HandshakePayload { stream_id: id },
                                        };
                                        stream_guard = Some(guard);
                                        if let Some(msg) = ack.to_message() {
                                            let _ = sender.send(msg).await;
                                        }
                                    }
                                    HandshakeResult::Error(e) => {
                                        let err = WsOutgoing::Error { message: e };
                                        if let Some(msg) = err.to_message() {
                                            let _ = sender.send(msg).await;
                                        }
                                        break;
                                    }
                                }
                            }
                            Ok(WsIncoming::Heartbeat) => {
                                if let Some(msg) = WsOutgoing::HeartbeatAck.to_message() {
                                    let _ = sender.send(msg).await;
                                }
                            }
                            Ok(WsIncoming::MetadataUpdate { payload }) => {
                                if let Some(ref guard) = stream_guard {
                                    // Queued (not applied inline) so it stays ordered
                                    // against the metadata a queued START_PLAYBACK
                                    // carries. Dropping it on a full queue is silent:
                                    // the extension treats ERROR as a playback failure
                                    // and metadata updates are re-sent on every change.
                                    let _ = dispatch_control_command(
                                        &cmd_tx,
                                        ControlCommand::MetadataUpdate {
                                            stream_id: guard.id().to_string(),
                                            metadata: payload,
                                        },
                                    );
                                }
                            }
                            // Speaker control commands are queued for the control
                            // worker so SOAP latency never blocks frame ingestion.
                            Ok(WsIncoming::SetVolume { payload }) => {
                                if let Err(err) = dispatch_control_command(
                                    &cmd_tx,
                                    ControlCommand::SetVolume(payload),
                                ) {
                                    if let Some(msg) = err.to_message() {
                                        let _ = sender.send(msg).await;
                                    }
                                }
                            }
                            Ok(WsIncoming::SetMute { payload }) => {
                                if let Err(err) = dispatch_control_command(
                                    &cmd_tx,
                                    ControlCommand::SetMute(payload),
                                ) {
                                    if let Some(msg) = err.to_message() {
                                        let _ = sender.send(msg).await;
                                    }
                                }
                            }
                            Ok(WsIncoming::GetVolume { payload }) => {
                                if let Err(err) = dispatch_control_command(
                                    &cmd_tx,
                                    ControlCommand::GetVolume(payload),
                                ) {
                                    if let Some(msg) = err.to_message() {
                                        let _ = sender.send(msg).await;
                                    }
                                }
                            }
                            Ok(WsIncoming::GetMute { payload }) => {
                                if let Err(err) = dispatch_control_command(
                                    &cmd_tx,
                                    ControlCommand::GetMute(payload),
                                ) {
                                    if let Some(msg) = err.to_message() {
                                        let _ = sender.send(msg).await;
                                    }
                                }
                            }
                            Ok(WsIncoming::StartPlayback { payload }) => {
                                // Sticky: once enabled, stays for the connection lifetime
                                if payload.video_sync_enabled {
                                    latency_monitoring = true;
                                }
                                let command = ControlCommand::StartPlayback {
                                    stream_id: stream_guard.as_ref().map(|g| g.id().to_string()),
                                    latency_monitoring,
                                    payload,
                                };
                                if let Err(err) = dispatch_control_command(&cmd_tx, command) {
                                    if let Some(msg) = err.to_message() {
                                        let _ = sender.send(msg).await;
                                    }
                                }
                            }
                            Ok(WsIncoming::StopPlaybackSpeaker { payload }) => {
                                if let Err(err) = dispatch_control_command(
                                    &cmd_tx,
                                    ControlCommand::StopPlaybackSpeaker(payload),
                                ) {
                                    if let Some(msg) = err.to_message() {
                                        let _ = sender.send(msg).await;
                                    }
                                }
                            }
                            Ok(WsIncoming::StartBrowserCapture { payload }) => {
                                // Replacing a live stream drops its guard, so drain
                                // any command still queued for that stream first.
                                if stream_guard.is_some() {
                                    quiesce_control_worker(&cmd_tx).await;
                                }
                                handle_start_browser_capture(
                                    &state,
                                    &mut sender,
                                    &mut stream_guard,
                                    &mut capture,
                                    payload,
                                ).await;
                            }
                            Ok(WsIncoming::StopBrowserCapture) => {
                                // The handler removes the stream inline; a queued
                                // START_PLAYBACK must finish first so its speaker is
                                // registered and gets stopped by the removal.
                                if capture.session.is_some() {
                                    quiesce_control_worker(&cmd_tx).await;
                                }
                                handle_stop_browser_capture(
                                    &state,
                                    &mut sender,
                                    &mut stream_guard,
                                    &mut capture,
                                ).await;
                            }
                            Err(_) => {} // Unknown message type, ignore
                        }
                    }
                    Some(Ok(Message::Binary(data))) => {
                        if let Some(ref guard) = stream_guard {
                            let is_first_frame = handle_binary_data(&state, guard.id(), data);

                            // Send STREAM_READY on first frame
                            if is_first_frame {
                                if let Some(stream) = state.stream_coordinator.get_stream(guard.id()) {
                                    let msg = WsOutgoing::StreamReady {
                                        payload: StreamReadyPayload {
                                            buffer_size: stream.buffer_len(),
                                        },
                                    };
                                    if let Some(msg) = msg.to_message() {
                                        let _ = sender.send(msg).await;
                                    }
                                }
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    _ => {}
                }
            }
            // Forward control command replies produced by the worker
            Some(reply) = reply_rx.recv() => {
                if let Some(msg) = reply.to_message() {
                    let _ = sender.send(msg).await;
                }
            }
            // Handle broadcasted events (GENA, etc.)
            Ok(event) = broadcast_rx.recv() => {
                if let Ok(json) = serde_json::to_string(&event) {
                    if sender.send(Message::Text(json.into())).await.is_err() {
                        break;
                    }
                }
            }
            // Monitor browser capture errors (process exit, device disconnected, etc.)
            capture_err = async {
                match capture.error_rx.as_mut() {
                    Some(rx) => rx.recv().await,
                    None => std::future::pending().await,
                }
            } => {
                if let Some(err) = capture_err {
                    log::warn!("[WS] Browser capture error: {}", err);
                    let reason = match &err {
                        crate::capture::CaptureError::ProcessExited => CaptureErrorReason::ProcessExited,
                        crate::capture::CaptureError::DeviceDisconnected => CaptureErrorReason::DeviceDisconnected,
                        _ => CaptureErrorReason::CaptureError,
                    };
                    if let Some(ref guard) = stream_guard {
                        let msg = WsOutgoing::BrowserCaptureError {
                            payload: BrowserCaptureErrorPayload {
                                stream_id: guard.id().to_string(),
                                error: err.to_string(),
                                reason,
                            },
                        };
                        if let Some(msg) = msg.to_message() {
                            let _ = sender.send(msg).await;
                        }
                    }
                    // Break to post-loop code for graceful async cleanup
                    // (latency_monitor.stop_stream + remove_stream_async)
                    capture.error_rx = None;
                    if let Some(session) = capture.session.take() {
                        session.handle.stop_and_wait();
                    }
                    break;
                }
            }
            // Heartbeat timeout check
            _ = heartbeat_interval.tick() => {
                if last_activity.elapsed() > Duration::from_secs(WS_HEARTBEAT_TIMEOUT_SECS) {
                    log::warn!("[WS] Heartbeat timeout");
                    break;
                }
            }
        }
    }

    // Stop accepting control commands.
    drop(cmd_tx);
    if cancel_token.is_cancelled() || stream_guard.is_some() || capture.session.is_some() {
        // Abandon whatever is still queued. Dropping `reply_rx` tells the worker
        // to stop picking up work, so a queued `START_PLAYBACK` cannot race the
        // stream removal below (it would leave a speaker playing a stream that
        // is already gone), and a force-close means stop, not finish the queue.
        // A command already in flight is run to completion (never cancelled
        // mid-SOAP) so the stream cleanup below sees any speaker it just
        // started. Its reply is dropped because nobody is reading `reply_rx`.
        drop(reply_rx);
        if stream_guard.is_some() || capture.session.is_some() {
            // Only a stream removal needs the worker's speaker registrations to
            // be in place first. A force-closed control-only connection has
            // nothing to order against, so it drops the handle straight away
            // (detaching, not cancelling) instead of holding the task open.
            await_control_worker(control_worker).await;
        }
    } else {
        // Clean close of a connection that owns no stream: nothing below removes
        // a stream, so there is nothing for a queued command to race. Run the
        // queue out rather than discarding it — a queued `STOP_PLAYBACK_SPEAKER`
        // is a user action with no ack and no retry, and dropping it would leave
        // a speaker playing.
        drain_control_worker(reply_rx).await;
    }

    // Stop capture source if active (before stream removal)
    if let Some(session) = capture.session.take() {
        session.handle.stop_and_wait();
    }

    // Graceful cleanup: stop speakers before stream removal, then disarm the
    // guard so its drop does not remove the stream (and emit `Ended`) again.
    if let Some(guard) = stream_guard.take() {
        // Stop latency monitoring for this stream
        state.latency_monitor.stop_stream(guard.id()).await;

        state
            .stream_coordinator
            .remove_stream_async(guard.id())
            .await;
        guard.disarm();
    }

    // StreamGuard and ConnectionGuard Drop impls handle any remaining cleanup
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn json(msg: &WsOutgoing) -> String {
        serde_json::to_string(msg).expect("serializable")
    }

    fn set_volume(volume: u8) -> ControlCommand {
        ControlCommand::SetVolume(WsVolumeRequest {
            ip: "192.168.1.10".into(),
            volume,
            group: false,
        })
    }

    fn volume_state(volume: u8) -> WsOutgoing {
        WsOutgoing::VolumeState {
            payload: WsVolumePayload {
                ip: "192.168.1.10".into(),
                volume,
            },
        }
    }

    #[track_caller]
    fn assert_error_contains(reply: &WsOutgoing, needle: &str) {
        match reply {
            WsOutgoing::Error { message } => assert!(
                message.contains(needle),
                "expected ERROR containing {needle:?}, got {message:?}"
            ),
            other => panic!("expected an ERROR reply, got {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn worker_forwards_replies_in_command_order() {
        let (cmd_tx, cmd_rx) = mpsc::channel(4);
        let (reply_tx, mut reply_rx) = mpsc::channel(4);
        let worker = tokio::spawn(run_control_worker(
            CancellationToken::new(),
            cmd_rx,
            reply_tx,
            |command| async move {
                match command {
                    ControlCommand::SetVolume(req) => {
                        // The first command is slow; the second must still reply after it.
                        if req.volume == 10 {
                            tokio::time::sleep(Duration::from_millis(50)).await;
                        }
                        Some(volume_state(req.volume))
                    }
                    ControlCommand::StopPlaybackSpeaker(_) => None,
                    _ => Some(WsOutgoing::HeartbeatAck),
                }
            },
        ));

        dispatch_control_command(&cmd_tx, set_volume(10)).unwrap();
        dispatch_control_command(&cmd_tx, set_volume(20)).unwrap();

        let first = reply_rx.recv().await.expect("first reply");
        let second = reply_rx.recv().await.expect("second reply");
        assert_eq!(json(&first), json(&volume_state(10)));
        assert_eq!(json(&second), json(&volume_state(20)));

        drop(cmd_tx);
        worker
            .await
            .expect("worker exits when the command channel closes");
    }

    #[tokio::test]
    async fn worker_drops_replies_after_connection_closes() {
        let (cmd_tx, cmd_rx) = mpsc::channel(4);
        let (reply_tx, reply_rx) = mpsc::channel(4);
        let worker = tokio::spawn(run_control_worker(
            CancellationToken::new(),
            cmd_rx,
            reply_tx,
            |_| async { Some(WsOutgoing::HeartbeatAck) },
        ));

        // Connection gone before the reply is produced.
        drop(reply_rx);
        dispatch_control_command(&cmd_tx, set_volume(5)).unwrap();

        worker
            .await
            .expect("worker exits quietly when nobody reads replies");
    }

    #[tokio::test]
    async fn cancellation_stops_the_worker_without_tearing_the_in_flight_command() {
        let (cmd_tx, cmd_rx) = mpsc::channel(4);
        let (reply_tx, mut reply_rx) = mpsc::channel(4);
        let cancel = CancellationToken::new();
        let started = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let executed = Arc::new(AtomicUsize::new(0));
        let worker = tokio::spawn(run_control_worker(cancel.clone(), cmd_rx, reply_tx, {
            let started = Arc::clone(&started);
            let release = Arc::clone(&release);
            let executed = Arc::clone(&executed);
            move |command| {
                let started = Arc::clone(&started);
                let release = Arc::clone(&release);
                let executed = Arc::clone(&executed);
                async move {
                    executed.fetch_add(1, Ordering::SeqCst);
                    started.notify_one();
                    release.notified().await;
                    match command {
                        ControlCommand::SetVolume(req) => Some(volume_state(req.volume)),
                        _ => None,
                    }
                }
            }
        }));

        dispatch_control_command(&cmd_tx, set_volume(5)).unwrap();
        started.notified().await;
        dispatch_control_command(&cmd_tx, set_volume(6)).unwrap();

        // Force-close while the first command is mid-flight.
        cancel.cancel();
        release.notify_waiters();

        let reply = tokio::time::timeout(Duration::from_secs(1), reply_rx.recv())
            .await
            .expect("in-flight command still replies")
            .expect("reply delivered");
        assert_eq!(json(&reply), json(&volume_state(5)));

        tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .expect("worker stops on cancellation")
            .expect("worker did not panic");
        assert_eq!(
            executed.load(Ordering::SeqCst),
            1,
            "cancellation must not start the queued command"
        );
    }

    #[tokio::test]
    async fn queued_commands_are_not_executed_after_the_connection_closes() {
        let (cmd_tx, cmd_rx) = mpsc::channel(4);
        let (reply_tx, reply_rx) = mpsc::channel(4);
        let executed = Arc::new(AtomicUsize::new(0));

        // Queue work, then lose the connection before the worker ever runs.
        dispatch_control_command(&cmd_tx, set_volume(1)).unwrap();
        dispatch_control_command(&cmd_tx, set_volume(2)).unwrap();
        drop(reply_rx);

        let worker = tokio::spawn(run_control_worker(
            CancellationToken::new(),
            cmd_rx,
            reply_tx,
            {
                let executed = Arc::clone(&executed);
                move |_| {
                    executed.fetch_add(1, Ordering::SeqCst);
                    async { Some(WsOutgoing::HeartbeatAck) }
                }
            },
        ));

        tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .expect("worker exits instead of draining the queue")
            .expect("worker did not panic");
        assert_eq!(executed.load(Ordering::SeqCst), 0);
    }

    #[tokio::test(start_paused = true)]
    async fn barrier_waits_for_queued_commands_before_teardown() {
        let (cmd_tx, cmd_rx) = mpsc::channel(4);
        let (reply_tx, mut reply_rx) = mpsc::channel(4);
        let finished = Arc::new(AtomicBool::new(false));
        let worker = tokio::spawn(run_control_worker(
            CancellationToken::new(),
            cmd_rx,
            reply_tx,
            {
                let finished = Arc::clone(&finished);
                move |command| {
                    let finished = Arc::clone(&finished);
                    async move {
                        // A slow speaker: well past the default jitter buffer.
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        finished.store(true, Ordering::SeqCst);
                        match command {
                            ControlCommand::SetVolume(req) => Some(volume_state(req.volume)),
                            _ => None,
                        }
                    }
                }
            },
        ));

        dispatch_control_command(&cmd_tx, set_volume(9)).unwrap();
        quiesce_control_worker(&cmd_tx).await;
        assert!(
            finished.load(Ordering::SeqCst),
            "barrier must not resolve before the queued command completes"
        );
        assert_eq!(
            json(&reply_rx.recv().await.expect("reply")),
            json(&volume_state(9))
        );

        drop(cmd_tx);
        worker.await.expect("worker exits");
    }

    #[tokio::test(start_paused = true)]
    async fn a_worker_that_overruns_the_grace_is_detached_not_cancelled() {
        let finished = Arc::new(AtomicBool::new(false));
        let worker = tokio::spawn({
            let finished = Arc::clone(&finished);
            async move {
                // A command that outlives the grace (e.g. a synchronized start
                // against several unresponsive speakers).
                tokio::time::sleep(CONTROL_WORKER_GRACE * 2).await;
                finished.store(true, Ordering::SeqCst);
            }
        });

        await_control_worker(worker).await;
        assert!(
            !finished.load(Ordering::SeqCst),
            "the wait must be bounded by CONTROL_WORKER_GRACE"
        );

        // Dropping the handle must not cancel the command: it still completes,
        // so whatever it started stays recorded for cleanup to find.
        tokio::time::sleep(CONTROL_WORKER_GRACE * 2).await;
        assert!(
            finished.load(Ordering::SeqCst),
            "an overrunning command must run to completion, never be aborted"
        );
    }

    #[test]
    fn control_worker_grace_covers_a_single_speaker_playback_command() {
        // A retried SOAP action: four attempts of SOAP_TIMEOUT_SECS with
        // 200 + 500 + 1000 ms of backoff in between.
        let retried_action =
            Duration::from_secs(4 * SOAP_TIMEOUT_SECS) + Duration::from_millis(1700);
        // leave_group/stop skip the retry wrapper: one request each.
        let best_effort_action = Duration::from_secs(SOAP_TIMEOUT_SECS);

        // Coordinator/standalone speaker: leave_group (slave promotion) and stop
        // (switching streams) can both precede play_uri (two retried actions).
        assert!(
            CONTROL_WORKER_GRACE >= best_effort_action * 2 + retried_action * 2,
            "grace {:?} must cover leave_group + stop + play_uri on a wedged speaker",
            CONTROL_WORKER_GRACE
        );
        // Slave phase of a group start (slaves run concurrently): a re-routed
        // slave does leave_group before join_group (two retried actions).
        assert!(
            CONTROL_WORKER_GRACE >= best_effort_action + retried_action * 2,
            "grace {:?} must cover leave_group + join_group on a wedged slave",
            CONTROL_WORKER_GRACE
        );
    }

    #[tokio::test(start_paused = true)]
    async fn a_clean_close_drains_queued_commands_instead_of_dropping_them() {
        let (cmd_tx, cmd_rx) = mpsc::channel(4);
        let (reply_tx, reply_rx) = mpsc::channel(4);
        let executed = Arc::new(AtomicUsize::new(0));

        // Commands the client sent just before the socket went away, e.g. a
        // STOP_PLAYBACK_SPEAKER that nothing will ever re-send.
        dispatch_control_command(&cmd_tx, set_volume(1)).unwrap();
        dispatch_control_command(&cmd_tx, set_volume(2)).unwrap();

        let worker = tokio::spawn(run_control_worker(
            CancellationToken::new(),
            cmd_rx,
            reply_tx,
            {
                let executed = Arc::clone(&executed);
                move |command| {
                    let executed = Arc::clone(&executed);
                    async move {
                        // A slow speaker must not be skipped either.
                        tokio::time::sleep(Duration::from_secs(3)).await;
                        executed.fetch_add(1, Ordering::SeqCst);
                        match command {
                            ControlCommand::SetVolume(req) => Some(volume_state(req.volume)),
                            _ => None,
                        }
                    }
                }
            },
        ));

        drop(cmd_tx);
        drain_control_worker(reply_rx).await;

        assert_eq!(
            executed.load(Ordering::SeqCst),
            2,
            "a clean close must run the queue out instead of discarding it"
        );
        worker.await.expect("worker exits once its queue is empty");
    }

    #[tokio::test(start_paused = true)]
    async fn draining_reads_replies_so_a_full_reply_channel_cannot_park_the_worker() {
        let (cmd_tx, cmd_rx) = mpsc::channel(4);
        // Fewer reply slots than queued commands: the worker parks on
        // `reply_tx.send` unless the drain keeps reading.
        let (reply_tx, reply_rx) = mpsc::channel(1);
        let executed = Arc::new(AtomicUsize::new(0));

        for volume in 1..=3 {
            dispatch_control_command(&cmd_tx, set_volume(volume)).unwrap();
        }

        let worker = tokio::spawn(run_control_worker(
            CancellationToken::new(),
            cmd_rx,
            reply_tx,
            {
                let executed = Arc::clone(&executed);
                move |command| {
                    let executed = Arc::clone(&executed);
                    async move {
                        executed.fetch_add(1, Ordering::SeqCst);
                        match command {
                            ControlCommand::SetVolume(req) => Some(volume_state(req.volume)),
                            _ => None,
                        }
                    }
                }
            },
        ));

        drop(cmd_tx);
        drain_control_worker(reply_rx).await;

        assert_eq!(executed.load(Ordering::SeqCst), 3);
        worker
            .await
            .expect("worker is never wedged by unread replies");
    }

    #[tokio::test(start_paused = true)]
    async fn barrier_waits_for_a_slot_when_the_command_queue_is_full() {
        let (cmd_tx, cmd_rx) = mpsc::channel(1);
        let (reply_tx, mut reply_rx) = mpsc::channel(4);
        let executed = Arc::new(AtomicUsize::new(0));

        // Fill the queue before the worker exists, so the barrier cannot be
        // queued without waiting for a slot.
        dispatch_control_command(&cmd_tx, set_volume(4)).unwrap();
        assert_error_contains(
            &dispatch_control_command(&cmd_tx, set_volume(5)).unwrap_err(),
            "Too many pending control commands",
        );

        let worker = tokio::spawn(run_control_worker(
            CancellationToken::new(),
            cmd_rx,
            reply_tx,
            {
                let executed = Arc::clone(&executed);
                move |command| {
                    let executed = Arc::clone(&executed);
                    async move {
                        tokio::time::sleep(Duration::from_secs(5)).await;
                        executed.fetch_add(1, Ordering::SeqCst);
                        match command {
                            ControlCommand::SetVolume(req) => Some(volume_state(req.volume)),
                            _ => None,
                        }
                    }
                }
            },
        ));

        quiesce_control_worker(&cmd_tx).await;
        assert_eq!(
            executed.load(Ordering::SeqCst),
            1,
            "a full queue must delay teardown, not wave it through unordered"
        );
        assert_eq!(
            json(&reply_rx.recv().await.expect("reply")),
            json(&volume_state(4))
        );

        drop(cmd_tx);
        worker.await.expect("worker exits");
    }

    #[tokio::test(start_paused = true)]
    async fn barrier_gives_up_immediately_when_the_worker_is_gone() {
        let (cmd_tx, cmd_rx) = mpsc::channel::<ControlCommand>(1);
        drop(cmd_rx);

        // Nothing is left to order against, so this must not burn the grace.
        tokio::time::timeout(CONTROL_WORKER_GRACE, quiesce_control_worker(&cmd_tx))
            .await
            .expect("barrier returns as soon as the worker is gone");
    }

    #[test]
    fn dispatch_reports_full_queue_and_missing_worker() {
        let (cmd_tx, cmd_rx) = mpsc::channel(1);
        dispatch_control_command(&cmd_tx, set_volume(1)).expect("first command is queued");

        let err = dispatch_control_command(&cmd_tx, set_volume(2)).unwrap_err();
        assert_error_contains(&err, "Too many pending control commands");

        drop(cmd_rx);
        let err = dispatch_control_command(&cmd_tx, set_volume(3)).unwrap_err();
        assert_error_contains(&err, "not available");
    }

    #[test]
    fn failed_commands_still_reply_with_error() {
        let ok: Result<u8, String> = Ok(7);
        assert_eq!(
            json(&reply_from_result(ok, volume_state)),
            json(&volume_state(7))
        );

        let failed: Result<u8, String> = Err("speaker unreachable".into());
        assert_error_contains(
            &reply_from_result(failed, volume_state),
            "speaker unreachable",
        );
    }
}
