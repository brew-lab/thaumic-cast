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

use crate::api::AppState;
use crate::error::{ThaumicError, ThaumicResult};
use crate::protocol_constants::{APP_NAME, ICY_METAINT, WAV_STREAM_SIZE_MAX};
use crate::stream::{
    create_wav_header, create_wav_stream_with_cadence, lagged_error, AudioCodec, CadenceConfig,
    IcyMetadataInjector, LoggingStreamGuard, StreamState,
};

/// A single item of an audio body stream.
type FrameResult = Result<Bytes, std::io::Error>;

/// Boxed stream type for audio data.
type AudioStream = Pin<Box<dyn Stream<Item = FrameResult> + Send>>;

/// One-shot epoch hook: the stream to time, its epoch candidate, the moment the
/// client connected, and the client address.
///
/// Holds a [`Weak`] reference on purpose. The response body outlives the handler,
/// so a strong `Arc` here would keep the [`StreamState`] — and with it the
/// broadcast sender — alive after the coordinator removed the stream, leaving the
/// connection streaming to a stream that no longer exists.
type EpochHook = (Weak<StreamState>, Option<Instant>, Instant, IpAddr);

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
    // Lets the ring buffer accumulate frames so the prefill snapshot returned
    // by `subscribe()` has real audio — otherwise the cadence stream would
    // begin emitting silence frames as its first body bytes, which Sonos has
    // been observed to treat as a stalled stream and respond to with a
    // transport-state transition to Stopped.
    //
    // Delay matches the user-configured `jitter_buffer_ms`, which is already
    // validated against `MAX_JITTER_BUFFER_MS` at the protocol layer.
    //
    // SKIP on resume: Sonos closes the connection within milliseconds if we
    // delay. The ring buffer already has frames from before the pause.
    let prefill_delay_ms = stream_state.jitter_buffer_ms;
    if stream_state.codec == AudioCodec::Pcm && prefill_delay_ms > 0 && !is_resume {
        log::debug!(
            "[Stream] Applying {}ms prefill delay for PCM stream",
            prefill_delay_ms
        );
        tokio::time::sleep(Duration::from_millis(prefill_delay_ms)).await;
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

    // One-shot epoch hook for whichever pipeline is built below.
    let epoch_hook: EpochHook = (
        Arc::downgrade(&stream_state),
        epoch_candidate,
        connected_at,
        remote_ip,
    );

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
        // does not exceed the intended buffer depth.
        let frame_duration_ms = stream_state.frame_duration_ms;
        let silence_frame = stream_state.audio_format.silence_frame(frame_duration_ms);

        Box::pin(create_wav_stream_with_cadence(
            rx,
            Arc::clone(&guard),
            CadenceConfig::new(
                silence_frame,
                stream_state.jitter_buffer_ms,
                frame_duration_ms,
                stream_state.audio_format,
                prefill_frames,
            ),
            Some(Arc::downgrade(&stream_state)),
            Some(epoch_hook),
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
        Box::pin(with_epoch_hook(raw_stream, epoch_hook))
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
    // The guard logs summary stats on drop when the stream ends.
    let guard_for_frames = Arc::clone(&guard);
    let final_stream: AudioStream =
        Box::pin(inner_stream.map(move |res: Result<Bytes, std::io::Error>| {
            match &res {
                Ok(bytes) => {
                    guard_for_frames.record_frame();
                    guard_for_frames
                        .bytes_sent
                        .fetch_add(bytes.len() as u64, Ordering::Relaxed);
                }
                Err(e) => guard_for_frames.record_error(&e.to_string()),
            }
            res
        }));

    builder
        .body(Body::from_stream(final_stream))
        .map_err(|e| ThaumicError::Internal(e.to_string()))
}

/// Starts a new playback epoch on the first real (non-empty) frame, then forgets
/// the hook.
///
/// Errors and empty frames leave the hook armed: a live stream that has not
/// produced audio yet must still be timed from its first real frame.
///
/// If the [`Weak`] no longer upgrades the stream has been removed, so there is
/// nothing to time and the hook is dropped. The body itself ends on its own once
/// the broadcast sender goes with the stream.
fn with_epoch_hook<S>(stream: S, hook: EpochHook) -> impl Stream<Item = FrameResult> + Send
where
    S: Stream<Item = FrameResult> + Send,
{
    stream.scan(Some(hook), |hook, item: FrameResult| {
        if let Some((weak_state, epoch_candidate, connected_at, remote_ip)) = hook.take() {
            let is_audio = item.as_ref().is_ok_and(|frame| !frame.is_empty());
            match weak_state.upgrade() {
                Some(stream_state) if is_audio => {
                    stream_state
                        .timing
                        .start_new_epoch(epoch_candidate, connected_at, remote_ip);
                }
                // Alive but nothing to time yet - stay armed.
                Some(_) => *hook = Some((weak_state, epoch_candidate, connected_at, remote_ip)),
                // Stream gone - drop the hook.
                None => {}
            }
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
        (Arc::downgrade(state), None, Instant::now(), test_ip())
    }

    #[tokio::test]
    async fn epoch_hook_stays_armed_until_the_first_real_frame() {
        let state = test_stream_state();
        let source = futures::stream::iter(vec![
            Err(std::io::Error::other("transient")),
            Ok(Bytes::new()),
            Ok(Bytes::from_static(b"audio")),
        ]);
        let mut body = Box::pin(with_epoch_hook(source, hook_for(&state)));

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
    async fn epoch_hook_does_not_keep_the_stream_alive() {
        let state = test_stream_state();
        let weak = Arc::downgrade(&state);
        // Never yields audio, so the hook is still armed when the stream is removed.
        let source = futures::stream::iter(vec![Ok(Bytes::new()), Ok(Bytes::from_static(b"late"))]);
        let mut body = Box::pin(with_epoch_hook(source, hook_for(&state)));

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
        let (_, _, rx) = state.subscribe();
        let weak = Arc::downgrade(&state);

        let live = BroadcastStream::new(rx).map(|res| match res {
            Ok(frame) => Ok(frame),
            Err(BroadcastStreamRecvError::Lagged(n)) => Err(lagged_error(n)),
        });
        let mut body = Box::pin(with_icy_metadata(
            with_epoch_hook(live, hook_for(&state)),
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
}
