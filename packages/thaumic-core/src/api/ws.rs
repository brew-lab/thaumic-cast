//! WebSocket handler for real-time client communication.

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{connect_info::ConnectInfo, State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use futures::sink::SinkExt;
use futures::stream::{SplitSink, StreamExt};
use serde::{Deserialize, Serialize};
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_util::sync::CancellationToken;

use crate::api::ws_connection::{is_loopback_ip, ConnectionGuard, WsConnectionManager};
use crate::api::AppState;
use crate::events::{BroadcastEvent, LatencyEvent, SonosEvent, SpeakerRemovalReason, StreamEvent};
use crate::protocol_constants::{
    DEFAULT_JITTER_BUFFER_MS, MAX_FRAME_DURATION_MS, MAX_JITTER_BUFFER_MS, MIN_FRAME_DURATION_MS,
    MIN_JITTER_BUFFER_MS, SILENCE_FRAME_DURATION_MS, SOAP_TIMEOUT_SECS,
    WS_HEARTBEAT_CHECK_INTERVAL_SECS, WS_HEARTBEAT_TIMEOUT_SECS,
};
use crate::services::{PlaybackSession, StreamCoordinator};
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
    /// Holds the ownership record claimed for this stream, so it is released
    /// whenever the stream goes away — not only when the connection ends.
    ws_manager: Arc<WsConnectionManager>,
    /// Cleared by `disarm()` once the stream has been removed gracefully.
    armed: bool,
}

impl StreamGuard {
    /// Creates the guard and records `conn` as the owner of `stream_id`.
    ///
    /// Ownership is what `INITIAL_STATE` uses to decide whose sessions a
    /// client may see in full (see [`build_initial_state`]).
    fn new(state: &AppState, conn: &ConnectionGuard, stream_id: String) -> Self {
        conn.claim_stream(&stream_id);
        Self {
            stream_id,
            stream_coordinator: Arc::clone(&state.stream_coordinator),
            ws_manager: conn.manager(),
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
        // Removal first, release second: removal broadcasts `Ended`, and while
        // the ownership record still stands that event reaches the owner with
        // the real id and everyone else with the alias they know the stream by
        // (see `redact_foreign_streams`). Released even when disarmed: the
        // stream is gone either way, so the record must not outlive it.
        if self.armed {
            self.stream_coordinator.remove_stream(&self.stream_id);
            log::info!("[WS] Stream cleanup: {}", self.stream_id);
        }
        self.ws_manager.release_stream(&self.stream_id);
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
/// capacity, and both the teardown drain ([`drain_control_worker`]) and the
/// inline barrier ([`quiesce_control_worker`]) keep reading them, so the worker
/// can never park on `reply_tx.send` while it finishes its queue.
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
///
/// Replies keep flowing while this waits. The worker parks on `reply_tx.send`
/// once the reply channel is full, and the `select!` arm that normally drains
/// it is the one parked here — so without forwarding replies in this loop a
/// worker with more than a channel's worth of replies queued could never reach
/// the barrier, and the ingest loop would sit out the whole grace period.
async fn quiesce_control_worker<S>(
    cmd_tx: &mpsc::Sender<ControlCommand>,
    reply_rx: &mut mpsc::Receiver<WsOutgoing>,
    sender: &mut S,
) where
    S: futures::Sink<Message> + Unpin,
{
    let (ack_tx, mut ack_rx) = oneshot::channel();
    let barrier = async {
        match cmd_tx.try_send(ControlCommand::Barrier(ack_tx)) {
            Ok(()) => {}
            // The worker is gone, so there is nothing left to order against.
            Err(mpsc::error::TrySendError::Closed(_)) => return,
            Err(mpsc::error::TrySendError::Full(command)) => {
                // A full queue is exactly when ordering matters most, so wait for
                // a slot instead of tearing down unordered. Awaiting here is no
                // worse than the barrier wait itself, and the whole thing is
                // bounded by the timeout below. Replies are forwarded meanwhile
                // for the same reason as below: the worker cannot free a slot
                // while it is parked on a full reply channel.
                let mut pending = Some(command);
                loop {
                    let command = pending.take().expect("command is pending");
                    tokio::select! {
                        sent = cmd_tx.send(command) => {
                            if sent.is_err() {
                                return;
                            }
                            break;
                        }
                        Some(reply) = reply_rx.recv() => {
                            // `send` took the command by value; it is only lost
                            // if the future completed, which is the arm above.
                            if let Some(msg) = reply.to_message() {
                                let _ = sender.send(msg).await;
                            }
                        }
                    }
                }
            }
        }
        loop {
            tokio::select! {
                _ = &mut ack_rx => break,
                Some(reply) = reply_rx.recv() => {
                    if let Some(msg) = reply.to_message() {
                        let _ = sender.send(msg).await;
                    }
                }
            }
        }
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

/// Returns a stable, opaque stand-in for a stream id.
///
/// Derived from a per-process random salt, so it is stable for the life of the
/// companion (a client can correlate the same speaker across snapshots) while
/// revealing nothing about the real id: `/stream/{id}` rejects it, and it
/// cannot be worked back to the UUID without the salt, which never leaves the
/// process.
fn opaque_stream_alias(stream_id: &str) -> String {
    use std::hash::{Hash, Hasher};

    static SALT: OnceLock<u128> = OnceLock::new();
    let salt = *SALT.get_or_init(|| uuid::Uuid::new_v4().as_u128());

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    salt.hash(&mut hasher);
    stream_id.hash(&mut hasher);
    format!("redacted-{:016x}", hasher.finish())
}

/// Builds the `sessions` entry another client is allowed to see.
///
/// Carries the speaker (so the UI can show it as in use by someone else) and
/// nothing that could be replayed against the audio endpoints: no stream id and
/// no stream URL. `/stream/{id}/live.wav` serves anyone who knows the id, so
/// handing out other clients' ids here is handing out their tab audio.
///
/// The shape still satisfies the extension's `PlaybackSessionSchema`
/// (`streamId`, `speakerIp`, `streamUrl`, all required strings), so the
/// placeholder id and empty URL are deliberate: omitting the fields would make
/// the whole `INITIAL_STATE` payload fail validation on shipped extensions.
fn redacted_session(session: &PlaybackSession) -> serde_json::Value {
    serde_json::json!({
        "streamId": opaque_stream_alias(&session.stream_id),
        "speakerIp": session.speaker_ip,
        "streamUrl": "",
        "redacted": true,
    })
}

/// Serializes one playback session for `conn`.
///
/// Sessions this client created — any socket from the same machine, so the
/// extension's control socket sees what its streaming socket started — are sent
/// in full; everyone else's are reduced to [`redacted_session`].
fn session_for_connection(conn: &ConnectionGuard, session: &PlaybackSession) -> serde_json::Value {
    if conn.owns_stream(&session.stream_id) {
        match serde_json::to_value(session) {
            Ok(value) => return value,
            Err(e) => log::warn!("[WS] Failed to serialize session: {}", e),
        }
    }
    redacted_session(session)
}

/// Returns `true` if `event` may be forwarded to `conn`.
///
/// `/stream/{id}/live.wav` serves whoever knows the id, so every event that
/// names a stream id is a disclosure: without this, staying connected while
/// somebody else casts would undo [`build_initial_state`]'s redaction one event
/// later. Each arm is therefore listed explicitly and the match is exhaustive,
/// so a new event variant carrying a stream id cannot silently inherit a
/// permissive default.
///
/// `Created` goes to the owner and nobody else. It is broadcast from inside
/// stream creation, a moment *before* the creating socket records its claim,
/// so a sibling socket could see it while the stream still looks unowned — it
/// must fail closed rather than ask about liveness. Nothing consumes it today,
/// so a non-owner loses nothing.
///
/// `PlaybackStarted`, `PlaybackStopped` and `Ended` go to everyone, because
/// they are how a client keeps its picture of *which speakers other clients
/// hold* current between snapshots — without them "in use by another client"
/// would only ever be true at connect time. They are not a disclosure: on the
/// way out [`redact_foreign_streams`] replaces another client's stream id with
/// the same opaque alias `INITIAL_STATE` used for it, and blanks the URL.
///
/// `PlaybackStopFailed` and the two latency events are gated on the id still
/// being *live and someone else's*. Non-owners have no use for them (the
/// extension resolves them through its own session table and returns early for
/// ids that are not its own), and the latency pair repeats for the whole cast.
/// Once the ownership record is released the stream is gone and its id buys
/// nothing, so they go to everyone, which keeps an owner's own cleanup working
/// on the paths where release precedes the event.
fn event_is_visible_to(conn: &ConnectionGuard, event: &BroadcastEvent) -> bool {
    match event {
        BroadcastEvent::Stream(StreamEvent::Created { stream_id, .. }) => {
            conn.owns_stream(stream_id)
        }
        BroadcastEvent::Stream(
            StreamEvent::PlaybackStarted { .. }
            | StreamEvent::PlaybackStopped { .. }
            | StreamEvent::Ended { .. },
        ) => true,
        BroadcastEvent::Stream(StreamEvent::PlaybackStopFailed { stream_id, .. })
        | BroadcastEvent::Latency(
            LatencyEvent::Updated { stream_id, .. } | LatencyEvent::Stale { stream_id, .. },
        ) => !conn.stream_is_owned_by_other(stream_id),
        // Speaker, network and topology state is shared by everyone casting to
        // the same Sonos system. Sonos events name no stream id, but two of
        // them quote a URI that may *contain* one - see
        // [`redact_foreign_streams`], which runs on the way out.
        BroadcastEvent::Sonos(_) | BroadcastEvent::Network(_) | BroadcastEvent::Topology(_) => true,
    }
}

/// Placeholder left in a URI field whose value was another client's stream.
///
/// A string rather than an omission because `SourceChangedSchema` requires
/// `currentUri`; it also reads as deliberate in the extension's log line.
const REDACTED_URI: &str = "<redacted>";

/// Returns the stream id named by a companion stream URL, if it names one.
///
/// Stream URLs look like `http://<host>:<port>/stream/{id}/live.wav`, and Sonos
/// quotes them back verbatim in its GENA notifications. Any other URI (a radio
/// stream, a Spotify track, `x-rincon:` group membership) has no `/stream/`
/// segment and yields `None`.
fn stream_id_in_uri(uri: &str) -> Option<&str> {
    let after = uri.split("/stream/").nth(1)?;
    let id = after.split('/').next().unwrap_or(after);
    (!id.is_empty()).then_some(id)
}

/// Rewrites every reference to another client's live stream out of `event`.
///
/// Two kinds of reference exist. `StreamEvent::PlaybackStarted`,
/// `PlaybackStopped` and `Ended` name a stream id outright: for a stream
/// someone else owns the id becomes the [`opaque_stream_alias`] that
/// `INITIAL_STATE` already showed this client, so it can keep its list of
/// other clients' sessions current by the same key, and the URL on
/// `PlaybackStarted` is blanked because it embeds the id.
///
/// `SonosEvent::TransportState` and `SonosEvent::SourceChanged` carry the
/// speaker's `CurrentTrackURI` straight from the GENA notification, which for a
/// speaker someone else is casting to *is* that client's
/// `/stream/{id}/live.wav` URL. Forwarding it verbatim would hand out a
/// ready-made fetch URL for another client's tab audio the first time the
/// victim pauses or the track changes, bypassing every other check here. The
/// events themselves must still reach every client — the extension drops a
/// speaker from its own cast on `sourceChanged`, and both handlers act on
/// `speakerIp` alone — so the URI field is rewritten to [`REDACTED_URI`]
/// rather than the event withheld. No consumer reads these fields beyond one
/// log line.
fn redact_foreign_streams(conn: &ConnectionGuard, event: &mut BroadcastEvent) {
    let foreign =
        |uri: &str| stream_id_in_uri(uri).is_some_and(|id| conn.stream_is_owned_by_other(id));

    match event {
        BroadcastEvent::Stream(StreamEvent::PlaybackStarted {
            stream_id,
            stream_url,
            ..
        }) => {
            if conn.stream_is_owned_by_other(stream_id) {
                *stream_id = opaque_stream_alias(stream_id);
                stream_url.clear();
            }
        }
        BroadcastEvent::Stream(
            StreamEvent::PlaybackStopped { stream_id, .. } | StreamEvent::Ended { stream_id, .. },
        ) => {
            if conn.stream_is_owned_by_other(stream_id) {
                *stream_id = opaque_stream_alias(stream_id);
            }
        }
        BroadcastEvent::Sonos(SonosEvent::TransportState { current_uri, .. }) => {
            if current_uri.as_deref().is_some_and(foreign) {
                *current_uri = Some(REDACTED_URI.to_string());
            }
        }
        BroadcastEvent::Sonos(SonosEvent::SourceChanged {
            current_uri,
            expected_uri,
            ..
        }) => {
            if foreign(current_uri) {
                REDACTED_URI.clone_into(current_uri);
            }
            if expected_uri.as_deref().is_some_and(foreign) {
                *expected_uri = Some(REDACTED_URI.to_string());
            }
        }
        // Listed rather than wildcarded, so a new event that names a stream or
        // quotes a URI has to be classified here instead of shipping
        // unscrubbed. The remaining stream and latency events name streams
        // too, but [`event_is_visible_to`] withholds them from non-owners
        // while the stream is live.
        BroadcastEvent::Sonos(
            SonosEvent::GroupVolume { .. }
            | SonosEvent::GroupMute { .. }
            | SonosEvent::ZoneGroupsUpdated { .. }
            | SonosEvent::SubscriptionLost { .. },
        )
        | BroadcastEvent::Stream(
            StreamEvent::Created { .. } | StreamEvent::PlaybackStopFailed { .. },
        )
        | BroadcastEvent::Network(_)
        | BroadcastEvent::Topology(_)
        | BroadcastEvent::Latency(_) => {}
    }
}

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
///
/// One companion serves several extensions at once, so sessions are filtered
/// per connection: `conn`'s own sessions in full, everyone else's redacted.
fn build_initial_state(state: &AppState, conn: &ConnectionGuard) -> Option<Message> {
    let mut payload = state.sonos_state.to_json();

    // Add sessions to the initial state
    if let serde_json::Value::Object(ref mut map) = payload {
        let sessions_json = serde_json::Value::Array(
            state
                .stream_coordinator
                .get_all_sessions()
                .iter()
                .map(|session| session_for_connection(conn, session))
                .collect(),
        );
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

/// Sends `conn`'s `INITIAL_STATE` snapshot down `sender`.
///
/// Used both on connect and to resynchronise a connection whose broadcast
/// receiver lagged, so the redaction in [`build_initial_state`] applies to
/// both and a resync can never hand this client another client's stream ids.
///
/// Returns `false` when the socket is gone and the connection should end. A
/// snapshot that fails to serialize is skipped, not fatal.
async fn send_initial_state(
    sender: &mut SplitSink<WebSocket, Message>,
    state: &AppState,
    conn: &ConnectionGuard,
) -> bool {
    match build_initial_state(state, conn) {
        Some(msg) => sender.send(msg).await.is_ok(),
        None => true,
    }
}

/// Logs a lagged connection and re-sends its `INITIAL_STATE` snapshot.
///
/// Returns `false` when the socket is gone and the connection should end.
async fn resync_after_lag(
    sender: &mut SplitSink<WebSocket, Message>,
    state: &AppState,
    conn: &ConnectionGuard,
    skipped: u64,
) -> bool {
    log::warn!(
        "[WS] Connection {} lagged, {} event(s) dropped; resending INITIAL_STATE",
        conn.id(),
        skipped
    );
    send_initial_state(sender, state, conn).await
}

/// Shortest gap between two lag-triggered `INITIAL_STATE` resyncs on one
/// connection.
const RESYNC_MIN_INTERVAL: Duration = Duration::from_secs(2);

/// Per-connection bookkeeping for recovering from a lagged event receiver.
///
/// The event channel holds `EVENT_CHANNEL_CAPACITY` events; a client that
/// stalls on TCP backpressure overruns it and tokio drops what it missed.
/// Those events are gone, so the only honest recovery is to re-send the
/// `INITIAL_STATE` snapshot. Rebuilding that snapshot is the expensive part,
/// though, and a continuously slow client would earn one per lagged `recv()`,
/// so lags are coalesced into at most one resync per [`RESYNC_MIN_INTERVAL`]:
/// a suppressed lag is remembered and released by the heartbeat tick, which
/// keeps the client eventually consistent without a rebuild loop.
#[derive(Default)]
struct LagResync {
    /// Events dropped since the last snapshot went out.
    skipped: u64,
    /// A lag arrived while a resync was still rate-limited.
    deferred: bool,
    /// When the last snapshot went out; `None` until the first lag.
    last_sent: Option<Instant>,
}

impl LagResync {
    /// Records `skipped` dropped events, returning the coalesced skip count
    /// when a snapshot should be sent now. `None` means the lag was deferred;
    /// [`Self::take_due`] releases it once the interval has passed.
    fn on_lag(&mut self, skipped: u64, now: Instant) -> Option<u64> {
        self.skipped = self.skipped.saturating_add(skipped);
        if self.is_due(now) {
            Some(self.take(now))
        } else {
            self.deferred = true;
            None
        }
    }

    /// Returns the coalesced skip count once a deferred resync comes due.
    fn take_due(&mut self, now: Instant) -> Option<u64> {
        if self.deferred && self.is_due(now) {
            Some(self.take(now))
        } else {
            None
        }
    }

    fn is_due(&self, now: Instant) -> bool {
        match self.last_sent {
            Some(sent) => now.duration_since(sent) >= RESYNC_MIN_INTERVAL,
            None => true,
        }
    }

    fn take(&mut self, now: Instant) -> u64 {
        self.deferred = false;
        self.last_sent = Some(now);
        std::mem::take(&mut self.skipped)
    }
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

/// Returns `true` if `peer` is the machine this companion runs on.
///
/// `local_ip` is the companion's own advertised address. Loopback is the
/// obvious case but not the only one: the companion binds `0.0.0.0` and the
/// desktop Server view prints `<local ip>:<port>` with a copy button, so a user
/// on that very machine may well have pasted the LAN address into the
/// extension. Treating that as remote would refuse browser capture to exactly
/// the desktop+Windows setup the feature exists for.
pub(super) fn is_companion_host(local_ip: &str, peer: IpAddr) -> bool {
    let peer = peer.to_canonical();
    is_loopback_ip(peer)
        || local_ip
            .parse::<IpAddr>()
            .is_ok_and(|local| local.to_canonical() == peer)
}

/// Handles a START_BROWSER_CAPTURE message: starts capture and creates a stream.
///
/// Uses the `CaptureSourceFactory` from `AppState` to create a platform-specific
/// capture source. The capture thread pushes Float32 audio through the
/// `StreamSinkBridge`, which converts to PCM16 and calls `push_frame()`.
/// When the first frame arrives, `ready_notify` fires and we send `STREAM_READY`.
///
/// Restricted to clients on the companion's own machine (see
/// [`is_companion_host`]): the factory records the *companion host's* audio
/// output, so a client elsewhere asking for it would be recording someone
/// else's machine, not its own browser.
async fn handle_start_browser_capture(
    state: &AppState,
    conn: &ConnectionGuard,
    sender: &mut futures::stream::SplitSink<WebSocket, Message>,
    stream_guard: &mut Option<StreamGuard>,
    capture: &mut BrowserCaptureState,
    payload: StartBrowserCaptureRequest,
) {
    // Only a client running on this machine may capture this machine's audio.
    if !is_companion_host(&state.network.get_local_ip(), conn.remote_addr().ip()) {
        log::warn!(
            "[WS] Rejected START_BROWSER_CAPTURE from non-local client {} ({})",
            conn.remote_addr(),
            conn.id()
        );
        let msg = WsOutgoing::Error {
            message: "Browser capture is only available to clients on the companion's machine"
                .into(),
        };
        if let Some(msg) = msg.to_message() {
            let _ = sender.send(msg).await;
        }
        return;
    }

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
            let guard = StreamGuard::new(state, conn, stream_id.clone());

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

    // Every speaker is monitored so its cushion and trend reach the log; the
    // measurements are only sent to the client when it asked for them (video
    // sync), which also selects the faster poll rate.
    for result in &results {
        if result.success {
            state
                .latency_monitor
                .start_monitoring(&stream_id, &result.speaker_ip, latency_monitoring)
                .await;
        }
    }

    // Reply with PLAYBACK_RESULTS carrying per-speaker outcomes
    WsOutgoing::PlaybackResults {
        payload: PlaybackResultsPayload { results },
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Upgrade Admission
// ─────────────────────────────────────────────────────────────────────────────

/// Origin schemes a browser gives an extension page, service worker or
/// offscreen document.
///
/// Chromium (Chrome, Edge, Brave, Opera) uses `chrome-extension`, Firefox
/// `moz-extension`, Safari `safari-web-extension`. Any id is accepted on
/// purpose: `apps/extension/manifest.json` carries no `key`, so every unpacked
/// developer build has a different id and pinning one would lock those users
/// out. Allowing the schemes still rejects every `http(s)://` page, which is
/// the attack this closes.
const EXTENSION_ORIGIN_SCHEMES: [&str; 3] =
    ["chrome-extension", "moz-extension", "safari-web-extension"];

/// Longest client id accepted from the query string.
const MAX_CLIENT_ID_LEN: usize = 64;

/// Decides whether a WebSocket upgrade may proceed.
///
/// WebSockets are exempt from the same-origin policy, so without this any page
/// the user visits could open `ws://127.0.0.1:<port>/ws` and drive their
/// speakers. The only legitimate client of `/ws` is the browser extension (the
/// desktop UI uses Tauri commands, Sonos uses the HTTP stream endpoints), so an
/// extension origin is required.
///
/// A missing `Origin` means a non-browser client (curl, native tooling, tests).
/// That is accepted only from loopback: a blanket bypass would hand the whole
/// endpoint to anything on the LAN, which is what the check exists to stop.
/// Extensions are unaffected by that rule even in the headless deployment,
/// where the extension reaches the companion across the LAN — the browser still
/// sends its `chrome-extension://…` origin on the upgrade.
///
/// This is worth exactly what the browser's word is worth: it stops web pages,
/// which cannot forge `Origin`. A native client can set any header it likes, so
/// this is not authentication — that needs the shared-secret work planned
/// separately.
fn check_upgrade_origin(origin: Option<&str>, peer: IpAddr) -> Result<(), &'static str> {
    match origin {
        Some(origin) => {
            let scheme = origin.split("://").next().unwrap_or_default();
            if EXTENSION_ORIGIN_SCHEMES
                .iter()
                .any(|allowed| scheme.eq_ignore_ascii_case(allowed))
            {
                Ok(())
            } else {
                Err("origin is not a browser extension")
            }
        }
        None if is_loopback_ip(peer) => Ok(()),
        None => Err("no Origin header and the peer is not loopback"),
    }
}

/// Trims an untrusted string to something safe to put in a log line.
///
/// Keeps printable ASCII only (no newlines to forge log records with) and caps
/// the length.
fn sanitize_label(value: &str, max_len: usize) -> String {
    value
        .chars()
        .filter(|c| c.is_ascii_graphic())
        .take(max_len)
        .collect()
}

/// Reads the optional `clientId` query parameter of the upgrade request.
///
/// A browser cannot set request headers on a WebSocket handshake, so the query
/// string is the only channel a client id can arrive on.
///
/// The value is a label, never a credential and never an ownership key: nothing
/// verifies it, so any client can present any value. It exists so a human
/// reading the logs of a companion serving several browsers can tell them
/// apart and follow one across its reconnects. Stream ownership is keyed on the
/// peer address instead — see [`crate::api::ws_connection::ConnectionState::owner_ip`].
fn client_id_from_query(query: Option<&str>) -> Option<String> {
    let raw = query?.split('&').find_map(|pair| {
        let (key, value) = pair.split_once('=')?;
        (key == "clientId").then_some(value)
    })?;
    let sanitized = sanitize_label(raw, MAX_CLIENT_ID_LEN);
    (!sanitized.is_empty()).then_some(sanitized)
}

/// WebSocket upgrade handler.
///
/// Admits the upgrade (see [`check_upgrade_origin`]) before handing the socket
/// to [`handle_ws`], and logs the observed `Origin` on every accepted upgrade
/// so the real extension id can be read out of the logs later.
pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    uri: Uri,
    headers: HeaderMap,
) -> Response {
    // A present-but-unreadable Origin is a present Origin: it must fail the
    // check below, not fall through to the "no Origin" rule.
    let origin = headers
        .get(header::ORIGIN)
        .map(|value| value.to_str().unwrap_or("<invalid>"));

    if let Err(reason) = check_upgrade_origin(origin, remote_addr.ip()) {
        log::warn!(
            "[WS] Rejected upgrade from {}: {} (origin: {})",
            remote_addr,
            reason,
            origin.map_or_else(|| "<none>".to_string(), |o| sanitize_label(o, 128))
        );
        return (
            StatusCode::FORBIDDEN,
            "WebSocket upgrades are limited to the browser extension",
        )
            .into_response();
    }

    let client_id = client_id_from_query(uri.query());
    log::info!(
        "[WS] Accepted upgrade from {} (origin: {}, clientId: {})",
        remote_addr,
        origin.map_or_else(|| "<none>".to_string(), |o| sanitize_label(o, 128)),
        client_id.as_deref().unwrap_or("<none>")
    );

    ws.on_upgrade(move |socket| handle_ws(socket, state, remote_addr, client_id))
}

/// Main WebSocket connection handler.
async fn handle_ws(
    socket: WebSocket,
    state: AppState,
    remote_addr: SocketAddr,
    client_id: Option<String>,
) {
    let (mut sender, mut receiver) = socket.split();
    let mut stream_guard: Option<StreamGuard> = None;
    let mut capture = BrowserCaptureState::new();
    let mut broadcast_rx = state.event_bridge.subscribe();
    let mut last_activity = Instant::now();
    let mut latency_monitoring = false;
    let mut lag_resync = LagResync::default();

    // Register connection for tracking, identity and force-close capability
    let conn_guard = state.ws_manager.register(remote_addr, client_id);
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
    if !send_initial_state(&mut sender, &state, &conn_guard).await {
        log::warn!("[WS] Failed to send initial state, client disconnected");
        return;
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
                                            quiesce_control_worker(&cmd_tx, &mut reply_rx, &mut sender).await;
                                            last_activity = Instant::now();
                                        }
                                        // Create guard immediately - cleanup happens on drop
                                        let guard =
                                            StreamGuard::new(&state, &conn_guard, id.clone());
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
                                // A duplicate request is rejected by the handler
                                // without touching the stream, so it skips the wait.
                                if stream_guard.is_some() && capture.session.is_none() {
                                    quiesce_control_worker(&cmd_tx, &mut reply_rx, &mut sender).await;
                                    last_activity = Instant::now();
                                }
                                handle_start_browser_capture(
                                    &state,
                                    &conn_guard,
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
                                    quiesce_control_worker(&cmd_tx, &mut reply_rx, &mut sender).await;
                                    last_activity = Instant::now();
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
            received = broadcast_rx.recv() => {
                match received {
                    Ok(mut event) => {
                        // Each connection owns its copy of the event, so filtering and
                        // redaction here are per-client and cannot affect anyone else.
                        if event_is_visible_to(&conn_guard, &event) {
                            redact_foreign_streams(&conn_guard, &mut event);
                            if let Ok(json) = serde_json::to_string(&event) {
                                if sender.send(Message::Text(json.into())).await.is_err() {
                                    break;
                                }
                            }
                        }
                    }
                    // This client fell behind and tokio dropped the events it
                    // missed. Swallowing that would leave its speaker list,
                    // group volumes and session view permanently wrong until it
                    // reconnected, so re-send the snapshot instead.
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        // A streaming socket discards INITIAL_STATE and every
                        // broadcast (the offscreen worker only reads replies), and
                        // it is the one most likely to be behind on TCP, so a
                        // snapshot there is bytes added to the backlog for nothing.
                        // The extension's control socket is the one that keeps
                        // state, and it gets the resync.
                        if stream_guard.is_some() {
                            continue;
                        }
                        if let Some(total) = lag_resync.on_lag(skipped, Instant::now()) {
                            if !resync_after_lag(&mut sender, &state, &conn_guard, total).await {
                                break;
                            }
                        }
                    }
                    // The bridge is gone (shutdown): no more events will ever
                    // arrive, so this connection has nothing left to serve.
                    Err(broadcast::error::RecvError::Closed) => {
                        log::info!(
                            "[WS] Event channel closed, ending connection {}",
                            conn_guard.id()
                        );
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
                // Release a resync that was rate-limited while the client was
                // lagging, so a continuously slow client still converges.
                if let Some(total) = lag_resync.take_due(Instant::now()) {
                    if !resync_after_lag(&mut sender, &state, &conn_guard, total).await {
                        break;
                    }
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
    use crate::services::GroupRole;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};

    fn json(msg: &WsOutgoing) -> String {
        serde_json::to_string(msg).expect("serializable")
    }

    fn addr(value: &str) -> SocketAddr {
        value.parse().expect("valid socket address")
    }

    fn ip(value: &str) -> IpAddr {
        value.parse().expect("valid IP address")
    }

    fn session(stream_id: &str, speaker_ip: &str) -> PlaybackSession {
        PlaybackSession {
            stream_id: stream_id.to_string(),
            speaker_ip: speaker_ip.to_string(),
            stream_url: format!("http://192.168.1.2:49400/stream/{stream_id}/live.wav"),
            codec: AudioCodec::Pcm,
            role: GroupRole::Coordinator,
            coordinator_ip: None,
            coordinator_uuid: None,
            original_coordinator_uuid: None,
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Upgrade admission
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn extension_origins_are_accepted_from_any_peer() {
        // The headless deployment has the extension connecting across the LAN;
        // the browser still stamps the extension origin on the upgrade.
        for origin in [
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
            "moz-extension://9f0c1b7e-0000-4000-8000-000000000000",
            "safari-web-extension://ABCDEF01-2345-6789-ABCD-EF0123456789",
            "Chrome-Extension://abcdefghijklmnopabcdefghijklmnop",
        ] {
            assert!(
                check_upgrade_origin(Some(origin), ip("192.168.1.50")).is_ok(),
                "{origin} must be allowed"
            );
        }
    }

    #[test]
    fn web_page_origins_are_rejected_even_from_loopback() {
        // This is the whole attack: a page the user visits opening
        // ws://127.0.0.1:<port>/ws and driving their speakers.
        for origin in [
            "https://evil.example",
            "http://localhost:3000",
            "file://",
            "null",
            "",
        ] {
            assert!(
                check_upgrade_origin(Some(origin), ip("127.0.0.1")).is_err(),
                "{origin} must be rejected"
            );
        }
    }

    #[test]
    fn a_missing_origin_is_accepted_only_from_loopback() {
        // Non-browser clients (curl, native tooling, tests) send no Origin.
        assert!(check_upgrade_origin(None, ip("127.0.0.1")).is_ok());
        assert!(check_upgrade_origin(None, ip("::1")).is_ok());
        assert!(check_upgrade_origin(None, ip("::ffff:127.0.0.1")).is_ok());
        // ...but a missing Origin must never be a bypass from the network.
        assert!(check_upgrade_origin(None, ip("192.168.1.50")).is_err());
        assert!(check_upgrade_origin(None, ip("fe80::1")).is_err());
    }

    #[test]
    fn client_id_is_read_from_the_query_string_and_sanitized() {
        assert_eq!(
            client_id_from_query(Some("clientId=ext-abc123")),
            Some("ext-abc123".to_string())
        );
        assert_eq!(
            client_id_from_query(Some("other=1&clientId=ext-abc&x=2")),
            Some("ext-abc".to_string())
        );
        assert_eq!(client_id_from_query(None), None);
        assert_eq!(client_id_from_query(Some("clientid=ext-abc")), None);
        assert_eq!(client_id_from_query(Some("clientId=")), None);

        // Log-injection and unbounded values are trimmed away.
        assert_eq!(
            client_id_from_query(Some("clientId=ext\n[WS] forged line")),
            Some("ext[WS]forgedline".to_string())
        );
        assert_eq!(
            client_id_from_query(Some(&format!("clientId={}", "a".repeat(200))))
                .expect("id")
                .len(),
            MAX_CLIENT_ID_LEN
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // INITIAL_STATE session disclosure
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn another_clients_session_never_carries_its_stream_id_or_url() {
        let manager = Arc::new(WsConnectionManager::new());
        let owner = manager.register(addr("192.168.1.9:5001"), None);
        let stranger = manager.register(addr("192.168.1.20:5002"), None);

        let live = session("11111111-2222-4333-8444-555555555555", "192.168.1.31");
        owner.claim_stream(&live.stream_id);

        let seen = session_for_connection(&stranger, &live);
        let text = seen.to_string();
        assert!(
            !text.contains(&live.stream_id),
            "redacted session leaked the stream id: {text}"
        );
        assert!(
            !text.contains("live.wav"),
            "redacted session leaked the stream URL: {text}"
        );

        // Still enough to render "this speaker is in use by another client",
        // and still parseable by the extension's PlaybackSessionSchema.
        assert_eq!(seen["speakerIp"], "192.168.1.31");
        assert_eq!(seen["redacted"], true);
        assert!(seen["streamId"].as_str().is_some_and(|id| !id.is_empty()));
        assert_eq!(seen["streamUrl"], "");
    }

    #[test]
    fn a_client_still_sees_its_own_session_in_full() {
        let manager = Arc::new(WsConnectionManager::new());
        let owner = manager.register(addr("192.168.1.9:5001"), None);

        let live = session("11111111-2222-4333-8444-555555555555", "192.168.1.31");
        owner.claim_stream(&live.stream_id);

        let seen = session_for_connection(&owner, &live);
        assert_eq!(seen["streamId"], live.stream_id);
        assert_eq!(seen["streamUrl"], live.stream_url);
        assert!(seen.get("redacted").is_none());
    }

    #[test]
    fn a_clients_second_connection_sees_its_own_session() {
        let manager = Arc::new(WsConnectionManager::new());
        // The extension's streaming socket and its always-on control socket,
        // both from the same browser, and a second browser elsewhere.
        let streaming = manager.register(addr("192.168.1.9:5001"), None);
        let control = manager.register(addr("192.168.1.9:5002"), None);
        let other_browser = manager.register(addr("192.168.1.20:5003"), None);

        let live = session("11111111-2222-4333-8444-555555555555", "192.168.1.31");
        streaming.claim_stream(&live.stream_id);

        assert_eq!(
            session_for_connection(&control, &live)["streamId"],
            live.stream_id
        );
        assert_ne!(
            session_for_connection(&other_browser, &live)["streamId"],
            live.stream_id
        );
    }

    #[test]
    fn asserting_someone_elses_client_id_does_not_unredact_their_session() {
        let manager = Arc::new(WsConnectionManager::new());
        let victim = manager.register(addr("192.168.1.9:5001"), None);
        let live = session("11111111-2222-4333-8444-555555555555", "192.168.1.31");
        victim.claim_stream(&live.stream_id);

        // The client id is a label, not a key: asserting the victim's
        // connection id — or anything else — buys nothing.
        let attacker = manager.register(addr("192.168.1.20:5002"), Some(victim.id().to_string()));
        let seen = session_for_connection(&attacker, &live);
        assert_ne!(seen["streamId"], live.stream_id);
        assert_eq!(seen["redacted"], true);
    }

    #[test]
    fn the_placeholder_id_is_stable_per_stream_and_distinct_between_streams() {
        let first = "11111111-2222-4333-8444-555555555555";
        let second = "66666666-7777-4888-8999-aaaaaaaaaaaa";

        assert_eq!(opaque_stream_alias(first), opaque_stream_alias(first));
        assert_ne!(opaque_stream_alias(first), opaque_stream_alias(second));
        assert!(!opaque_stream_alias(first).contains(first));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Browser capture admission
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn browser_capture_is_restricted_to_clients_on_this_machine() {
        // The factory records the companion host's own output, so only a
        // client on that host may ask for it.
        assert!(is_companion_host("192.168.1.5", ip("127.0.0.1")));
        assert!(is_companion_host("192.168.1.5", ip("::1")));
        assert!(is_companion_host("192.168.1.5", ip("::ffff:127.0.0.1")));
        // The desktop Server view offers the LAN address with a copy button, so
        // the local user's browser may well arrive on it.
        assert!(is_companion_host("192.168.1.5", ip("192.168.1.5")));
        assert!(is_companion_host("192.168.1.5", ip("::ffff:192.168.1.5")));
        // Anyone else on the LAN is still refused.
        assert!(!is_companion_host("192.168.1.5", ip("192.168.1.50")));
        // A companion that has not resolved its address yet falls back to
        // loopback-only rather than accepting everyone.
        assert!(is_companion_host("", ip("127.0.0.1")));
        assert!(!is_companion_host("", ip("192.168.1.5")));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Broadcast event disclosure
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn live_stream_events_go_only_to_the_client_that_owns_the_stream() {
        let manager = Arc::new(WsConnectionManager::new());
        let owner = manager.register(addr("192.168.1.9:5001"), None);
        let stranger = manager.register(addr("192.168.1.20:5002"), None);
        let stream_id = "11111111-2222-4333-8444-555555555555".to_string();
        owner.claim_stream(&stream_id);

        // Staying connected while someone else starts a cast must not hand out
        // the id — or the ready-made URL — that /stream/{id}/live.wav answers.
        let created = BroadcastEvent::Stream(StreamEvent::Created {
            stream_id: stream_id.clone(),
            timestamp: 0,
        });
        let started = BroadcastEvent::Stream(StreamEvent::PlaybackStarted {
            stream_id: stream_id.clone(),
            speaker_ip: "192.168.1.31".into(),
            stream_url: format!("http://192.168.1.5:49400/stream/{stream_id}/live.wav"),
            timestamp: 0,
        });

        assert!(event_is_visible_to(&owner, &created));
        assert!(!event_is_visible_to(&stranger, &created));

        // PlaybackStarted is how the stranger learns the speaker is now held
        // by someone else, so it goes through - under the alias, URL blanked.
        assert!(event_is_visible_to(&owner, &started));
        assert!(event_is_visible_to(&stranger, &started));

        let mut for_owner = started.clone();
        redact_foreign_streams(&owner, &mut for_owner);
        assert_eq!(
            serde_json::to_string(&for_owner).unwrap(),
            serde_json::to_string(&started).unwrap(),
            "the owner sees its own event untouched"
        );

        let mut for_stranger = started;
        redact_foreign_streams(&stranger, &mut for_stranger);
        match for_stranger {
            BroadcastEvent::Stream(StreamEvent::PlaybackStarted {
                stream_id: seen,
                stream_url,
                speaker_ip,
                ..
            }) => {
                assert_eq!(seen, opaque_stream_alias(&stream_id));
                assert_eq!(stream_url, "");
                assert_eq!(speaker_ip, "192.168.1.31");
            }
            other => panic!("unexpected event {other:?}"),
        }
    }

    fn teardown_events(stream_id: &str) -> Vec<BroadcastEvent> {
        vec![
            BroadcastEvent::Stream(StreamEvent::Ended {
                stream_id: stream_id.to_string(),
                timestamp: 0,
            }),
            BroadcastEvent::Stream(StreamEvent::PlaybackStopped {
                stream_id: stream_id.to_string(),
                speaker_ip: "192.168.1.31".into(),
                reason: None,
                timestamp: 0,
            }),
            BroadcastEvent::Stream(StreamEvent::PlaybackStopFailed {
                stream_id: stream_id.to_string(),
                speaker_ip: "192.168.1.31".into(),
                error: "boom".into(),
                reason: None,
                timestamp: 0,
            }),
        ]
    }

    #[test]
    fn teardown_events_for_a_still_live_stream_reach_others_only_under_the_alias() {
        // Removing one speaker from a two-speaker cast stops playback there
        // while the stream keeps playing on the other, so the id in the event
        // is still fetchable from /stream/{id}/live.wav. The stranger still
        // needs to hear that the speaker is free, so Ended and PlaybackStopped
        // go through aliased; PlaybackStopFailed is the owner's business.
        let manager = Arc::new(WsConnectionManager::new());
        let owner = manager.register(addr("192.168.1.9:5001"), None);
        let stranger = manager.register(addr("192.168.1.20:5002"), None);
        let stream_id = "11111111-2222-4333-8444-555555555555";
        owner.claim_stream(stream_id);

        for event in teardown_events(stream_id) {
            assert!(event_is_visible_to(&owner, &event));
            let failed = matches!(
                event,
                BroadcastEvent::Stream(StreamEvent::PlaybackStopFailed { .. })
            );
            assert_eq!(event_is_visible_to(&stranger, &event), !failed);

            let mut for_owner = event.clone();
            redact_foreign_streams(&owner, &mut for_owner);
            assert_eq!(
                serde_json::to_string(&for_owner).unwrap(),
                serde_json::to_string(&event).unwrap()
            );

            let mut for_stranger = event;
            redact_foreign_streams(&stranger, &mut for_stranger);
            match for_stranger {
                BroadcastEvent::Stream(
                    StreamEvent::Ended {
                        stream_id: seen, ..
                    }
                    | StreamEvent::PlaybackStopped {
                        stream_id: seen, ..
                    },
                ) => assert_eq!(seen, opaque_stream_alias(stream_id)),
                BroadcastEvent::Stream(StreamEvent::PlaybackStopFailed { .. }) => {}
                other => panic!("unexpected event {other:?}"),
            }
        }
    }

    #[test]
    fn teardown_events_for_a_released_stream_reach_every_client() {
        // Once the stream is gone its id buys nothing, so every extension gets
        // the event it cleans its own session up from.
        let manager = Arc::new(WsConnectionManager::new());
        let owner = manager.register(addr("192.168.1.9:5001"), None);
        let stranger = manager.register(addr("192.168.1.20:5002"), None);
        let stream_id = "11111111-2222-4333-8444-555555555555";
        owner.claim_stream(stream_id);
        owner.manager().release_stream(stream_id);

        for event in teardown_events(stream_id) {
            assert!(event_is_visible_to(&owner, &event));
            assert!(event_is_visible_to(&stranger, &event));
        }
    }

    #[test]
    fn latency_events_do_not_hand_another_clients_stream_id_around() {
        // These repeat for the whole cast when video sync is on, so leaving
        // them unfiltered would be a continuous disclosure.
        let manager = Arc::new(WsConnectionManager::new());
        let owner = manager.register(addr("192.168.1.9:5001"), None);
        let stranger = manager.register(addr("192.168.1.20:5002"), None);
        let stream_id = "11111111-2222-4333-8444-555555555555".to_string();
        owner.claim_stream(&stream_id);

        let events = [
            BroadcastEvent::Latency(LatencyEvent::Updated {
                stream_id: stream_id.clone(),
                speaker_ip: "192.168.1.31".into(),
                epoch_id: 1,
                latency_ms: 40,
                jitter_ms: 2,
                confidence: 0.9,
                timestamp: 0,
            }),
            BroadcastEvent::Latency(LatencyEvent::Stale {
                stream_id,
                speaker_ip: "192.168.1.31".into(),
                epoch_id: 1,
                timestamp: 0,
            }),
        ];

        for event in &events {
            assert!(event_is_visible_to(&owner, event));
            assert!(!event_is_visible_to(&stranger, event));
        }
    }

    #[test]
    fn non_stream_events_are_not_filtered() {
        let manager = Arc::new(WsConnectionManager::new());
        let conn = manager.register(addr("192.168.1.20:5002"), None);

        // Speaker state is shared by everyone casting to the same system.
        let event = BroadcastEvent::Network(crate::events::NetworkEvent::HealthChanged {
            health: crate::events::NetworkHealth::Ok,
            reason: None,
            timestamp: 0,
        });
        assert!(event_is_visible_to(&conn, &event));
    }

    // ─────────────────────────────────────────────────────────────────────
    // Stream URLs quoted inside Sonos events
    // ─────────────────────────────────────────────────────────────────────

    fn transport_state(current_uri: Option<&str>) -> BroadcastEvent {
        BroadcastEvent::Sonos(SonosEvent::TransportState {
            speaker_ip: "192.168.1.31".into(),
            state: crate::sonos::types::TransportState::Paused,
            current_uri: current_uri.map(str::to_string),
            timestamp: 0,
        })
    }

    fn source_changed(current_uri: &str, expected_uri: Option<&str>) -> BroadcastEvent {
        BroadcastEvent::Sonos(SonosEvent::SourceChanged {
            speaker_ip: "192.168.1.31".into(),
            current_uri: current_uri.to_string(),
            expected_uri: expected_uri.map(str::to_string),
            timestamp: 0,
        })
    }

    #[test]
    fn a_stream_id_is_recognised_inside_a_quoted_uri() {
        assert_eq!(
            stream_id_in_uri("http://192.168.1.5:49400/stream/abc-123/live.wav"),
            Some("abc-123")
        );
        // Anything that is not one of our stream URLs names no stream.
        assert_eq!(stream_id_in_uri("x-sonos-spotify:track%3a4uLU6"), None);
        assert_eq!(stream_id_in_uri("x-rincon:RINCON_0000"), None);
        assert_eq!(stream_id_in_uri("http://192.168.1.5:49400/stream/"), None);
    }

    #[test]
    fn sonos_events_do_not_quote_another_clients_stream_url() {
        // The speaker echoes the victim's stream URL back in its GENA
        // notifications, so a bystander could read it out of a pause or a
        // source change without ever seeing a stream event.
        let manager = Arc::new(WsConnectionManager::new());
        let owner = manager.register(addr("192.168.1.9:5001"), None);
        let stranger = manager.register(addr("192.168.1.20:5002"), None);
        let stream_id = "11111111-2222-4333-8444-555555555555";
        owner.claim_stream(stream_id);
        let url = format!("http://192.168.1.5:49400/stream/{stream_id}/live.wav");

        for mut event in [
            transport_state(Some(&url)),
            source_changed(&url, Some(&url)),
        ] {
            redact_foreign_streams(&stranger, &mut event);
            let json = serde_json::to_string(&event).expect("serializable");
            assert!(!json.contains(stream_id), "leaked stream id: {json}");
            // The event itself still arrives: the extension acts on speakerIp.
            assert!(json.contains("192.168.1.31"));
        }
    }

    #[test]
    fn a_client_still_sees_its_own_stream_url_quoted_back() {
        let manager = Arc::new(WsConnectionManager::new());
        let owner = manager.register(addr("192.168.1.9:5001"), None);
        let stream_id = "11111111-2222-4333-8444-555555555555";
        owner.claim_stream(stream_id);
        let url = format!("http://192.168.1.5:49400/stream/{stream_id}/live.wav");

        let mut event = source_changed(&url, Some(&url));
        redact_foreign_streams(&owner, &mut event);
        let json = serde_json::to_string(&event).expect("serializable");
        assert!(json.contains(&url), "owner lost its own URI: {json}");
    }

    #[test]
    fn uris_that_name_no_stream_are_left_alone() {
        // Everything a speaker plays that is not a cast - radio, Spotify,
        // group membership - must survive untouched, for every client.
        let manager = Arc::new(WsConnectionManager::new());
        let stranger = manager.register(addr("192.168.1.20:5002"), None);

        let mut event = transport_state(Some("x-sonosapi-stream:s24939?sid=254"));
        redact_foreign_streams(&stranger, &mut event);
        let json = serde_json::to_string(&event).expect("serializable");
        assert!(json.contains("x-sonosapi-stream:s24939?sid=254"));

        // A released stream's id buys nothing, so it is not redacted either.
        let mut event = transport_state(Some(
            "http://192.168.1.5:49400/stream/already-ended/live.wav",
        ));
        redact_foreign_streams(&stranger, &mut event);
        let json = serde_json::to_string(&event).expect("serializable");
        assert!(json.contains("already-ended"));
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
        let mut forwarded = Vec::new();
        quiesce_control_worker(&cmd_tx, &mut reply_rx, &mut forwarded).await;
        assert!(
            finished.load(Ordering::SeqCst),
            "barrier must not resolve before the queued command completes"
        );
        assert_eq!(
            take_reply(&mut forwarded, &mut reply_rx).await,
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

        let mut forwarded = Vec::new();
        quiesce_control_worker(&cmd_tx, &mut reply_rx, &mut forwarded).await;
        assert_eq!(
            executed.load(Ordering::SeqCst),
            1,
            "a full queue must delay teardown, not wave it through unordered"
        );
        assert_eq!(
            take_reply(&mut forwarded, &mut reply_rx).await,
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
        let (_reply_tx, mut reply_rx) = mpsc::channel::<WsOutgoing>(1);
        let mut forwarded = Vec::new();
        tokio::time::timeout(
            CONTROL_WORKER_GRACE,
            quiesce_control_worker(&cmd_tx, &mut reply_rx, &mut forwarded),
        )
        .await
        .expect("barrier returns as soon as the worker is gone");
    }

    #[tokio::test(start_paused = true)]
    async fn barrier_forwards_replies_so_a_full_reply_channel_cannot_stall_it() {
        // Reply channel of one, three reply-producing commands queued: the
        // worker parks on its second reply unless the barrier keeps draining.
        let (cmd_tx, cmd_rx) = mpsc::channel::<ControlCommand>(4);
        let (reply_tx, mut reply_rx) = mpsc::channel::<WsOutgoing>(1);
        let cancel = CancellationToken::new();
        let worker = tokio::spawn(run_control_worker(
            cancel.clone(),
            cmd_rx,
            reply_tx,
            |command| async move {
                match command {
                    ControlCommand::SetVolume(req) => Some(volume_state(req.volume)),
                    _ => None,
                }
            },
        ));
        for volume in 1..=3 {
            dispatch_control_command(&cmd_tx, set_volume(volume)).unwrap();
        }

        let mut forwarded = Vec::new();
        let started = tokio::time::Instant::now();
        quiesce_control_worker(&cmd_tx, &mut reply_rx, &mut forwarded).await;
        assert!(
            started.elapsed() < CONTROL_WORKER_GRACE,
            "the barrier must be acked, not time out"
        );

        let mut replies: Vec<String> = forwarded
            .iter()
            .map(|m| match m {
                Message::Text(t) => t.to_string(),
                other => panic!("unexpected frame {other:?}"),
            })
            .collect();
        while let Ok(reply) = reply_rx.try_recv() {
            replies.push(json(&reply));
        }
        assert_eq!(
            replies,
            (1..=3).map(|v| json(&volume_state(v))).collect::<Vec<_>>(),
            "every reply reaches the client, in command order"
        );

        drop(cmd_tx);
        worker.await.expect("worker exits");
    }

    /// The reply the barrier saw: forwarded into the sink if it arrived while
    /// the barrier waited, otherwise still queued behind it.
    async fn take_reply(
        forwarded: &mut [Message],
        reply_rx: &mut mpsc::Receiver<WsOutgoing>,
    ) -> String {
        if let Some(Message::Text(text)) = forwarded.first() {
            return text.to_string();
        }
        json(&reply_rx.recv().await.expect("reply"))
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

    // ─────────────────────────────────────────────────────────────────────
    // Lagged event receiver
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn the_first_lag_resyncs_straight_away() {
        let mut resync = LagResync::default();
        let now = Instant::now();

        assert_eq!(resync.on_lag(7, now), Some(7));
        // Nothing is left over once the snapshot has gone out.
        assert_eq!(resync.take_due(now + RESYNC_MIN_INTERVAL * 2), None);
    }

    #[test]
    fn lags_inside_the_interval_are_coalesced_into_one_later_resync() {
        let mut resync = LagResync::default();
        let now = Instant::now();
        assert_eq!(resync.on_lag(3, now), Some(3));

        // A client that keeps falling behind must not earn a snapshot rebuild
        // per lagged recv() — that is the work it is already too slow for.
        assert_eq!(resync.on_lag(5, now + Duration::from_millis(10)), None);
        assert_eq!(resync.on_lag(4, now + Duration::from_millis(20)), None);
        assert_eq!(resync.take_due(now + Duration::from_millis(30)), None);

        // ...but once the interval passes, the skipped counts arrive together.
        assert_eq!(resync.take_due(now + RESYNC_MIN_INTERVAL), Some(9));
        // And only once: a released resync is not replayed on the next tick.
        assert_eq!(resync.take_due(now + RESYNC_MIN_INTERVAL * 2), None);
    }

    #[test]
    fn a_connection_that_never_lagged_is_never_resynced() {
        let mut resync = LagResync::default();
        let now = Instant::now();
        assert_eq!(resync.take_due(now), None);
        assert_eq!(resync.take_due(now + RESYNC_MIN_INTERVAL * 10), None);
    }

    #[test]
    fn a_lag_after_a_quiet_period_resyncs_immediately_again() {
        let mut resync = LagResync::default();
        let now = Instant::now();
        assert_eq!(resync.on_lag(2, now), Some(2));

        let later = now + RESYNC_MIN_INTERVAL * 3;
        assert_eq!(resync.on_lag(6, later), Some(6));
    }
}
