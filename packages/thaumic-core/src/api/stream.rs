//! Audio streaming handler.
//!
//! Separated from REST handlers due to its distinct concerns:
//! codec-specific pipeline construction, prefill delays, epoch
//! tracking, ICY metadata injection, and WAV header generation.
//!
//! Runtime context: In the desktop app, this handler (and its cadence metronome)
//! runs on the dedicated `StreamingRuntime` high-priority threads — inherited
//! via `streaming_runtime.spawn()` in the Tauri API layer.

use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::Arc;
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

use crate::api::AppState;
use crate::error::{ThaumicError, ThaumicResult};
use crate::protocol_constants::{
    APP_NAME, ICY_METAINT, MAX_CADENCE_QUEUE_SIZE, WAV_STREAM_SIZE_MAX,
};
use crate::stream::{
    create_wav_header, create_wav_stream_with_cadence, lagged_error, AudioCodec,
    IcyMetadataInjector, LoggingStreamGuard,
};

/// Boxed stream type for audio data.
type AudioStream = Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>;

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
    // new speakers as resumes after the first speaker connects.
    let is_resume = stream_state.timing.current_epoch_for(remote_ip).is_some();

    // Upfront buffering delay for PCM streams BEFORE subscribing.
    // This lets the ring buffer accumulate more frames. Subscribing after
    // ensures the broadcast receiver doesn't fill up during the delay.
    // Delay matches streaming_buffer_ms so cadence queue starts full.
    //
    // SKIP on resume: Sonos closes the connection within milliseconds if we delay.
    // The buffer already has frames from before the pause, so no delay is needed.
    let prefill_delay_ms = stream_state.streaming_buffer_ms;
    if stream_state.codec == AudioCodec::Pcm && prefill_delay_ms > 0 && !is_resume {
        log::debug!(
            "[Stream] Applying {}ms prefill delay for PCM stream",
            prefill_delay_ms
        );
        tokio::time::sleep(Duration::from_millis(prefill_delay_ms)).await;
    } else if is_resume && stream_state.codec == AudioCodec::Pcm {
        log::info!(
            "[Stream] Skipping {}ms prefill delay on resume for {}",
            prefill_delay_ms,
            remote_ip
        );

        // Delegate playback control to coordinator (SoC: HTTP serves audio, coordinator controls playback).
        // Fire-and-forget: spawn so we don't block the HTTP response.
        let coordinator = Arc::clone(&state.stream_coordinator);
        let ip = remote_ip.to_string();
        tokio::spawn(async move {
            coordinator.on_http_resume(&ip).await;
        });
    }

    // Capture connected_at AFTER prefill delay so latency metrics
    // reflect actual transport latency, not intentional buffering.
    let connected_at = Instant::now();

    // Subscribe AFTER delay to get fresh prefill snapshot and avoid rx backlog
    let (epoch_candidate, prefill_frames, rx) = stream_state.subscribe();

    log::debug!(
        "[Stream] Client {} connected to stream {}, sending {} prefill frames",
        remote_ip,
        id,
        prefill_frames.len()
    );

    // Create logging guard early so we can pass it to the cadence stream for internal tracking.
    // Uses Arc so it can be shared between cadence stream and final frame recording.
    let guard = Arc::new(LoggingStreamGuard::new(id.to_string(), remote_ip));

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
        // PCM: fixed-cadence streaming with queue buffer and silence injection.
        // Prefill frames are pre-populated in the queue to eliminate handoff gap.
        let frame_duration_ms = stream_state.frame_duration_ms;
        let silence_frame = stream_state.audio_format.silence_frame(frame_duration_ms);

        // Calculate queue size from streaming buffer (ceil division)
        // queue_size = ceil(buffer_ms / frame_ms), clamped to [1, MAX_CADENCE_QUEUE_SIZE]
        let queue_size = stream_state
            .streaming_buffer_ms
            .div_ceil(frame_duration_ms as u64) as usize;
        let queue_size = queue_size.clamp(1, MAX_CADENCE_QUEUE_SIZE);

        Box::pin(create_wav_stream_with_cadence(
            rx,
            silence_frame,
            Arc::clone(&guard),
            queue_size,
            frame_duration_ms,
            stream_state.audio_format,
            prefill_frames,
            Some((
                Arc::clone(&stream_state),
                epoch_candidate,
                connected_at,
                remote_ip,
            )),
        ))
    } else {
        // Compressed codecs: no silence injection, chain prefill before live
        let prefill_stream = futures::stream::iter(prefill_frames.into_iter().map(Ok));
        let live_stream = BroadcastStream::new(rx).map(|res| match res {
            Ok(frame) => Ok(frame),
            Err(BroadcastStreamRecvError::Lagged(n)) => Err(lagged_error(n)),
        });
        let raw_stream = futures::StreamExt::chain(prefill_stream, live_stream);

        // Fire epoch on first non-empty frame (compressed codecs never inject silence)
        let epoch_hook = Some((
            Arc::clone(&stream_state),
            epoch_candidate,
            connected_at,
            remote_ip,
        ));
        Box::pin(
            raw_stream.scan(epoch_hook, |hook, item: Result<Bytes, std::io::Error>| {
                if let Some((stream_state, epoch_candidate, connected_at, remote_ip)) = hook.take()
                {
                    if let Ok(ref frame) = item {
                        if !frame.is_empty() {
                            stream_state.timing.start_new_epoch(
                                epoch_candidate,
                                connected_at,
                                remote_ip,
                            );
                        } else {
                            *hook = Some((stream_state, epoch_candidate, connected_at, remote_ip));
                        }
                    } else {
                        *hook = Some((stream_state, epoch_candidate, connected_at, remote_ip));
                    }
                }
                futures::future::ready(Some(item))
            }),
        )
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
        let stream_ref = Arc::clone(&stream_state);
        let mut injector = IcyMetadataInjector::new();

        Box::pin(combined_stream.map(move |res| {
            let chunk = res?;
            let metadata = stream_ref.metadata.read();
            Ok::<Bytes, std::io::Error>(injector.inject(chunk.as_ref(), &metadata))
        }))
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
    // The guard logs summary stats on drop when the stream ends.
    let guard_for_frames = Arc::clone(&guard);
    let final_stream: AudioStream =
        Box::pin(inner_stream.map(move |res: Result<Bytes, std::io::Error>| {
            match &res {
                Ok(_) => guard_for_frames.record_frame(),
                Err(e) => guard_for_frames.record_error(&e.to_string()),
            }
            res
        }));

    builder
        .body(Body::from_stream(final_stream))
        .map_err(|e| ThaumicError::Internal(e.to_string()))
}
