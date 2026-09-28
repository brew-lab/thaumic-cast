//! Audio streaming handler.
//!
//! Separated from REST handlers due to its distinct concerns:
//! codec-specific pipeline construction, prefill delays, epoch
//! tracking, ICY metadata injection, and WAV header generation.
//!
//! Runtime context: In the desktop app, this handler (and its cadence metronome)
//! runs on the dedicated `StreamingRuntime` high-priority threads — inherited
//! via `streaming_runtime.spawn()` in the Tauri API layer.

use std::net::{IpAddr, SocketAddr};
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant};

use axum::{
    body::Body,
    extract::{connect_info::ConnectInfo, Path, State},
    http::{header, HeaderMap},
    response::Response,
};
use bytes::Bytes;
use futures::stream::{Stream, StreamExt};
use tokio_stream::wrappers::errors::BroadcastStreamRecvError;
use tokio_stream::wrappers::BroadcastStream;

use crate::api::ws::is_companion_host;
use crate::api::AppState;
use crate::error::{ThaumicError, ThaumicResult};
use crate::protocol_constants::{APP_NAME, ICY_METAINT, WAV_STREAM_SIZE_MAX};
use crate::services::latency_monitor::speaker_monitor_enabled;
use crate::stream::manager::TimestampedFrame;
use crate::stream::{
    create_wav_header, create_wav_stream_with_cadence, lagged_error, pcm_connect_burst_ms,
    AudioCodec, CadenceConfig, ConnectionTap, EpochHook, FirstConnectionWait, HeadStart,
    IcyMetadataInjector, LoggingStreamGuard, StreamState, MAX_UNLISTED_STREAM_READERS,
};

/// A single item of an audio body stream.
type FrameResult = Result<Bytes, std::io::Error>;

/// Boxed stream type for audio data.
type AudioStream = Pin<Box<dyn Stream<Item = FrameResult> + Send>>;

/// What to do with a fetch of `/stream/{id}/live`, and why.
///
/// Produced by [`decide_stream_access`] so the warning line and the refusal
/// come from one decision rather than two that could drift apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StreamAccess {
    /// The peer holds a playback session on this stream, or is mid-start for it.
    Speaker,
    /// The peer is this machine: loopback, or the companion's own address.
    CompanionHost,
    /// The peer is on no list, and `strict_stream_access` is off: serve, warn.
    UnlistedServed,
    /// The peer is on no list, and `strict_stream_access` is on: refuse.
    UnlistedRefused,
}

impl StreamAccess {
    /// Whether this reader draws on the stream's unlisted-reader budget.
    ///
    /// Only a peer the stream is not playing on does. A speaker on the
    /// allowlist, or this host, is never refused for being one reader too
    /// many: it would be silent dead air, a large unsynced cast legitimately
    /// has as many readers as it has speakers, and each of their routine
    /// reconnects double-counts until the replaced connection is reaped. The
    /// cap exists to bound a *harvested* stream id, which is unlisted by
    /// definition, and exempting real speakers is also what stops an unlisted
    /// flood from starving them. See [`MAX_UNLISTED_STREAM_READERS`].
    fn draws_unlisted_budget(self) -> bool {
        match self {
            StreamAccess::Speaker | StreamAccess::CompanionHost => false,
            StreamAccess::UnlistedServed | StreamAccess::UnlistedRefused => true,
        }
    }

    /// Whether this reader's connections count as speaker playback.
    ///
    /// Playback bookkeeping is per source address: a connection starts an
    /// epoch for its address, and a later connection from the same address is
    /// treated as the speaker resuming (prefill skipped, `Play` re-sent). Both
    /// are meaningless for a reader that is not a speaker, and harmful: the
    /// epoch map is a bounded LRU sized for a household's speakers, so a
    /// handful of unlisted readers would evict a real speaker's entry and turn
    /// its next reconnect into a mis-timed cold start, and a reconnecting
    /// unlisted reader would have a SOAP `Play` sent to its own address.
    fn tracks_playback(self) -> bool {
        match self {
            StreamAccess::Speaker | StreamAccess::CompanionHost => true,
            StreamAccess::UnlistedServed | StreamAccess::UnlistedRefused => false,
        }
    }

    /// Whether this reader's playback can be watched by polling it.
    ///
    /// Only a speaker the stream is playing on answers `GetPositionInfo`.
    /// This machine tracks playback (a local player's reconnects are real
    /// resumes) but is not a Sonos speaker, so polling it would only collect
    /// refusals.
    fn monitors_playback(self) -> bool {
        match self {
            StreamAccess::Speaker => true,
            StreamAccess::CompanionHost
            | StreamAccess::UnlistedServed
            | StreamAccess::UnlistedRefused => false,
        }
    }
}

/// Decides whether `peer` may fetch a stream whose speakers are `speaker_ips`.
///
/// `speaker_ips` comes from `StreamCoordinator::allowed_reader_ips`, derived per
/// request rather than recorded at start, so speakers joining, leaving, being
/// taken over or being promoted need no bookkeeping here. `local_ip` is the
/// companion's own advertised address.
///
/// Both sides of every comparison are canonicalised. A dual-stack listener
/// reports an IPv4 client as an IPv4-mapped IPv6 address (`::ffff:192.168.1.5`),
/// which the WebSocket path already had to handle; session addresses arrive as
/// strings parsed out of the Sonos topology, so they are parsed and canonicalised
/// too rather than compared as text.
///
/// An address that parses as nothing is simply not a match — never a refusal of
/// everything else.
fn decide_stream_access(
    peer: IpAddr,
    speaker_ips: &[String],
    local_ip: &str,
    strict: bool,
) -> StreamAccess {
    let peer = peer.to_canonical();

    let is_speaker = speaker_ips
        .iter()
        .filter_map(|ip| ip.parse::<IpAddr>().ok())
        .any(|ip| ip.to_canonical() == peer);

    if is_speaker {
        StreamAccess::Speaker
    } else if is_companion_host(local_ip, peer) {
        // Covers loopback in both forms as well as this host's LAN address.
        StreamAccess::CompanionHost
    } else if strict {
        StreamAccess::UnlistedRefused
    } else {
        StreamAccess::UnlistedServed
    }
}

pub(super) async fn stream_audio(
    Path(id): Path<String>,
    State(state): State<AppState>,
    ConnectInfo(remote_addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> ThaumicResult<Response> {
    let stream_state = state
        .stream_coordinator
        .get_stream(&id)
        .ok_or_else(|| ThaumicError::StreamNotFound(id.clone()))?;

    let remote_ip = remote_addr.ip();

    // A stream id is not a credential — Sonos republishes the stream URL as
    // `CurrentTrackURI` to anything on the LAN that asks — so check that this
    // peer is one of the devices the stream is actually for. Derived per
    // request; see `decide_stream_access`.
    let allowed_ips = state.stream_coordinator.allowed_reader_ips(&id);
    let (strict, speaker_monitor, connect_burst_ms) = {
        let config = state.config.read();
        (
            config.strict_stream_access,
            config.speaker_monitor,
            config.pcm_connect_burst_ms,
        )
    };
    let access = decide_stream_access(
        remote_ip,
        &allowed_ips,
        &state.network.get_local_ip(),
        strict,
    );

    // `draws_unlisted_budget` matches exhaustively, so a future variant cannot
    // quietly fall through as both allowed and uncapped.
    let reader_slot = if access.draws_unlisted_budget() {
        let refused = access == StreamAccess::UnlistedRefused;
        // Once per address per stream at warn, then debug: a refused reader
        // that retries in a loop must not be able to fill the log, and the
        // first line already carries everything needed to judge it.
        let verdict = if refused {
            "refused (strict_stream_access is on)"
        } else {
            "serving anyway (strict_stream_access is off)"
        };
        if stream_state.note_unlisted_reader(remote_ip) {
            log::warn!(
                "[Stream] Fetch from an address this stream is not for: client={}, stream={}, \
                 allowed={:?} — {}",
                remote_ip,
                id,
                allowed_ips,
                verdict
            );
        } else {
            log::debug!(
                "[Stream] Repeat fetch from an address this stream is not for: client={}, \
                 stream={} — {}",
                remote_ip,
                id,
                verdict
            );
        }
        if refused {
            // 404, not 403: an expired stream already answers 404, so a
            // harvested id learns nothing about whether it was ever valid.
            return Err(ThaumicError::StreamNotFound(id));
        }

        // Serving it, but on a budget: every reader costs a cadence pipeline,
        // so a harvested id must not fan out without bound. Not an access
        // decision — it is not gated on `strict_stream_access`; strict mode
        // simply refuses these peers before they ever reach it. The slot is
        // held by the response body below and freed when that body is dropped.
        // 404 for the same reason a refusal is: the caller learns nothing.
        let Some(slot) = stream_state.acquire_unlisted_reader() else {
            log::warn!(
                "[Stream] Refusing fetch: stream {} already has its maximum of {} readers from \
                 addresses it is not playing on (client={})",
                id,
                MAX_UNLISTED_STREAM_READERS,
                remote_ip
            );
            return Err(ThaumicError::StreamNotFound(id));
        };
        Some(slot)
    } else {
        None
    };

    let range_header = headers
        .get(header::RANGE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    if let Some(ref range) = range_header {
        log::debug!(
            "[Stream] Range request: client={}, stream={}, codec={:?}, range='{}'",
            remote_ip,
            id,
            stream_state.codec,
            range
        );
    } else {
        log::info!(
            "[Stream] New connection: client={}, stream={}, codec={:?}",
            remote_ip,
            id,
            stream_state.codec
        );
    }

    // Detect resume: this specific IP had a previous HTTP connection.
    // Uses per-IP epoch tracking (not global counter) to avoid misclassifying
    // new speakers as resumes after the first speaker connects. Readers that
    // are not speakers never start an epoch (see `tracks_playback`), so they
    // can never look like one resuming either.
    let is_resume =
        access.tracks_playback() && stream_state.timing.current_epoch_for(remote_ip).is_some();

    // Upfront buffering delay for PCM streams BEFORE subscribing.
    // Lets the ring buffer accumulate frames so the prefill snapshot returned
    // by `subscribe()` has real audio — otherwise the cadence stream would
    // begin emitting silence frames as its first body bytes, which Sonos has
    // been observed to treat as a stalled stream and respond to with a
    // transport-state transition to Stopped.
    //
    // The ring must hold the jitter buffer, which the cadence queue keeps,
    // plus the connect burst, which goes out at once (see
    // `CadenceConfig::new`). So a first connection waits until the stream is
    // `jitter_buffer_ms + burst` old, and never less than `jitter_buffer_ms`
    // (see `pcm_prefill_delay`). A speaker's GET usually follows the
    // stream's first frame within a second, so without the longer wait its
    // first connection, the one the reserve matters most on, would get only
    // a fraction of the burst. The longest wait is jitter buffer plus burst.
    // A Playbar has been seen to accept a 1000 ms wait before the response;
    // longer ones are untried, so the wait is not capped but logged, and so
    // is whether the speaker kept its connection through it (see
    // `LoggingStreamGuard::with_first_wait`). `jitter_buffer_ms` is already
    // validated against `MAX_JITTER_BUFFER_MS` at the protocol layer, and
    // the burst against its maximum.
    //
    // SKIP on resume: Sonos closes the connection within milliseconds if we
    // delay. The ring buffer already has frames from before the pause.
    let connect_burst_ms = pcm_connect_burst_ms(connect_burst_ms);
    let since_first_frame = stream_state.timing.first_frame_at().map(|t| t.elapsed());
    let prefill_delay = pcm_prefill_delay(
        stream_state.jitter_buffer_ms,
        connect_burst_ms,
        since_first_frame,
    );
    let mut first_wait = None;
    if stream_state.codec == AudioCodec::Pcm && !prefill_delay.is_zero() && !is_resume {
        let wait = FirstConnectionWait {
            waited_ms: prefill_delay.as_millis() as u64,
            smoothing_ms: stream_state.jitter_buffer_ms,
            head_start_ms: connect_burst_ms,
        };
        log::info!(
            "[Stream] First-connection wait: client={}, stream={}, holding the response {}ms \
             (smoothing {}ms + head start {}ms, stream {} old)",
            remote_ip,
            id,
            wait.waited_ms,
            wait.smoothing_ms,
            wait.head_start_ms,
            since_first_frame.map_or_else(
                || "not yet started".to_string(),
                |d| format!("{}ms", d.as_millis())
            )
        );
        first_wait = Some(wait);
        tokio::time::sleep(prefill_delay).await;
    } else if is_resume && stream_state.codec == AudioCodec::Pcm {
        log::info!(
            "[Stream] Skipping prefill delay on resume for {}",
            remote_ip
        );

        // Delegate playback control to coordinator (SoC: HTTP serves audio,
        // coordinator controls playback). Fire-and-forget.
        let coordinator = Arc::clone(&state.stream_coordinator);
        let ip = remote_ip.to_string();
        tokio::spawn(async move {
            coordinator.on_http_resume(&ip).await;
        });
    }

    // Capture connected_at AFTER the prefill delay so latency metrics reflect
    // actual transport latency, not intentional startup buffering.
    let connected_at = Instant::now();

    // Subscribe AFTER delay to get fresh prefill snapshot and avoid rx backlog
    let (prefill_frames, rx) = stream_state.subscribe();

    log::debug!(
        "[Stream] Client {} connected to stream {}, sending {} prefill frames",
        remote_ip,
        id,
        prefill_frames.len()
    );

    // Create logging guard early so we can pass it to the cadence stream for internal tracking.
    // Uses Arc so it can be shared between cadence stream and final frame recording.
    // The connection's TCP counters judge the network path to this speaker;
    // only a reader the stream is for is worth judging, and reporting on an
    // unlisted reader would name an address that is not a speaker.
    let link_probe = access
        .tracks_playback()
        .then(|| state.link_registry.claim(remote_addr))
        .flatten();
    let mut guard = LoggingStreamGuard::new(id.to_string(), remote_ip).with_link_probe(
        link_probe,
        stream_state.jitter_buffer_ms,
        Arc::clone(&state.event_bridge) as Arc<dyn crate::events::EventEmitter>,
    );
    if let Some(wait) = first_wait {
        guard = guard.with_first_wait(wait);
    }
    let guard = Arc::new(guard);

    // One-shot epoch hook for whichever pipeline is built below. None for a
    // reader that is not a speaker: its connection must not enter the
    // per-address playback bookkeeping (see `tracks_playback`).
    //
    // The epoch's content T0 is the first frame each pipeline serves: the PCM
    // cadence trims the prefill first, so it supplies its own.
    //
    // A speaker's connection is also handed to the speaker monitor once its
    // epoch starts: whoever actually fetches is the device whose playback can
    // be measured, however the cast was started. The monitor always learns of
    // the connection, since video sync may need it; whether it polls a
    // speaker nobody asked video sync for follows the speaker-monitor
    // setting as it stands now, so a change applies from the next connection.
    let tap = access.monitors_playback().then(|| {
        Arc::new(ConnectionTap::new(
            id.clone(),
            remote_ip,
            connected_at,
            stream_state.codec,
            &stream_state.audio_format,
            Arc::clone(&guard),
            speaker_monitor_enabled(speaker_monitor),
        ))
    });
    let epoch_hook: Option<EpochHook> = access.tracks_playback().then(|| {
        let hook = EpochHook::new(Arc::downgrade(&stream_state), connected_at, remote_ip);
        match &tap {
            Some(tap) => hook.with_monitor(Arc::clone(tap), state.latency_monitor.registrar()),
            None => hook,
        }
    });

    // Build combined stream - PCM gets cadence-based streaming, compressed codecs don't.
    //
    // Why PCM-only: Sonos treats PCM/WAV as a "file" requiring continuous data flow.
    // CPU spikes that delay delivery cause Sonos to close the connection.
    // The cadence stream maintains 20ms output cadence, injecting silence when needed.
    //
    // Compressed codecs (AAC, MP3, FLAC) have their own framing and silence
    // representation - raw zeros would corrupt the stream. These codecs also
    // tend to be more resilient to jitter due to their buffering behavior.
    let combined_stream: AudioStream = if stream_state.codec == AudioCodec::Pcm {
        // PCM: fixed-cadence streaming with silence injection on underrun.
        // Prefill frames are pre-populated in the queue to eliminate the
        // handoff gap; `CadenceConfig::new` trims them so the initial queue
        // does not exceed the intended buffer depth, and anchors the epoch to
        // the first frame it keeps.
        //
        // The oldest frames beyond the jitter buffer, up to the configured
        // connect burst, are sent at once so the speaker starts with that much
        // audio in hand (see `CadenceConfig::burst_frames`). A resume gets it
        // too: that is when a speaker's reserve starts again from nothing.
        // The tap records the head start actually sent, which the speaker
        // monitor sizes the speaker's low floor from.
        pcm_cadence_stream(
            &stream_state,
            connect_burst_ms,
            prefill_frames,
            rx,
            Arc::clone(&guard),
            epoch_hook,
            tap.as_deref(),
            remote_ip,
            is_resume,
        )
    } else {
        // Compressed codecs: no silence injection, chain prefill before live.
        // Every prefill frame is served, so the oldest one is the first.
        let epoch_candidate = prefill_frames.first().map(|f| f.captured_at);
        let prefill_stream = futures::stream::iter(prefill_frames.into_iter().map(|f| Ok(f.data)));
        let live_stream = BroadcastStream::new(rx).map(|res| match res {
            Ok(frame) => Ok(frame),
            Err(BroadcastStreamRecvError::Lagged(n)) => Err(lagged_error(n)),
        });
        let raw_stream = futures::StreamExt::chain(prefill_stream, live_stream);

        // Fire epoch on first non-empty frame (compressed codecs never inject silence)
        match epoch_hook {
            Some(hook) => Box::pin(with_epoch_hook(raw_stream, hook, epoch_candidate)),
            None => Box::pin(raw_stream),
        }
    };

    // Content-Type based on output codec
    let content_type = stream_state.codec.mime_type();

    // ICY metadata only supported for MP3/AAC streams (not PCM/FLAC)
    let supports_icy = matches!(stream_state.codec, AudioCodec::Mp3 | AudioCodec::Aac);
    let wants_icy =
        supports_icy && headers.get("icy-metadata").and_then(|v| v.to_str().ok()) == Some("1");

    let mut builder = Response::builder()
        .header(header::CONTENT_TYPE, content_type)
        .header(header::CACHE_CONTROL, "no-cache")
        .header(header::CONNECTION, "keep-alive")
        // DLNA streaming header: indicates real-time playback vs download-first
        .header("TransferMode.dlna.org", "Streaming")
        // Stream identification for renderers that display station name
        .header("icy-name", APP_NAME);

    if wants_icy {
        builder = builder.header("icy-metaint", ICY_METAINT.to_string());
    }

    // PCM: Use fixed Content-Length to avoid chunked transfer encoding.
    // Some renderers (including Sonos) stutter or disconnect with chunked encoding.
    // The stream will end before reaching this length, but it signals "file-like"
    // behavior to the renderer.
    if stream_state.codec == AudioCodec::Pcm {
        builder = builder.header(header::CONTENT_LENGTH, WAV_STREAM_SIZE_MAX.to_string());
    }

    // Apply ICY injection or PCM/WAV header
    let inner_stream: AudioStream = if wants_icy {
        Box::pin(with_icy_metadata(
            combined_stream,
            Arc::downgrade(&stream_state),
        ))
    } else if stream_state.codec == AudioCodec::Pcm {
        // PCM streams need WAV header prepended per-connection (Sonos may reconnect)
        let audio_format = stream_state.audio_format;
        let wav_header = create_wav_header(
            audio_format.sample_rate,
            audio_format.channels,
            audio_format.bits_per_sample,
        );
        Box::pin(futures::StreamExt::chain(
            futures::stream::once(async move { Ok(wav_header) }),
            combined_stream,
        ))
    } else {
        Box::pin(combined_stream)
    };

    // Wrap stream with logging guard to track delivery timing and errors.
    // The guard logs summary stats on drop when the stream ends. The body
    // also owns the connection's tap and, for an unlisted reader, its budget
    // slot (see `with_delivery_record`).
    let final_stream: AudioStream = Box::pin(with_delivery_record(
        inner_stream,
        guard,
        (tap, reader_slot),
    ));

    builder
        .body(Body::from_stream(final_stream))
        .map_err(|e| ThaumicError::Internal(e.to_string()))
}

/// How long a new (not resuming) PCM connection waits before subscribing,
/// so the ring holds the jitter buffer plus the connect burst: until the
/// stream's first frame is `jitter_buffer_ms + burst_ms` old, and never less
/// than `jitter_buffer_ms`. `since_first_frame` is `None` before the stream
/// has received a frame, which waits the whole of both.
fn pcm_prefill_delay(
    jitter_buffer_ms: u64,
    burst_ms: u64,
    since_first_frame: Option<Duration>,
) -> Duration {
    let jitter = Duration::from_millis(jitter_buffer_ms);
    let wanted = Duration::from_millis(jitter_buffer_ms + burst_ms);
    wanted
        .saturating_sub(since_first_frame.unwrap_or_default())
        .max(jitter)
}

/// Builds a PCM connection's cadence body from its `subscribe()` snapshot,
/// with a connect burst of `burst_ms` (already resolved, see
/// [`pcm_connect_burst_ms`]), records on `tap` the head start the ring
/// allowed, and logs how the prefill was split.
#[allow(clippy::too_many_arguments)]
fn pcm_cadence_stream(
    stream_state: &Arc<StreamState>,
    burst_ms: u64,
    prefill_frames: Vec<TimestampedFrame>,
    rx: tokio::sync::broadcast::Receiver<Bytes>,
    guard: Arc<LoggingStreamGuard>,
    epoch_hook: Option<EpochHook>,
    tap: Option<&ConnectionTap>,
    remote_ip: IpAddr,
    is_resume: bool,
) -> AudioStream {
    let frame_duration_ms = stream_state.frame_duration_ms;
    let available_frames = prefill_frames.len();
    let config = CadenceConfig::new(
        stream_state.audio_format.silence_frame(frame_duration_ms),
        stream_state.jitter_buffer_ms,
        burst_ms,
        frame_duration_ms,
        stream_state.audio_format,
        prefill_frames,
    );
    if let Some(tap) = tap {
        tap.set_head_start(HeadStart::new(config.burst_ms(), burst_ms));
    }
    log_connect_burst(
        &stream_state.id,
        remote_ip,
        is_resume,
        burst_ms,
        available_frames,
        &config,
    );
    Box::pin(create_wav_stream_with_cadence(
        rx,
        guard,
        config,
        Some(Arc::downgrade(stream_state)),
        epoch_hook,
    ))
}

/// Logs how much of a PCM connection's prefill is sent as its connect burst
/// and how much stays queued as the jitter buffer, and says so when the ring
/// held less than was asked for.
fn log_connect_burst(
    stream_id: &str,
    remote_ip: IpAddr,
    is_resume: bool,
    requested_ms: u64,
    available_frames: usize,
    config: &CadenceConfig,
) {
    let frame_ms = u64::from(config.frame_duration_ms);
    let burst_ms = config.burst_ms();
    let queued_ms = config.prefill_frames.len() as u64 * frame_ms;
    let target_ms = config.buffer_depth as u64 * frame_ms;
    let kind = if is_resume {
        "resume"
    } else {
        "new connection"
    };
    if requested_ms == 0 {
        log::info!(
            "[Stream] Connect burst off: client={}, stream={}, {}, queued={}ms of {}ms jitter buffer",
            remote_ip,
            stream_id,
            kind,
            queued_ms,
            target_ms
        );
    } else if burst_ms < requested_ms {
        // Info, not warn: the prefill delay waits for the full burst on a
        // first connection, so this is a resume soon after the stream began
        // or after a source pause, and the next connection gets it all.
        log::info!(
            "[Stream] Connect burst short: client={}, stream={}, {}, burst={}ms of {}ms requested, \
             queued={}ms of {}ms jitter buffer; the stream only held {}ms of audio, and the \
             jitter buffer is kept first",
            remote_ip,
            stream_id,
            kind,
            burst_ms,
            requested_ms,
            queued_ms,
            target_ms,
            available_frames as u64 * frame_ms
        );
    } else {
        log::info!(
            "[Stream] Connect burst: client={}, stream={}, {}, burst={}ms, queued={}ms of {}ms \
             jitter buffer",
            remote_ip,
            stream_id,
            kind,
            burst_ms,
            queued_ms,
            target_ms
        );
    }
}

/// Counts every item the body yields into `guard`: frames and bytes
/// delivered, which the speaker monitor reads as the delivered side of the
/// speaker's reserve (so a connect burst counts in full), and the first
/// error.
///
/// `owned` is whatever else the response body must own for its lifetime: the
/// connection's monitoring tap (the monitor holds it weakly, so dropping the
/// body ends its monitoring) and, for an unlisted reader, its budget slot,
/// freed when the body is dropped, the moment this reader is really gone.
fn with_delivery_record<S, O>(
    stream: S,
    guard: Arc<LoggingStreamGuard>,
    owned: O,
) -> impl Stream<Item = FrameResult> + Send
where
    S: Stream<Item = FrameResult> + Send,
    O: Send,
{
    let closed_on_drop = BodyClosedOnDrop(Arc::clone(&guard));
    stream.map(move |res: FrameResult| {
        let _owned = (&owned, &closed_on_drop);
        match &res {
            Ok(bytes) => {
                guard.record_frame();
                guard
                    .bytes_sent
                    .fetch_add(bytes.len() as u64, Ordering::Relaxed);
            }
            Err(e) => guard.record_error(&e.to_string()),
        }
        res
    })
}

/// Marks the connection's body closed when the body is dropped, which stops
/// the speaker monitor reading its socket (see
/// [`LoggingStreamGuard::mark_body_closed`]).
struct BodyClosedOnDrop(Arc<LoggingStreamGuard>);

impl Drop for BodyClosedOnDrop {
    fn drop(&mut self) {
        self.0.mark_body_closed();
    }
}

/// Starts a new playback epoch on the first real (non-empty) frame, then forgets
/// the hook.
///
/// `epoch_candidate` is the capture time of the first frame `stream` serves, or
/// `None` when it serves no prefill.
///
/// Errors and empty frames leave the hook armed: a live stream that has not
/// produced audio yet must still be timed from its first real frame.
///
/// If the [`Weak`] no longer upgrades the stream has been removed, so there is
/// nothing to time and the hook is dropped. The body itself ends on its own once
/// the broadcast sender goes with the stream.
fn with_epoch_hook<S>(
    stream: S,
    hook: EpochHook,
    epoch_candidate: Option<Instant>,
) -> impl Stream<Item = FrameResult> + Send
where
    S: Stream<Item = FrameResult> + Send,
{
    stream.scan(Some(hook), move |hook, item: FrameResult| {
        if let Some(armed) = hook.take() {
            let is_audio = item.as_ref().is_ok_and(|frame| !frame.is_empty());
            if is_audio {
                armed.fire(epoch_candidate);
            } else if armed.stream_alive() {
                // Alive but nothing to time yet - stay armed.
                *hook = Some(armed);
            }
            // Otherwise the stream is gone - drop the hook.
        }
        futures::future::ready(Some(item))
    })
}

/// Injects ICY metadata blocks into a body stream at `ICY_METAINT` intervals.
///
/// Holds the stream weakly for the same reason as [`EpochHook`]: the body must
/// not keep a removed stream alive. A failed upgrade ends the body, which tears
/// down the connection instead of feeding a speaker from a stream that is gone.
fn with_icy_metadata<S>(
    stream: S,
    stream_state: Weak<StreamState>,
) -> impl Stream<Item = FrameResult> + Send
where
    S: Stream<Item = FrameResult> + Send,
{
    stream.scan(IcyMetadataInjector::new(), move |injector, res| {
        let item = match res {
            Ok(chunk) => stream_state.upgrade().map(|state| {
                let metadata = state.metadata.read();
                Ok(injector.inject(chunk.as_ref(), &metadata))
            }),
            Err(e) => Some(Err(e)),
        };
        futures::future::ready(item)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::stream::AudioFormat;
    use std::net::Ipv4Addr;

    /// The companion's own advertised address in these tests.
    const LOCAL_IP: &str = "192.168.1.5";

    fn ip(s: &str) -> IpAddr {
        s.parse().expect("test address")
    }

    fn speakers(ips: &[&str]) -> Vec<String> {
        ips.iter().map(|s| (*s).to_string()).collect()
    }

    /// Access is decided by `decide_stream_access` rather than inside the axum
    /// handler, so these exercise the real decision without an HTTP stack, a
    /// bound port or a Sonos speaker. What they cannot cover is the wiring —
    /// that the handler calls it with the coordinator's live allowlist and turns
    /// a refusal into the same 404 an expired stream returns.
    #[test]
    fn a_speaker_playing_this_stream_is_served() {
        let allowed = speakers(&["192.168.1.50", "192.168.1.51"]);
        for strict in [false, true] {
            assert_eq!(
                decide_stream_access(ip("192.168.1.51"), &allowed, LOCAL_IP, strict),
                StreamAccess::Speaker,
                "every speaker of an unsynced multi-speaker cast fetches the same URL"
            );
        }
    }

    #[test]
    fn an_unknown_address_is_served_and_logged_until_the_flag_is_on() {
        let allowed = speakers(&["192.168.1.50"]);
        assert_eq!(
            decide_stream_access(ip("192.168.1.200"), &allowed, LOCAL_IP, false),
            StreamAccess::UnlistedServed
        );
        assert_eq!(
            decide_stream_access(ip("192.168.1.200"), &allowed, LOCAL_IP, true),
            StreamAccess::UnlistedRefused
        );
    }

    /// Loopback in both forms, and the host's own LAN address, which the desktop
    /// Server view offers with a copy button.
    #[test]
    fn this_machine_is_always_allowed() {
        for peer in ["127.0.0.1", "::1", "::ffff:127.0.0.1", LOCAL_IP] {
            assert_eq!(
                decide_stream_access(ip(peer), &[], LOCAL_IP, true),
                StreamAccess::CompanionHost,
                "{peer} is this machine"
            );
        }
    }

    /// A dual-stack listener reports an IPv4 client as an IPv4-mapped IPv6
    /// address; session addresses come out of the Sonos topology as plain IPv4
    /// strings. Comparing either side raw would refuse a real speaker.
    #[test]
    fn an_ipv4_mapped_peer_matches_its_plain_session_address() {
        assert_eq!(
            decide_stream_access(
                ip("::ffff:192.168.1.50"),
                &speakers(&["192.168.1.50"]),
                LOCAL_IP,
                true
            ),
            StreamAccess::Speaker
        );
    }

    /// An unparsable or empty entry must not match, and must not poison the list.
    #[test]
    fn unparsable_addresses_are_ignored_not_fatal() {
        let allowed = speakers(&["", "not-an-ip", "192.168.1.50"]);
        assert_eq!(
            decide_stream_access(ip("192.168.1.50"), &allowed, LOCAL_IP, true),
            StreamAccess::Speaker
        );
        assert_eq!(
            decide_stream_access(ip("192.168.1.60"), &allowed, "", true),
            StreamAccess::UnlistedRefused,
            "a companion that has not resolved its own address yet still refuses strangers"
        );
    }

    /// Promotion hands a slave the stream URL while its session still reads
    /// `Slave` and calls `play_uri` before re-recording it as coordinator, so the
    /// promoted speaker must already be on the list when that call lands.
    #[test]
    fn a_promoted_coordinator_is_allowed_when_play_uri_runs() {
        // What the session store holds at that instant: the old coordinator has
        // been torn down, the promoted speaker is still recorded as a slave.
        let allowed = speakers(&["192.168.1.51", "192.168.1.52"]);
        assert_eq!(
            decide_stream_access(ip("192.168.1.51"), &allowed, LOCAL_IP, true),
            StreamAccess::Speaker
        );
    }

    #[test]
    fn the_reader_cap_trips_and_frees_its_slots() {
        let state = test_stream_state();

        let slots: Vec<_> = (0..MAX_UNLISTED_STREAM_READERS)
            .map(|n| {
                state
                    .acquire_unlisted_reader()
                    .unwrap_or_else(|| panic!("reader {n} is within the cap"))
            })
            .collect();
        assert_eq!(state.unlisted_reader_count(), MAX_UNLISTED_STREAM_READERS);
        assert!(
            state.acquire_unlisted_reader().is_none(),
            "a harvested stream id must not fan out past the cap"
        );

        drop(slots);
        assert_eq!(
            state.unlisted_reader_count(),
            0,
            "a closed body frees its slot"
        );
        assert!(state.acquire_unlisted_reader().is_some());
    }

    /// The cap must never be able to refuse a device the stream is actually
    /// for. An unsynced cast legitimately has one reader per speaker, each
    /// routine reconnect double-counts until the replaced connection is reaped,
    /// and a refusal is dead air — so speakers and this host take no slot at
    /// all, which is also what stops an unlisted flood from starving them.
    #[test]
    fn allowlisted_readers_are_exempt_from_the_cap() {
        assert!(!StreamAccess::Speaker.draws_unlisted_budget());
        assert!(!StreamAccess::CompanionHost.draws_unlisted_budget());
        assert!(StreamAccess::UnlistedServed.draws_unlisted_budget());
        assert!(StreamAccess::Speaker.tracks_playback());
        assert!(StreamAccess::CompanionHost.tracks_playback());
        assert!(!StreamAccess::UnlistedServed.tracks_playback());
        assert!(!StreamAccess::UnlistedRefused.tracks_playback());
        assert!(StreamAccess::Speaker.monitors_playback());
        assert!(
            !StreamAccess::CompanionHost.monitors_playback(),
            "this machine is not a Sonos speaker and cannot be polled"
        );
        assert!(!StreamAccess::UnlistedServed.monitors_playback());

        // A stream whose unlisted budget is fully spent still admits speakers:
        // they never consult it.
        let state = test_stream_state();
        let _flood: Vec<_> = (0..MAX_UNLISTED_STREAM_READERS)
            .map(|_| state.acquire_unlisted_reader().expect("within the cap"))
            .collect();
        assert!(state.acquire_unlisted_reader().is_none());
        assert_eq!(
            decide_stream_access(
                ip("192.168.1.50"),
                &speakers(&["192.168.1.50"]),
                LOCAL_IP,
                false
            ),
            StreamAccess::Speaker,
            "a real speaker's fetch is unaffected by the unlisted budget"
        );
    }

    fn test_stream_state() -> Arc<StreamState> {
        Arc::new(StreamState::new(
            "test-stream".to_string(),
            AudioCodec::Aac,
            AudioFormat::default(),
            8,
            16,
            200,
            20,
        ))
    }

    fn test_ip() -> IpAddr {
        IpAddr::V4(Ipv4Addr::LOCALHOST)
    }

    fn hook_for(state: &Arc<StreamState>) -> EpochHook {
        EpochHook::new(Arc::downgrade(state), Instant::now(), test_ip())
    }

    #[tokio::test]
    async fn epoch_hook_stays_armed_until_the_first_real_frame() {
        let state = test_stream_state();
        let source = futures::stream::iter(vec![
            Err(std::io::Error::other("transient")),
            Ok(Bytes::new()),
            Ok(Bytes::from_static(b"audio")),
        ]);
        let mut body = Box::pin(with_epoch_hook(source, hook_for(&state), None));

        body.next().await.expect("error item").expect_err("error");
        assert!(
            state.timing.current_epoch_for(test_ip()).is_none(),
            "an error must not start an epoch"
        );

        body.next().await.expect("empty frame").expect("ok");
        assert!(
            state.timing.current_epoch_for(test_ip()).is_none(),
            "an empty frame must not start an epoch"
        );

        body.next().await.expect("audio frame").expect("ok");
        assert!(
            state.timing.current_epoch_for(test_ip()).is_some(),
            "the first real frame must start an epoch"
        );
    }

    #[tokio::test]
    async fn epoch_hook_anchors_to_the_first_served_frame() {
        let state = test_stream_state();
        let first_served = Instant::now() - Duration::from_millis(150);
        let source = futures::stream::iter(vec![Ok(Bytes::from_static(b"audio"))]);
        let mut body = Box::pin(with_epoch_hook(
            source,
            hook_for(&state),
            Some(first_served),
        ));

        body.next().await.expect("audio frame").expect("ok");
        let epoch = state
            .timing
            .current_epoch_for(test_ip())
            .expect("the first real frame starts an epoch");
        assert_eq!(epoch.audio_epoch, first_served);
    }

    /// Monitoring follows whoever fetches: the connection reaches the monitor
    /// when its first real frame starts its epoch, and not before, so the
    /// monitor never sees a connection it cannot time.
    #[tokio::test]
    async fn epoch_hook_registers_a_monitored_connection_once_its_epoch_starts() {
        use crate::stream::MonitorRegistrar;
        let state = test_stream_state();
        let (registrar, mut registrations) = MonitorRegistrar::channel();
        let tap = Arc::new(ConnectionTap::new(
            "test-stream",
            test_ip(),
            Instant::now(),
            AudioCodec::Aac,
            &AudioFormat::default(),
            Arc::new(LoggingStreamGuard::new("test-stream".into(), test_ip())),
            true,
        ));
        let hook = hook_for(&state).with_monitor(Arc::clone(&tap), registrar);
        let source =
            futures::stream::iter(vec![Ok(Bytes::new()), Ok(Bytes::from_static(b"audio"))]);
        let mut body = Box::pin(with_epoch_hook(source, hook, None));

        body.next().await.expect("empty frame").expect("ok");
        assert!(
            registrations.try_recv().is_err(),
            "no epoch, no registration"
        );

        body.next().await.expect("audio frame").expect("ok");
        let registered = registrations
            .try_recv()
            .expect("registered on the first real frame")
            .upgrade()
            .expect("the connection is still open");
        let epoch = state.timing.current_epoch_for(test_ip()).expect("epoch");
        assert_eq!(registered.epoch().map(|e| e.id), Some(epoch.id));
        assert!(state
            .timing
            .current_tap_for(test_ip())
            .is_some_and(|t| Arc::ptr_eq(&t, &tap)));
    }

    #[tokio::test]
    async fn epoch_hook_does_not_keep_the_stream_alive() {
        let state = test_stream_state();
        let weak = Arc::downgrade(&state);
        // Never yields audio, so the hook is still armed when the stream is removed.
        let source = futures::stream::iter(vec![Ok(Bytes::new()), Ok(Bytes::from_static(b"late"))]);
        let mut body = Box::pin(with_epoch_hook(source, hook_for(&state), None));

        body.next().await.expect("empty frame").expect("ok");
        drop(state);

        assert!(
            weak.upgrade().is_none(),
            "an armed epoch hook must not hold the coordinator's stream alive"
        );
        // The armed hook is simply discarded; frames still pass through.
        body.next().await.expect("late frame").expect("ok");
    }

    #[tokio::test]
    async fn icy_injection_passes_chunks_while_the_stream_lives() {
        let state = test_stream_state();
        let source = futures::stream::iter(vec![Ok(Bytes::from_static(b"aac-frame"))]);
        let mut body = Box::pin(with_icy_metadata(source, Arc::downgrade(&state)));

        let chunk = body.next().await.expect("chunk").expect("ok");
        assert_eq!(chunk.as_ref(), b"aac-frame");
    }

    #[tokio::test]
    async fn icy_injection_ends_the_body_when_the_stream_is_removed() {
        let state = test_stream_state();
        let weak = Arc::downgrade(&state);
        let source = futures::stream::iter(vec![Ok(Bytes::from_static(b"aac-frame"))]);
        let mut body = Box::pin(with_icy_metadata(source, weak.clone()));

        drop(state);
        assert!(weak.upgrade().is_none());
        assert!(
            body.next().await.is_none(),
            "the body must end once the stream is gone"
        );
    }

    /// The compressed-codec body as it is assembled in `stream_audio`: dropping the
    /// coordinator's `Arc` must close the broadcast channel and end the response body.
    #[tokio::test]
    async fn compressed_body_ends_when_the_coordinator_drops_the_stream() {
        let state = test_stream_state();
        let (_, rx) = state.subscribe();
        let weak = Arc::downgrade(&state);

        let live = BroadcastStream::new(rx).map(|res| match res {
            Ok(frame) => Ok(frame),
            Err(BroadcastStreamRecvError::Lagged(n)) => Err(lagged_error(n)),
        });
        let mut body = Box::pin(with_icy_metadata(
            with_epoch_hook(live, hook_for(&state), None),
            weak.clone(),
        ));

        drop(state);

        assert!(
            weak.upgrade().is_none(),
            "the response body must not hold a strong reference to the stream"
        );
        assert!(
            body.next().await.is_none(),
            "the body must end when the stream's broadcast sender is dropped"
        );
    }

    /// Every item a PCM body yields before time moves on: the WAV header,
    /// the connect burst and the metronome's immediate first tick.
    async fn ready_now(body: &mut AudioStream) -> Vec<Bytes> {
        std::future::poll_fn(|cx| {
            let mut items = Vec::new();
            while let std::task::Poll::Ready(Some(item)) = body.as_mut().poll_next(cx) {
                items.push(item.expect("ok"));
            }
            std::task::Poll::Ready(items)
        })
        .await
    }

    /// One PCM connection assembled as `stream_audio` assembles it (subscribe,
    /// cadence body with the burst, WAV header, delivery record), with a
    /// monitored tap. Returns the body and the tap.
    fn pcm_connection(
        state: &Arc<StreamState>,
        remote: IpAddr,
        burst_ms: u64,
    ) -> (AudioStream, Arc<ConnectionTap>) {
        use crate::stream::MonitorRegistrar;
        let is_resume = state.timing.current_epoch_for(remote).is_some();
        let (prefill, rx) = state.subscribe();
        let guard = Arc::new(LoggingStreamGuard::new(state.id.clone(), remote));
        let tap = Arc::new(ConnectionTap::new(
            state.id.clone(),
            remote,
            Instant::now(),
            AudioCodec::Pcm,
            &state.audio_format,
            Arc::clone(&guard),
            true,
        ));
        let (registrar, _registrations) = MonitorRegistrar::channel();
        let hook = EpochHook::new(Arc::downgrade(state), Instant::now(), remote)
            .with_monitor(Arc::clone(&tap), registrar);
        let cadence = pcm_cadence_stream(
            state,
            burst_ms,
            prefill,
            rx,
            Arc::clone(&guard),
            Some(hook),
            Some(&tap),
            remote,
            is_resume,
        );
        let format = state.audio_format;
        let header = create_wav_header(format.sample_rate, format.channels, format.bits_per_sample);
        let body =
            futures::StreamExt::chain(futures::stream::once(async move { Ok(header) }), cadence);
        let body: AudioStream = Box::pin(with_delivery_record(body, guard, Arc::clone(&tap)));
        (body, tap)
    }

    /// Pushes frames `from..to`, each a 10 ms PCM frame filled with its
    /// index, and returns their capture times.
    fn push_tagged(state: &StreamState, from: u8, to: u8) -> Vec<Instant> {
        (from..to)
            .map(|i| {
                state.push_frame(Bytes::from(vec![i; state.audio_format.frame_bytes(10)]));
                Instant::now()
            })
            .collect()
    }

    /// A speaker's first connection and its reconnect each get the full
    /// connect burst ahead of real-time pacing, each epoch is anchored to that
    /// connection's first burst frame, and the delivered-audio count the
    /// speaker monitor reads its reserve from includes the burst.
    #[tokio::test(start_paused = true)]
    async fn pcm_connection_and_its_reconnect_each_get_the_burst() {
        let state = Arc::new(StreamState::new(
            "pcm-stream".to_string(),
            AudioCodec::Pcm,
            AudioFormat::default(),
            crate::protocol_constants::pcm_ring_frames(10),
            64,
            200,
            10,
        ));
        let _keepalive = state.tx.subscribe();
        let remote = ip("192.168.1.50");
        push_tagged(&state, 0, 100);

        // First connection: 100 frames in the ring, 50 burst (30..80), 20
        // queued (80..100), the first of which goes out on the first tick.
        let (mut body, tap) = pcm_connection(&state, remote, 500);
        let items = ready_now(&mut body).await;
        assert_eq!(items.len(), 1 + 50 + 1, "header, burst and first tick");
        assert_eq!(items[0].len(), 44, "the WAV header comes first");
        let tags: Vec<u8> = items[1..].iter().map(|f| f[0]).collect();
        assert_eq!(
            tags,
            (30..81).collect::<Vec<u8>>(),
            "in order, no gap or repeat"
        );
        assert_eq!(
            tap.delivered_ms(),
            Some(510),
            "the burst counts as delivered"
        );
        let first = state.timing.current_epoch_for(remote).expect("epoch");
        assert_eq!(tap.epoch().map(|e| e.id), Some(first.id));
        drop(body);
        drop(tap);

        // The speaker reconnects (a resume: it already has an epoch) after 20
        // more frames. It gets the burst again, from the newest frames.
        let times = push_tagged(&state, 100, 120);
        assert!(state.timing.current_epoch_for(remote).is_some());
        let (prefill_first, _rx) = state.subscribe();
        let first_burst_at = prefill_first[prefill_first.len() - 70].captured_at;
        assert!(first_burst_at < times[0]);

        let (mut body, tap) = pcm_connection(&state, remote, 500);
        let items = ready_now(&mut body).await;
        assert_eq!(items.len(), 1 + 50 + 1);
        let tags: Vec<u8> = items[1..].iter().map(|f| f[0]).collect();
        assert_eq!(tags, (50..101).collect::<Vec<u8>>());
        assert_eq!(tap.delivered_ms(), Some(510));
        let second = state.timing.current_epoch_for(remote).expect("epoch");
        assert!(second.id > first.id, "the reconnect starts its own epoch");
        assert_eq!(second.audio_epoch, first_burst_at);
    }

    /// A first connection waits until the ring holds the jitter buffer plus
    /// the burst, allowing for how long the stream has already been running,
    /// and never less than the jitter buffer.
    #[test]
    fn pcm_prefill_delay_fills_the_ring_for_jitter_and_burst() {
        let ms = Duration::from_millis;
        assert_eq!(pcm_prefill_delay(200, 500, Some(ms(100))), ms(600));
        assert_eq!(pcm_prefill_delay(200, 500, Some(ms(650))), ms(200));
        assert_eq!(pcm_prefill_delay(200, 500, Some(ms(5000))), ms(200));
        assert_eq!(pcm_prefill_delay(200, 500, None), ms(700));
        assert_eq!(
            pcm_prefill_delay(200, 0, Some(ms(10))),
            ms(200),
            "burst off"
        );
        assert_eq!(pcm_prefill_delay(0, 0, None), Duration::ZERO);
    }

    /// The wait is not capped: it follows the smoothing and the configured
    /// head start up to the head start's 2000 ms maximum, so a field test
    /// can find out what a speaker accepts.
    #[test]
    fn prefill_wait_follows_smoothing_and_head_start_up_to_2000ms() {
        let ms = Duration::from_millis;
        assert_eq!(pcm_prefill_delay(200, 1000, Some(ms(100))), ms(1100));
        assert_eq!(pcm_prefill_delay(300, 2000, Some(ms(100))), ms(2200));
        assert_eq!(pcm_prefill_delay(1000, 2000, None), ms(3000));
        assert_eq!(pcm_prefill_delay(300, 2000, Some(ms(4000))), ms(300));
    }

    /// The tap records the head start the ring allowed beside the one
    /// configured: all of it with a full ring, only what the ring held
    /// beyond the jitter buffer otherwise.
    #[tokio::test(start_paused = true)]
    async fn head_start_recorded_is_what_the_ring_allowed() {
        let state = Arc::new(StreamState::new(
            "pcm-stream".to_string(),
            AudioCodec::Pcm,
            AudioFormat::default(),
            crate::protocol_constants::pcm_ring_frames(10),
            64,
            200,
            10,
        ));
        let _keepalive = state.tx.subscribe();
        // 45 frames: 20 for the jitter buffer, 25 (250 ms) for the burst.
        push_tagged(&state, 0, 45);
        let (_body, tap) = pcm_connection(&state, ip("192.168.1.50"), 500);
        let head_start = tap.head_start().expect("recorded");
        assert_eq!(head_start, HeadStart::new(250, 500));
        assert!(!head_start.is_full());

        push_tagged(&state, 45, 100);
        let (_body, tap) = pcm_connection(&state, ip("192.168.1.51"), 500);
        let head_start = tap.head_start().expect("recorded");
        assert_eq!(head_start, HeadStart::new(500, 500));
        assert!(head_start.is_full());

        let (_body, tap) = pcm_connection(&state, ip("192.168.1.52"), 0);
        assert_eq!(tap.head_start(), Some(HeadStart::new(0, 0)));
    }

    /// A speaker fetching 100 ms after the stream's first frame, as a fresh
    /// cast's first GET does, still gets the whole burst: the prefill delay
    /// waits for the ring to hold it as well as the jitter buffer.
    #[tokio::test(start_paused = true)]
    async fn first_connection_soon_after_the_first_frame_gets_the_full_burst() {
        let state = Arc::new(StreamState::new(
            "pcm-stream".to_string(),
            AudioCodec::Pcm,
            AudioFormat::default(),
            crate::protocol_constants::pcm_ring_frames(10),
            64,
            200,
            10,
        ));
        let _keepalive = state.tx.subscribe();
        let producer_state = Arc::clone(&state);
        let producer = tokio::spawn(async move {
            let mut ticks = tokio::time::interval(Duration::from_millis(10));
            for i in 0..=255u8 {
                ticks.tick().await;
                push_tagged(&producer_state, i, i + 1);
            }
        });
        tokio::task::yield_now().await;
        let first_frame = tokio::time::Instant::now();

        tokio::time::sleep(Duration::from_millis(100)).await;
        let delay = pcm_prefill_delay(200, 500, Some(first_frame.elapsed()));
        assert_eq!(delay, Duration::from_millis(600));
        tokio::time::sleep(delay).await;

        let (mut body, tap) = pcm_connection(&state, ip("192.168.1.50"), 500);
        let items = ready_now(&mut body).await;
        assert_eq!(
            items.len(),
            1 + 50 + 1,
            "header, the whole burst and first tick"
        );
        assert_eq!(tap.delivered_ms(), Some(510));
        producer.abort();
    }

    /// Dropping the body marks it closed, which stops the speaker monitor
    /// reading a socket handle that may be reused.
    #[test]
    fn dropping_the_body_marks_it_closed() {
        let guard = Arc::new(LoggingStreamGuard::new("s".into(), test_ip()));
        let body = with_delivery_record(futures::stream::empty(), Arc::clone(&guard), ());
        assert!(!guard.body_closed());
        drop(body);
        assert!(guard.body_closed());
    }

    /// Without the burst a connection starts exactly as before: one frame
    /// ahead of real time.
    #[tokio::test(start_paused = true)]
    async fn pcm_connection_without_burst_starts_one_frame_ahead() {
        let state = Arc::new(StreamState::new(
            "pcm-stream".to_string(),
            AudioCodec::Pcm,
            AudioFormat::default(),
            crate::protocol_constants::pcm_ring_frames(10),
            64,
            200,
            10,
        ));
        let _keepalive = state.tx.subscribe();
        push_tagged(&state, 0, 100);
        let (mut body, tap) = pcm_connection(&state, ip("192.168.1.50"), 0);
        let items = ready_now(&mut body).await;
        assert_eq!(items.len(), 2, "header and first tick");
        assert_eq!(items[1][0], 80);
        assert_eq!(tap.delivered_ms(), Some(10));
    }
}
