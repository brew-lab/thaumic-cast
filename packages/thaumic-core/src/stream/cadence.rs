//! Fixed-cadence audio streaming with delivery tracking.
//!
//! This module contains the cadence streaming pipeline that maintains real-time
//! audio output regardless of input timing, and the delivery tracking guard that
//! logs stream lifecycle and timing diagnostics.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::{Duration, Instant};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use serde::Serialize;
use tokio::sync::broadcast;
use tokio::time::{interval, Instant as TokioInstant, MissedTickBehavior};

use super::{
    apply_fade_in, create_fade_out_frame, crossfade_samples, extract_last_sample_pair,
    is_crossfade_compatible, AudioFormat, StreamState,
};

/// Threshold for counting delivery gaps (100ms).
/// PCM at 48kHz stereo 16-bit = 192KB/s, so 100ms = ~19KB of audio.
const DELIVERY_GAP_THRESHOLD_MS: u64 = 100;

/// Only log gaps exceeding this threshold to avoid log spam (500ms).
const DELIVERY_GAP_LOG_THRESHOLD_MS: u64 = 500;

/// Creates an IO error for broadcast channel lag.
///
/// Logs a warning and returns a formatted error. Centralizes the handling
/// of `BroadcastStreamRecvError::Lagged` to avoid duplication.
pub fn lagged_error(frames: u64) -> std::io::Error {
    log::warn!(
        "[Stream] Broadcast receiver lagged by {} frames - possible CPU contention",
        frames
    );
    std::io::Error::other(format!("lagged by {} frames", frames))
}

/// Logs a rate-limited warning when the broadcast receiver lags.
fn log_lagged(n: u64, last_log: &mut Option<TokioInstant>, context: &str) {
    let now = TokioInstant::now();
    if last_log.map_or(true, |t| now.duration_since(t).as_secs() >= 1) {
        log::warn!("[Stream] Lagged by {n} frames{context}");
        *last_log = Some(now);
    }
}

/// Statistics from the cadence stream, written once when the stream ends.
pub(crate) struct CadenceStats {
    /// Number of times silence mode was entered.
    pub silence_events: u64,
    /// Total silence frames injected.
    pub silence_frames: u64,
    /// Frames dropped due to cadence queue overflow.
    pub frames_dropped: u64,
}

/// Maximum pipeline snapshots to keep (300 entries × ~1s = ~5 minutes).
const MAX_PIPELINE_SNAPSHOTS: usize = 300;

/// Receive jitter window for a pipeline snapshot.
#[derive(Serialize)]
struct ReceiveWindow {
    frames_received: u64,
    min_gap_ms: u64,
    max_gap_ms: u64,
    gaps_over_threshold: u64,
}

/// Cadence buffer window for a pipeline snapshot.
#[derive(Serialize)]
struct CadenceWindow {
    queue_len: usize,
    silence_events: u64,
    silence_frames: u64,
    drops: u64,
}

/// HTTP delivery window for a pipeline snapshot.
#[derive(Serialize)]
struct DeliveryWindow {
    frames_sent: u64,
    bytes_per_second: u64,
    max_gap_ms: u64,
    gaps_over_threshold: u64,
}

/// Timestamped pipeline health snapshot, captured every ~1s in the cadence loop.
#[derive(Serialize)]
struct PipelineSnapshot {
    elapsed_ms: u64,
    receive: ReceiveWindow,
    cadence: CadenceWindow,
    delivery: DeliveryWindow,
}

/// Wrapper that logs HTTP audio stream lifecycle and tracks delivery timing.
///
/// Delivery gap tracking uses lock-free atomics on the hot path.
/// Cadence-specific statistics (silence, drops) are tracked locally in
/// the cadence stream and written here once at stream end.
pub struct LoggingStreamGuard {
    stream_id: String,
    client_ip: IpAddr,
    /// Monotonic reference for computing delivery timestamps.
    reference_time: Instant,
    frames_sent: AtomicU64,
    /// Elapsed nanos since `reference_time` of the last delivered frame (0 = none).
    last_delivery_nanos: AtomicU64,
    max_gap_ms: AtomicU64,
    gaps_over_threshold: AtomicU64,
    first_error: parking_lot::Mutex<Option<String>>,
    /// Cadence-specific stats, set once when the cadence stream ends.
    cadence_stats: OnceLock<CadenceStats>,
    /// Total bytes delivered to HTTP client (for throughput calculation).
    pub(crate) bytes_sent: AtomicU64,
    /// Per-interval max delivery gap in ms (swapped to 0 on each snapshot).
    interval_max_gap_ms: AtomicU64,
    /// Pipeline timeline, updated periodically by the cadence stream.
    /// Uses Mutex (not OnceLock) because the cadence stream may be dropped
    /// mid-loop when Sonos closes HTTP, before it can write a final value.
    pipeline_timeline: parking_lot::Mutex<VecDeque<PipelineSnapshot>>,
}

impl LoggingStreamGuard {
    /// Creates a new guard that logs stream lifecycle events.
    pub fn new(stream_id: String, client_ip: IpAddr) -> Self {
        log::info!(
            "[Stream] HTTP stream started: stream={}, client={}",
            stream_id,
            client_ip
        );
        Self {
            stream_id,
            client_ip,
            reference_time: Instant::now(),
            frames_sent: AtomicU64::new(0),
            last_delivery_nanos: AtomicU64::new(0),
            max_gap_ms: AtomicU64::new(0),
            gaps_over_threshold: AtomicU64::new(0),
            first_error: parking_lot::Mutex::new(None),
            cadence_stats: OnceLock::new(),
            bytes_sent: AtomicU64::new(0),
            interval_max_gap_ms: AtomicU64::new(0),
            pipeline_timeline: parking_lot::Mutex::new(VecDeque::new()),
        }
    }

    /// Records a frame being delivered to the client (lock-free).
    pub fn record_frame(&self) {
        self.frames_sent.fetch_add(1, Ordering::Relaxed);

        let now_nanos = self.reference_time.elapsed().as_nanos() as u64;
        let prev_nanos = self.last_delivery_nanos.swap(now_nanos, Ordering::Relaxed);

        if prev_nanos > 0 {
            let gap_ms = now_nanos.saturating_sub(prev_nanos) / 1_000_000;

            self.max_gap_ms.fetch_max(gap_ms, Ordering::Relaxed);
            self.interval_max_gap_ms
                .fetch_max(gap_ms, Ordering::Relaxed);

            if gap_ms > DELIVERY_GAP_THRESHOLD_MS {
                self.gaps_over_threshold.fetch_add(1, Ordering::Relaxed);
                // Only log significant gaps to avoid spam; summary captures total count
                if gap_ms > DELIVERY_GAP_LOG_THRESHOLD_MS {
                    log::warn!(
                        "[Stream] Delivery gap detected: stream={}, client={}, gap={}ms",
                        self.stream_id,
                        self.client_ip,
                        gap_ms
                    );
                }
            }
        }
    }

    /// Records the first error encountered during streaming.
    pub fn record_error(&self, err: &str) {
        let mut first = self.first_error.lock();
        if first.is_none() {
            *first = Some(err.to_string());
        }
    }

    /// Stores cadence stream statistics. Called once when the cadence stream ends.
    pub(crate) fn set_cadence_stats(&self, stats: CadenceStats) {
        let _ = self.cadence_stats.set(stats);
    }

    /// Appends a snapshot to the pipeline timeline (called every ~1s from cadence stream).
    fn push_pipeline_snapshot(&self, snapshot: PipelineSnapshot) {
        let mut timeline = self.pipeline_timeline.lock();
        timeline.push_back(snapshot);
        if timeline.len() > MAX_PIPELINE_SNAPSHOTS {
            timeline.pop_front();
        }
    }
}

impl Drop for LoggingStreamGuard {
    fn drop(&mut self) {
        let frames = self.frames_sent.load(Ordering::Relaxed);
        let first_error = self.first_error.get_mut();
        let max_gap_ms = self.max_gap_ms.load(Ordering::Relaxed);
        let gaps_over_threshold = self.gaps_over_threshold.load(Ordering::Relaxed);

        // Calculate time since last frame delivery
        let last_nanos = self.last_delivery_nanos.load(Ordering::Relaxed);
        let final_gap_ms = if last_nanos > 0 {
            let now_nanos = self.reference_time.elapsed().as_nanos() as u64;
            now_nanos.saturating_sub(last_nanos) / 1_000_000
        } else {
            0
        };
        let stalled_suffix = if final_gap_ms > DELIVERY_GAP_LOG_THRESHOLD_MS {
            " (stalled)"
        } else {
            ""
        };

        let cadence = self.cadence_stats.get();

        // Build silence stats string if any silence was injected
        let silence_info = cadence
            .filter(|s| s.silence_events > 0)
            .map(|s| {
                format!(
                    ", silence_events={}, silence_frames={}",
                    s.silence_events, s.silence_frames
                )
            })
            .unwrap_or_default();

        // Build dropped frames string if any frames were dropped
        let dropped_info = cadence
            .filter(|s| s.frames_dropped > 0)
            .map(|s| format!(", frames_dropped={}", s.frames_dropped))
            .unwrap_or_default();

        let timeline = self.pipeline_timeline.lock();
        let timeline_json = if timeline.is_empty() {
            String::new()
        } else {
            serde_json::to_string(&*timeline).unwrap_or_default()
        };
        drop(timeline);
        let timeline_info = if timeline_json.is_empty() {
            String::new()
        } else {
            format!(", pipeline_timeline={}", timeline_json)
        };

        if let Some(ref err) = *first_error {
            log::warn!(
                "[Stream] HTTP stream ended with error{}: stream={}, client={}, frames_sent={}, \
                 max_gap={}ms, gaps_over_{}ms={}, final_gap={}ms{}{}{}, error={}",
                stalled_suffix,
                self.stream_id,
                self.client_ip,
                frames,
                max_gap_ms,
                DELIVERY_GAP_THRESHOLD_MS,
                gaps_over_threshold,
                final_gap_ms,
                silence_info,
                dropped_info,
                timeline_info,
                err
            );
        } else {
            log::info!(
                "[Stream] HTTP stream ended normally{}: stream={}, client={}, frames_sent={}, \
                 max_gap={}ms, gaps_over_{}ms={}, final_gap={}ms{}{}{}",
                stalled_suffix,
                self.stream_id,
                self.client_ip,
                frames,
                max_gap_ms,
                DELIVERY_GAP_THRESHOLD_MS,
                gaps_over_threshold,
                final_gap_ms,
                silence_info,
                dropped_info,
                timeline_info
            );
        }
    }
}

/// Manages crossfade state for smooth audio/silence transitions.
///
/// Tracks the last audio sample pair so that entering silence produces a
/// fade-out frame instead of an abrupt cut, and exiting silence applies a
/// fade-in to the first audio frame.
struct CrossfadeState {
    enabled: bool,
    fade_samples: usize,
    samples_per_frame: usize,
    channels: u16,
    last_sample_pair: Option<(i16, i16)>,
}

impl CrossfadeState {
    fn new(audio_format: &AudioFormat, frame_duration_ms: u32) -> Self {
        let enabled = is_crossfade_compatible(audio_format);
        if !enabled {
            log::warn!(
                "[Stream] Crossfade disabled: requires 16-bit PCM, got {}-bit",
                audio_format.bits_per_sample
            );
        }
        Self {
            enabled,
            fade_samples: crossfade_samples(audio_format.sample_rate),
            samples_per_frame: audio_format.frame_samples(frame_duration_ms),
            channels: audio_format.channels,
            last_sample_pair: None,
        }
    }

    /// Updates tracking with the last sample pair from a real audio frame.
    fn track_frame(&mut self, frame: &Bytes) {
        if self.enabled {
            self.last_sample_pair = extract_last_sample_pair(frame, self.channels);
        }
    }

    /// Applies fade-in to a frame following silence. Returns the frame
    /// unchanged when crossfade is disabled.
    fn maybe_fade_in(&self, frame: Bytes) -> Bytes {
        if self.enabled {
            let mut faded = frame.to_vec();
            apply_fade_in(&mut faded, self.channels, self.fade_samples);
            Bytes::from(faded)
        } else {
            frame
        }
    }

    /// Generates the first silence frame: a fade-out when last samples are
    /// available, otherwise plain silence.
    fn enter_silence(&mut self, silence_frame: &Bytes) -> Bytes {
        if self.enabled {
            if let Some((left, right)) = self.last_sample_pair.take() {
                return create_fade_out_frame(
                    left,
                    right,
                    self.channels,
                    self.fade_samples,
                    self.samples_per_frame,
                );
            }
        }
        silence_frame.clone()
    }
}

/// Configuration for the cadence streaming pipeline.
pub struct CadenceConfig {
    /// Silence frame emitted when no audio is queued.
    pub silence_frame: Bytes,
    /// Maximum number of frames to buffer.
    pub queue_size: usize,
    /// Duration of each output frame in milliseconds.
    pub frame_duration_ms: u32,
    /// Audio format (sample rate, channels, bit depth).
    pub audio_format: AudioFormat,
    /// Initial frames pre-populated in the queue to eliminate handoff gap.
    pub prefill_frames: Vec<Bytes>,
}

/// Creates a WAV audio stream with fixed-cadence output and crossfade on silence transitions.
///
/// Maintains real-time cadence regardless of input timing:
/// - Incoming frames are queued (bounded to `queue_size`)
/// - Metronome ticks every `frame_duration_ms`
/// - On each tick: send queued frame if available, else send silence
///
/// Crossfade on silence transitions:
/// - When entering silence: emits a fade-out frame from the last audio sample to zero
/// - When exiting silence: applies fade-in to the first audio frame
///
/// Silence and overflow statistics are tracked locally and written to the
/// guard once at stream end via `set_cadence_stats()`.
///
/// Epoch tracking (optional): when `epoch_hook` is `Some`, the stream fires
/// `start_new_epoch` on the first real audio frame, then discards the hook.
///
/// This ensures Sonos always receives continuous data with smooth transitions,
/// eliminating pops from abrupt audio/silence boundaries.
pub fn create_wav_stream_with_cadence(
    mut rx: broadcast::Receiver<Bytes>,
    guard: Arc<LoggingStreamGuard>,
    config: CadenceConfig,
    stream_state: Option<std::sync::Weak<StreamState>>,
    epoch_hook: Option<(Arc<StreamState>, Option<Instant>, Instant, IpAddr)>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> {
    stream! {
        let CadenceConfig {
            silence_frame,
            queue_size,
            frame_duration_ms,
            audio_format,
            prefill_frames,
        } = config;
        let cadence_duration = Duration::from_millis(frame_duration_ms as u64);

        // Pre-populate queue with prefill frames to eliminate handoff gap.
        // This ensures the first tick immediately yields audio.
        let mut queue: VecDeque<Bytes> = VecDeque::with_capacity(queue_size.max(prefill_frames.len()));
        for frame in prefill_frames {
            queue.push_back(frame);
        }

        // Fire first tick immediately to get audio flowing before Sonos times out.
        // On resume, Sonos closes the connection within milliseconds if no audio arrives.
        let mut metronome = interval(cadence_duration);
        metronome.set_missed_tick_behavior(MissedTickBehavior::Burst);

        let mut rx_closed = false;
        let mut in_silence = false;
        let mut silence_start: Option<TokioInstant> = None;

        // Cadence-specific counters (written to guard at stream end)
        let mut silence_events: u64 = 0;
        let mut silence_frames: u64 = 0;
        let mut frames_dropped: u64 = 0;

        let mut crossfade = CrossfadeState::new(&audio_format, frame_duration_ms);

        // Rate-limit lagged warnings (max once per second)
        let mut last_lagged_log: Option<TokioInstant> = None;

        // One-shot epoch hook: fires on the first real audio frame, then consumed
        let mut epoch_hook = epoch_hook;

        // Pipeline snapshot state
        let mut tick_count: u64 = 0;
        let mut prev_delivery_frames: u64 = 0;
        let mut prev_delivery_bytes: u64 = 0;
        let mut prev_delivery_gaps: u64 = 0;
        let mut prev_snapshot_ms: u64 = 0;

        loop {
            // Exit when channel closed AND queue drained
            if rx_closed && queue.is_empty() {
                break;
            }

            tokio::select! {
                biased;

                // PRIORITY 1: Metronome tick - MUST emit something every frame_duration_ms
                _ = metronome.tick() => {
                    if let Some(frame) = queue.pop_front() {
                        // Real audio available
                        let was_in_silence = in_silence;
                        if in_silence {
                            if let Some(start) = silence_start.take() {
                                log::info!(
                                    "[Stream] Exiting silence (cadence) after {:.1}s",
                                    start.elapsed().as_secs_f32()
                                );
                            }
                            in_silence = false;
                        }

                        crossfade.track_frame(&frame);

                        // Fire epoch hook on first real audio frame
                        if let Some((stream_state, epoch_candidate, connected_at, remote_ip)) = epoch_hook.take() {
                            stream_state.timing.start_new_epoch(
                                epoch_candidate,
                                connected_at,
                                remote_ip,
                            );
                        }

                        if was_in_silence {
                            yield Ok(crossfade.maybe_fade_in(frame));
                        } else {
                            yield Ok(frame);
                        }
                    } else if !rx_closed {
                        // No frame available, emit silence
                        if !in_silence {
                            log::info!("[Stream] Entering silence (cadence) - queue empty");
                            in_silence = true;
                            silence_start = Some(TokioInstant::now());
                            silence_events += 1;
                            silence_frames += 1;
                            yield Ok(crossfade.enter_silence(&silence_frame));
                        } else {
                            silence_frames += 1;
                            yield Ok(silence_frame.clone());
                        }
                    }
                    // If rx_closed and queue empty, don't yield - loop will break

                    // Drain any pending frames from rx into queue after emitting.
                    // This prevents starvation: with biased select, ticks always win,
                    // so without this drain, frames could pile up in rx while we
                    // emit silence (especially during recovery from underflow).
                    if !rx_closed {
                        loop {
                            match rx.try_recv() {
                                Ok(frame) => {
                                    if queue.len() >= queue_size {
                                        queue.pop_front();
                                        frames_dropped += 1;
                                    }
                                    queue.push_back(frame);
                                }
                                Err(broadcast::error::TryRecvError::Empty) => break,
                                Err(broadcast::error::TryRecvError::Lagged(n)) => {
                                    log_lagged(n, &mut last_lagged_log, " (during drain)");
                                }
                                Err(broadcast::error::TryRecvError::Closed) => {
                                    rx_closed = true;
                                    log::debug!("[Stream] Channel closed, draining {} queued frames", queue.len());
                                    break;
                                }
                            }
                        }
                    }

                    // Pipeline snapshot every ~50 ticks (~1s at 20ms cadence)
                    tick_count += 1;
                    if tick_count % 50 == 0 {
                        let elapsed_ms = guard.reference_time.elapsed().as_millis() as u64;

                        // Receive window: snapshot and reset from StreamState
                        // Uses Weak ref - if StreamState was dropped (channel closing), skip
                        let receive = if let Some(ss) = stream_state.as_ref().and_then(|w| w.upgrade()) {
                            let rs = ss.snapshot_and_reset_receive_stats();
                            ReceiveWindow {
                                frames_received: rs.frames_received,
                                min_gap_ms: if rs.min_gap_ms == u64::MAX { 0 } else { rs.min_gap_ms },
                                max_gap_ms: rs.max_gap_ms,
                                gaps_over_threshold: rs.gaps_over_threshold,
                            }
                        } else {
                            ReceiveWindow { frames_received: 0, min_gap_ms: 0, max_gap_ms: 0, gaps_over_threshold: 0 }
                        };

                        // Cadence window: current counters (cumulative, not reset)
                        let cadence_window = CadenceWindow {
                            queue_len: queue.len(),
                            silence_events,
                            silence_frames,
                            drops: frames_dropped,
                        };

                        // Delivery window: deltas from guard atomics
                        let cur_frames = guard.frames_sent.load(Ordering::Relaxed);
                        let cur_bytes = guard.bytes_sent.load(Ordering::Relaxed);
                        let cur_gaps = guard.gaps_over_threshold.load(Ordering::Relaxed);
                        let interval_max = guard.interval_max_gap_ms.swap(0, Ordering::Relaxed);

                        let delta_bytes = cur_bytes.saturating_sub(prev_delivery_bytes);
                        let interval_ms = elapsed_ms.saturating_sub(prev_snapshot_ms);
                        let bytes_per_second = if interval_ms > 0 { delta_bytes * 1000 / interval_ms } else { 0 };

                        let delivery = DeliveryWindow {
                            frames_sent: cur_frames.saturating_sub(prev_delivery_frames),
                            bytes_per_second,
                            max_gap_ms: interval_max,
                            gaps_over_threshold: cur_gaps.saturating_sub(prev_delivery_gaps),
                        };

                        prev_delivery_frames = cur_frames;
                        prev_delivery_bytes = cur_bytes;
                        prev_delivery_gaps = cur_gaps;
                        prev_snapshot_ms = elapsed_ms;

                        guard.push_pipeline_snapshot(PipelineSnapshot {
                            elapsed_ms,
                            receive,
                            cadence: cadence_window,
                            delivery,
                        });
                    }
                }

                // PRIORITY 2: Receive frames into queue (when channel open and tick not ready)
                result = rx.recv(), if !rx_closed => {
                    match result {
                        Ok(frame) => {
                            if queue.len() >= queue_size {
                                // Queue full - drop oldest to maintain bounded latency
                                queue.pop_front();
                                frames_dropped += 1;
                                log::trace!("[Stream] Queue full, dropped oldest frame");
                            }
                            queue.push_back(frame);
                        }
                        Err(broadcast::error::RecvError::Lagged(n)) => {
                            log_lagged(n, &mut last_lagged_log, "");
                        }
                        Err(broadcast::error::RecvError::Closed) => {
                            rx_closed = true;
                            log::debug!("[Stream] Channel closed, draining {} queued frames", queue.len());
                        }
                    }
                }
            }
        }

        guard.set_cadence_stats(CadenceStats {
            silence_events,
            silence_frames,
            frames_dropped,
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use futures::stream::Stream;
    use futures::StreamExt;
    use std::future::poll_fn;
    use std::net::Ipv4Addr;
    use std::pin::Pin;
    use std::task::Poll;
    use tokio::time::{self, Duration};

    use crate::protocol_constants::SILENCE_FRAME_DURATION_MS;

    /// Default queue size for tests (10 frames = 200ms at 20ms/frame).
    const TEST_QUEUE_SIZE: usize = 10;

    /// Test silence frame for assertions.
    fn test_silence_frame() -> Bytes {
        Bytes::from_static(&[0u8; 64])
    }

    /// Test audio frame for assertions.
    fn test_audio_frame() -> Bytes {
        Bytes::from_static(&[1u8; 64])
    }

    /// Creates a test guard for cadence stream tests.
    fn test_guard() -> Arc<LoggingStreamGuard> {
        Arc::new(LoggingStreamGuard::new(
            "test-stream".to_string(),
            IpAddr::V4(Ipv4Addr::LOCALHOST),
        ))
    }

    /// Creates a default CadenceConfig for tests.
    fn test_config() -> CadenceConfig {
        CadenceConfig {
            silence_frame: test_silence_frame(),
            queue_size: TEST_QUEUE_SIZE,
            frame_duration_ms: SILENCE_FRAME_DURATION_MS,
            audio_format: test_audio_format(),
            prefill_frames: vec![],
        }
    }

    /// Creates a test audio format for cadence stream tests.
    fn test_audio_format() -> AudioFormat {
        AudioFormat::new(48000, 2, 16)
    }

    /// Polls the stream once to register internal timers, then advances time.
    ///
    /// With `start_paused = true`, timers must be polled before `time::advance`
    /// will affect them. This helper ensures the stream's internal select! loop
    /// registers its timers before we manipulate time.
    async fn poll_and_advance<S>(stream: &mut Pin<&mut S>, duration: Duration)
    where
        S: Stream + ?Sized,
    {
        // Poll stream once to register timers (should return Pending since no data/timeout yet)
        poll_fn(|cx| {
            let _ = stream.as_mut().poll_next(cx);
            Poll::Ready(())
        })
        .await;

        time::advance(duration).await;
    }

    /// Drains a cadence stream to completion by advancing time and polling.
    ///
    /// The channel must be closed (tx dropped) before calling this, so the
    /// stream can detect closure and terminate.
    async fn drain_to_end<S>(stream: &mut Pin<&mut S>)
    where
        S: Stream + ?Sized,
    {
        for _ in 0..50 {
            time::advance(Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64)).await;
            let done = poll_fn(|cx| match stream.as_mut().poll_next(cx) {
                Poll::Ready(None) => Poll::Ready(true),
                _ => Poll::Ready(false),
            })
            .await;
            if done {
                break;
            }
        }
    }

    #[tokio::test(start_paused = true)]
    async fn emits_frames_at_cadence() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let audio = test_audio_frame();
        let guard = test_guard();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Queue some frames before the first tick
        tx.send(audio.clone()).expect("send should succeed");
        tx.send(audio.clone()).expect("send should succeed");

        // Poll to register metronome, advance one tick (20ms)
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        // Should get first audio frame (may have fade-in applied)
        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            !frame.iter().all(|&b| b == 0),
            "expected audio frame at cadence tick"
        );

        // Advance another tick
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        // Should get second audio frame
        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert_eq!(frame, audio, "expected second audio frame at cadence tick");

        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn fills_gaps_with_silence() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let guard = test_guard();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Don't send any frames - queue will be empty

        // Poll to register metronome, advance one tick
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        // Should get silence frame since queue is empty
        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            frame.iter().all(|&b| b == 0),
            "expected silence frame when queue is empty"
        );

        // Another tick should also yield silence
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            frame.iter().all(|&b| b == 0),
            "expected silence frame on continued empty queue"
        );

        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn queue_drains_at_cadence() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let guard = test_guard();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Queue 3 frames as a burst
        for i in 0..3 {
            tx.send(Bytes::from(vec![i; 64]))
                .expect("send should succeed");
        }

        // Each tick should drain one frame
        for expected_byte in 0..3u8 {
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;

            let frame = stream.next().await.expect("stream should yield");
            let bytes = frame.expect("should be Ok");
            assert_eq!(
                bytes[0], expected_byte,
                "frames should drain in order at cadence"
            );
        }

        // Queue is now empty, next tick should yield silence
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        // Queue empty → silence/keepalive (may be a crossfade fade-out frame)
        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            !frame.is_empty(),
            "expected non-empty frame after queue drained"
        );

        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn drops_oldest_on_overflow() {
        let (tx, rx) = broadcast::channel::<Bytes>(32);
        let guard = test_guard();
        let guard_for_check = Arc::clone(&guard);

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Send 12 frames (queue_size + 2), should drop 2 oldest
        for i in 0..12u8 {
            tx.send(Bytes::from(vec![i; 64]))
                .expect("send should succeed");
        }

        // Poll multiple times to ensure frames are received via the rx.recv() branch
        // and overflow logic is triggered
        for _ in 0..15 {
            poll_and_advance(
                &mut stream.as_mut(),
                Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
            )
            .await;
        }

        // Close channel and drain to completion (writes cadence stats)
        drop(tx);
        drain_to_end(&mut stream.as_mut()).await;

        // Verify that exactly 2 frames were dropped
        let stats = guard_for_check
            .cadence_stats
            .get()
            .expect("cadence stats should be set after stream ends");
        assert_eq!(
            stats.frames_dropped, 2,
            "should have dropped 2 oldest frames, dropped {}",
            stats.frames_dropped
        );
    }

    #[tokio::test(start_paused = true)]
    async fn tracks_dropped_frames() {
        let (tx, rx) = broadcast::channel::<Bytes>(32);
        let guard = test_guard();
        let guard_for_check = Arc::clone(&guard);

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Overflow queue by TEST_QUEUE_SIZE + 3 frames
        let overflow_count = 3;
        for i in 0..(TEST_QUEUE_SIZE + overflow_count) as u8 {
            tx.send(Bytes::from(vec![i; 64]))
                .expect("send should succeed");
        }

        // Give time for frames to be received and processed
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        // Consume a frame to ensure internal processing has happened
        let _ = stream.next().await;

        // Close channel and drain to completion (writes cadence stats)
        drop(tx);
        drain_to_end(&mut stream.as_mut()).await;

        // Check the cadence stats - should have recorded dropped frames
        let stats = guard_for_check
            .cadence_stats
            .get()
            .expect("cadence stats should be set after stream ends");
        assert_eq!(
            stats.frames_dropped, overflow_count as u64,
            "guard should track {} dropped frames",
            overflow_count
        );
    }

    #[tokio::test(start_paused = true)]
    async fn drains_queue_on_channel_close() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let guard = test_guard();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Queue some frames
        tx.send(Bytes::from(vec![1; 64]))
            .expect("send should succeed");
        tx.send(Bytes::from(vec![2; 64]))
            .expect("send should succeed");

        // Give time for frames to be queued
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;
        let _ = stream.next().await; // consume first frame

        // Close the channel
        drop(tx);

        // Advance and drain remaining frame
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        // Should still get the queued frame
        let frame = stream
            .next()
            .await
            .expect("stream should yield queued frame");
        let bytes = frame.expect("should be Ok");
        assert_eq!(bytes[0], 2, "should drain remaining queued frame");

        // Now stream should end (channel closed AND queue empty)
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        let frame = stream.next().await;
        assert!(
            frame.is_none(),
            "stream should end when channel closed and queue empty"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn exits_silence_when_frames_arrive() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let audio = test_audio_frame();
        let guard = test_guard();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // First tick with empty queue -> silence
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            frame.iter().all(|&b| b == 0),
            "expected silence when queue empty"
        );

        // Queue a frame
        tx.send(audio.clone()).expect("send should succeed");

        // Next tick should yield audio (exit silence)
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;

        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            !frame.iter().all(|&b| b == 0),
            "expected audio when frame queued after silence"
        );

        drop(tx);
    }
}
