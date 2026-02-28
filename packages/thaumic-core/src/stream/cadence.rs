//! Fixed-cadence audio streaming with delivery tracking.
//!
//! This module contains the cadence streaming pipeline that maintains real-time
//! audio output regardless of input timing, and the delivery tracking guard that
//! logs stream lifecycle and timing diagnostics.

use std::collections::VecDeque;
use std::net::IpAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, OnceLock, Weak};
use std::time::{Duration, Instant};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use serde::Serialize;
use tokio::sync::broadcast;
use tokio::time::{interval, Instant as TokioInstant, MissedTickBehavior};

use crate::protocol_constants::FILL_GATE_TIMEOUT_MULTIPLIER;

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
pub fn create_lagged_io_error(frames: u64) -> std::io::Error {
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

/// Cadence stream statistics: tracked mutably during the loop,
/// then written once to the logging guard when the stream ends.
#[derive(Clone, Copy)]
pub(crate) struct CadenceStats {
    /// Number of times silence mode was entered.
    pub silence_events: u64,
    /// Total silence frames injected.
    pub silence_frames: u64,
    /// Frames dropped due to cadence queue overflow.
    pub frames_dropped: u64,
}

/// Commits cadence counters to the logging guard on drop.
///
/// Ensures silence/overflow statistics are recorded even when the async
/// stream is cancelled mid-loop (e.g., Sonos closes the HTTP connection).
struct StatsRecorder {
    guard: Arc<LoggingStreamGuard>,
    counters: CadenceStats,
}

impl Drop for StatsRecorder {
    fn drop(&mut self) {
        self.guard.set_cadence_stats(self.counters);
    }
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
    target_depth: usize,
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

/// Summary of a completed stream for end-of-stream logging.
struct StreamSummary {
    stream_id: String,
    client_ip: IpAddr,
    frames_sent: u64,
    max_gap_ms: u64,
    gaps_over_threshold: u64,
    final_gap_ms: u64,
    stalled: bool,
    silence_events: u64,
    silence_frames: u64,
    frames_dropped: u64,
    pipeline_timeline_json: String,
}

impl std::fmt::Display for StreamSummary {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "stream={}, client={}, frames_sent={}, max_gap={}ms, gaps_over_{}ms={}, final_gap={}ms",
            self.stream_id,
            self.client_ip,
            self.frames_sent,
            self.max_gap_ms,
            DELIVERY_GAP_THRESHOLD_MS,
            self.gaps_over_threshold,
            self.final_gap_ms,
        )?;
        if self.silence_events > 0 {
            write!(
                f,
                ", silence_events={}, silence_frames={}",
                self.silence_events, self.silence_frames
            )?;
        }
        if self.frames_dropped > 0 {
            write!(f, ", frames_dropped={}", self.frames_dropped)?;
        }
        if !self.pipeline_timeline_json.is_empty() {
            write!(f, ", pipeline_timeline={}", self.pipeline_timeline_json)?;
        }
        Ok(())
    }
}

impl Drop for LoggingStreamGuard {
    fn drop(&mut self) {
        let last_nanos = self.last_delivery_nanos.load(Ordering::Relaxed);
        let final_gap_ms = if last_nanos > 0 {
            let now_nanos = self.reference_time.elapsed().as_nanos() as u64;
            now_nanos.saturating_sub(last_nanos) / 1_000_000
        } else {
            0
        };

        let cadence = self.cadence_stats.get();
        let timeline = self.pipeline_timeline.lock();
        let timeline_json = if timeline.is_empty() {
            String::new()
        } else {
            serde_json::to_string(&*timeline).unwrap_or_default()
        };
        drop(timeline);

        let summary = StreamSummary {
            stream_id: self.stream_id.clone(),
            client_ip: self.client_ip,
            frames_sent: self.frames_sent.load(Ordering::Relaxed),
            max_gap_ms: self.max_gap_ms.load(Ordering::Relaxed),
            gaps_over_threshold: self.gaps_over_threshold.load(Ordering::Relaxed),
            final_gap_ms,
            stalled: final_gap_ms > DELIVERY_GAP_LOG_THRESHOLD_MS,
            silence_events: cadence.map_or(0, |s| s.silence_events),
            silence_frames: cadence.map_or(0, |s| s.silence_frames),
            frames_dropped: cadence.map_or(0, |s| s.frames_dropped),
            pipeline_timeline_json: timeline_json,
        };

        let stalled_tag = if summary.stalled { " (stalled)" } else { "" };

        if let Some(ref err) = *self.first_error.get_mut() {
            log::warn!(
                "[Stream] HTTP stream ended with error{stalled_tag}: {summary}, error={err}"
            );
        } else {
            log::info!("[Stream] HTTP stream ended normally{stalled_tag}: {summary}");
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

    /// Tracks the frame's last sample pair and applies fade-in when
    /// `after_silence` is true. Single entry point for all audio yields,
    /// replacing separate `track_frame` + `maybe_fade_in` calls.
    fn prepare_audio(&mut self, frame: Bytes, after_silence: bool) -> Bytes {
        self.track_frame(&frame);
        if after_silence && self.enabled {
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

/// Jitter buffer state machine.
///
/// Transitions:
/// ```text
///   Playing ──queue empty──► Silence (with refill deadline when target_depth > 0)
///   Silence ──refilled to target / timeout / rx_closed──► Playing (with fade-in)
/// ```
enum BufferState {
    /// Normal: popping frames from the queue.
    Playing,
    /// Queue underrun: emitting silence while the buffer refills.
    /// When `target_depth > 0`, waits for queue to reach `target_depth` before
    /// resuming (with timeout via `deadline`). In pass-through mode (`target_depth = 0`),
    /// resumes as soon as any frame arrives (`deadline` is `None`).
    Silence {
        since: TokioInstant,
        deadline: Option<TokioInstant>,
    },
}

impl BufferState {
    /// Returns `true` when in a silence-emitting state.
    fn is_silent(&self) -> bool {
        matches!(self, Self::Silence { .. })
    }
}

/// Tracks pipeline snapshot state and computes deltas between intervals.
/// Extracted to keep per-tick bookkeeping out of the main cadence loop.
struct SnapshotTracker {
    tick_count: u64,
    tick_interval: u64,
    prev_delivery_frames: u64,
    prev_delivery_bytes: u64,
    prev_delivery_gaps: u64,
    prev_snapshot_ms: u64,
}

impl SnapshotTracker {
    fn new(frame_duration_ms: u32) -> Self {
        use crate::protocol_constants::SNAPSHOT_INTERVAL_MS;
        Self {
            tick_count: 0,
            tick_interval: (SNAPSHOT_INTERVAL_MS / frame_duration_ms as u64).max(1),
            prev_delivery_frames: 0,
            prev_delivery_bytes: 0,
            prev_delivery_gaps: 0,
            prev_snapshot_ms: 0,
        }
    }

    /// Increment tick count and return true every `tick_interval` ticks.
    fn tick(&mut self) -> bool {
        self.tick_count += 1;
        self.tick_count % self.tick_interval == 0
    }

    /// Capture a pipeline snapshot from the guard and stream state.
    fn capture(
        &mut self,
        guard: &LoggingStreamGuard,
        stream_state: Option<&Weak<StreamState>>,
        queue_len: usize,
        target_depth: usize,
        counters: &CadenceStats,
    ) {
        let elapsed_ms = guard.reference_time.elapsed().as_millis() as u64;

        let receive = if let Some(ss) = stream_state.and_then(|w| w.upgrade()) {
            let rs = ss.snapshot_and_reset_receive_stats();
            ReceiveWindow {
                frames_received: rs.frames_received,
                min_gap_ms: if rs.min_gap_ms == u64::MAX {
                    0
                } else {
                    rs.min_gap_ms
                },
                max_gap_ms: rs.max_gap_ms,
                gaps_over_threshold: rs.gaps_over_threshold,
            }
        } else {
            ReceiveWindow {
                frames_received: 0,
                min_gap_ms: 0,
                max_gap_ms: 0,
                gaps_over_threshold: 0,
            }
        };

        let cadence_window = CadenceWindow {
            queue_len,
            target_depth,
            silence_events: counters.silence_events,
            silence_frames: counters.silence_frames,
            drops: counters.frames_dropped,
        };

        let cur_frames = guard.frames_sent.load(Ordering::Relaxed);
        let cur_bytes = guard.bytes_sent.load(Ordering::Relaxed);
        let cur_gaps = guard.gaps_over_threshold.load(Ordering::Relaxed);
        let interval_max = guard.interval_max_gap_ms.swap(0, Ordering::Relaxed);

        let delta_bytes = cur_bytes.saturating_sub(self.prev_delivery_bytes);
        let interval_ms = elapsed_ms.saturating_sub(self.prev_snapshot_ms);
        let bytes_per_second = if interval_ms > 0 {
            delta_bytes * 1000 / interval_ms
        } else {
            0
        };

        let delivery = DeliveryWindow {
            frames_sent: cur_frames.saturating_sub(self.prev_delivery_frames),
            bytes_per_second,
            max_gap_ms: interval_max,
            gaps_over_threshold: cur_gaps.saturating_sub(self.prev_delivery_gaps),
        };

        self.prev_delivery_frames = cur_frames;
        self.prev_delivery_bytes = cur_bytes;
        self.prev_delivery_gaps = cur_gaps;
        self.prev_snapshot_ms = elapsed_ms;

        guard.push_pipeline_snapshot(PipelineSnapshot {
            elapsed_ms,
            receive,
            cadence: cadence_window,
            delivery,
        });
    }
}

/// Configuration for the cadence streaming pipeline.
pub struct CadenceConfig {
    /// Silence frame emitted when no audio is queued.
    pub silence_frame: Bytes,
    /// Target queue depth (frames) for fill gate exit.
    /// When 0, everything is pass-through (no fill gate).
    pub target_depth: usize,
    /// Overflow drop cap: when the queue exceeds this size, oldest frames are
    /// discarded.
    pub overflow_cap: usize,
    /// Skip the fill gate on resume (already have audio flowing).
    pub skip_fill_gate: bool,
    /// Duration of each output frame in milliseconds.
    pub frame_duration_ms: u32,
    /// Audio format (sample rate, channels, bit depth).
    pub audio_format: AudioFormat,
    /// Initial frames pre-populated in the queue to eliminate handoff gap.
    pub prefill_frames: Vec<Bytes>,
}

impl CadenceConfig {
    /// Build a `CadenceConfig` from stream-level parameters.
    ///
    /// Derives `target_depth` and `overflow_cap` from `jitter_buffer_ms` and
    /// `frame_duration_ms`. When `jitter_buffer_ms` is 0, pass-through mode
    /// is used (no fill gate).
    pub fn new(
        jitter_buffer_ms: u64,
        frame_duration_ms: u32,
        audio_format: AudioFormat,
        silence_frame: Bytes,
        prefill_frames: Vec<Bytes>,
        skip_fill_gate: bool,
    ) -> Self {
        use crate::protocol_constants::{
            JITTER_OVERFLOW_MULTIPLIER, MAX_CADENCE_QUEUE_SIZE, MIN_OVERFLOW_CAP,
        };

        let target_depth = if jitter_buffer_ms > 0 {
            jitter_buffer_ms.div_ceil(frame_duration_ms as u64) as usize
        } else {
            0
        };
        let overflow_cap = (target_depth * JITTER_OVERFLOW_MULTIPLIER)
            .clamp(MIN_OVERFLOW_CAP, MAX_CADENCE_QUEUE_SIZE);

        Self {
            silence_frame,
            target_depth,
            overflow_cap,
            skip_fill_gate,
            frame_duration_ms,
            audio_format,
            prefill_frames,
        }
    }
}

/// Trim prefill to `target_depth` (keep newest frames) and advance
/// `epoch_candidate` by the trimmed duration so latency metrics reflect
/// the oldest frame actually served, not the oldest in the ring buffer.
pub fn trim_prefill(
    prefill_frames: Vec<Bytes>,
    epoch_candidate: Option<Instant>,
    target_depth: usize,
    frame_duration_ms: u32,
) -> (Vec<Bytes>, Option<Instant>) {
    if target_depth > 0 && prefill_frames.len() > target_depth {
        let skip = prefill_frames.len() - target_depth;
        let trimmed = prefill_frames.into_iter().skip(skip).collect();
        let adjusted = epoch_candidate
            .map(|t| t + Duration::from_millis(skip as u64 * frame_duration_ms as u64));
        (trimmed, adjusted)
    } else {
        (prefill_frames, epoch_candidate)
    }
}

/// Creates a WAV audio stream with fixed-cadence output, optional jitter buffer,
/// and crossfade on silence transitions.
///
/// Maintains real-time cadence regardless of input timing:
/// - Incoming frames are queued (overflow-capped at `overflow_cap`, oldest dropped)
/// - Metronome ticks every `frame_duration_ms`
/// - On each tick: send queued frame if available, else send silence
///
/// Jitter buffer (when `target_depth` > 0):
/// - **Fill gate**: waits for queue to reach `target_depth` before starting the
///   metronome. Times out after 2x target duration to avoid infinite stalls.
/// - **Pass-through** (target_depth = 0): no fill gate (current behavior).
///
/// The buffer depth naturally absorbs delivery jitter. When the queue empties,
/// silence is emitted while the buffer refills to `target_depth` before resuming
/// playback (with timeout to prevent infinite stalls). In pass-through mode,
/// playback resumes as soon as any frame arrives.
///
/// Crossfade on silence transitions:
/// - When entering silence: emits a fade-out frame from the last audio sample to zero
/// - When exiting silence: applies fade-in to the first audio frame
///
/// Silence and overflow statistics are tracked locally and written to the
/// guard once at stream end via `set_cadence_stats()`.
///
/// One-shot epoch hook: fires `start_new_epoch` on the first real audio frame,
/// then is consumed. Used to record when audio actually starts flowing to a client.
pub struct EpochHook {
    pub stream_state: Arc<StreamState>,
    pub epoch_candidate: Option<Instant>,
    pub connected_at: Instant,
    pub remote_ip: IpAddr,
}

/// Epoch tracking (optional): when `epoch_hook` is `Some`, the stream fires
/// `start_new_epoch` on the first real audio frame, then discards the hook.
pub fn create_wav_stream_with_cadence(
    mut rx: broadcast::Receiver<Bytes>,
    guard: Arc<LoggingStreamGuard>,
    config: CadenceConfig,
    stream_state: Option<Weak<StreamState>>,
    epoch_hook: Option<EpochHook>,
) -> impl Stream<Item = Result<Bytes, std::io::Error>> {
    stream! {
        let CadenceConfig {
            silence_frame,
            target_depth,
            overflow_cap,
            skip_fill_gate,
            frame_duration_ms,
            audio_format,
            prefill_frames,
        } = config;

        // ── Defensive invariant clamps ───────────────────────────────────
        // These protect against manually-constructed CadenceConfigs.
        // CadenceConfig::new enforces proper bounds via protocol_constants,
        // but direct field construction could violate these.

        // Invariant: frame_duration_ms >= 1 (prevents zero-duration timer
        // busy-loop and division-by-zero in SnapshotTracker).
        let frame_duration_ms = if frame_duration_ms == 0 {
            log::warn!(
                "[Stream] frame_duration_ms is 0, clamping to 1",
            );
            1
        } else {
            frame_duration_ms
        };

        // Invariant: overflow_cap >= max(1, target_depth) so the fill gate
        // can be satisfied and at least one frame can be queued.
        let min_cap = if target_depth > 0 { target_depth } else { 1 };
        let overflow_cap = if overflow_cap < min_cap {
            log::warn!(
                "[Stream] overflow_cap ({}) < minimum ({}), clamping to {}",
                overflow_cap, min_cap, min_cap,
            );
            min_cap
        } else {
            overflow_cap
        };

        let cadence_duration = Duration::from_millis(frame_duration_ms as u64);
        let fill_gate_timeout = Duration::from_millis(
            (target_depth as u64) * (frame_duration_ms as u64) * FILL_GATE_TIMEOUT_MULTIPLIER,
        );

        // Pre-populate queue with prefill frames to eliminate handoff gap.
        // This ensures the first tick immediately yields audio.
        let mut queue: VecDeque<Bytes> = VecDeque::with_capacity(overflow_cap.max(prefill_frames.len()));
        for frame in prefill_frames {
            queue.push_back(frame);
        }

        let mut rx_closed = false;

        // Cadence-specific counters, committed to guard on drop (even if
        // the stream is cancelled mid-loop by an HTTP disconnect).
        let mut stats = StatsRecorder {
            guard: Arc::clone(&guard),
            counters: CadenceStats {
                silence_events: 0,
                silence_frames: 0,
                frames_dropped: 0,
            },
        };

        // ── Fill gate ──────────────────────────────────────────────────────
        // When target_depth > 0 and not resuming, wait for the queue to
        // accumulate target_depth frames before starting the metronome.
        // Timeout: 2× the target duration in ms to avoid infinite stalls.
        if target_depth > 0 && !skip_fill_gate && queue.len() < target_depth {
            let deadline = TokioInstant::now() + fill_gate_timeout;
            log::info!(
                "[Stream] Fill gate: waiting for {} frames (timeout {}ms, have {})",
                target_depth,
                fill_gate_timeout.as_millis(),
                queue.len()
            );
            let mut gate_lagged_log: Option<TokioInstant> = None;
            loop {
                if queue.len() >= target_depth {
                    log::info!(
                        "[Stream] Fill gate satisfied: {} frames queued",
                        queue.len()
                    );
                    break;
                }
                tokio::select! {
                    biased;
                    _ = tokio::time::sleep_until(deadline) => {
                        log::warn!(
                            "[Stream] Fill gate timeout after {}ms with {} frames (target {})",
                            fill_gate_timeout.as_millis(),
                            queue.len(),
                            target_depth
                        );
                        break;
                    }
                    result = rx.recv() => {
                        match result {
                            Ok(frame) => {
                                if queue.len() >= overflow_cap {
                                    queue.pop_front();
                                    stats.counters.frames_dropped += 1;
                                }
                                queue.push_back(frame);
                            }
                            Err(broadcast::error::RecvError::Lagged(n)) => {
                                log_lagged(n, &mut gate_lagged_log, " (fill gate)");
                            }
                            Err(broadcast::error::RecvError::Closed) => {
                                log::debug!("[Stream] Channel closed during fill gate");
                                rx_closed = true;
                                break;
                            }
                        }
                    }
                }
            }
        }

        // Fire first tick immediately to get audio flowing before Sonos times out.
        // On resume, Sonos closes the connection within milliseconds if no audio arrives.
        let mut metronome = interval(cadence_duration);
        metronome.set_missed_tick_behavior(MissedTickBehavior::Burst);

        let mut state = BufferState::Playing;

        let mut crossfade = CrossfadeState::new(&audio_format, frame_duration_ms);

        // Rate-limit lagged warnings (max once per second)
        let mut last_lagged_log: Option<TokioInstant> = None;

        // One-shot epoch hook: fires on the first real audio frame, then consumed
        let mut epoch_hook = epoch_hook;

        let mut snapshots = SnapshotTracker::new(frame_duration_ms);

        loop {
            // Exit when channel closed AND queue drained
            if rx_closed && queue.is_empty() {
                break;
            }

            tokio::select! {
                biased;

                // PRIORITY 1: Metronome tick - MUST emit something every frame_duration_ms
                _ = metronome.tick() => {
                    // ── State transitions ─────────────────────────────────
                    //
                    //   Playing → Silence  : queue empty, channel open
                    //   Silence → Playing  : queue refilled to target_depth
                    //                        (or any frame in pass-through mode)
                    //                        (or timeout / channel closed)
                    //
                    let was_silent = state.is_silent();
                    let entering_silence;

                    match state {
                        BufferState::Playing => {
                            if queue.is_empty() && !rx_closed {
                                let now = TokioInstant::now();
                                if target_depth > 0 {
                                    log::info!(
                                        "[Stream] Buffer underrun, refilling to {} frames (timeout {}ms)",
                                        target_depth, fill_gate_timeout.as_millis()
                                    );
                                    state = BufferState::Silence {
                                        since: now,
                                        deadline: Some(now + fill_gate_timeout),
                                    };
                                } else {
                                    log::info!("[Stream] Entering silence (cadence) - queue empty");
                                    state = BufferState::Silence {
                                        since: now,
                                        deadline: None,
                                    };
                                }
                                stats.counters.silence_events += 1;
                                entering_silence = true;
                            } else {
                                entering_silence = false;
                            }
                        }
                        BufferState::Silence { since, deadline } => {
                            // Pass-through (target_depth=0): resume on any frame
                            // Jitter buffer: resume when refilled to target_depth,
                            // or on timeout / channel close
                            let refilled = if target_depth == 0 {
                                !queue.is_empty()
                            } else {
                                queue.len() >= target_depth
                            };
                            let timed_out = deadline.map_or(false, |d| TokioInstant::now() >= d);
                            if refilled || rx_closed || timed_out {
                                if timed_out && !refilled {
                                    log::warn!(
                                        "[Stream] Refill timeout after {:.1}s, resuming with {} frames (target {})",
                                        since.elapsed().as_secs_f32(), queue.len(), target_depth
                                    );
                                } else if !queue.is_empty() {
                                    log::info!(
                                        "[Stream] Exiting silence after {:.1}s ({} frames queued)",
                                        since.elapsed().as_secs_f32(), queue.len()
                                    );
                                }
                                state = BufferState::Playing;
                            }
                            entering_silence = false;
                        }
                    }

                    // ── Emit frame based on resolved state ───────────────────
                    let mut yielded_audio = false;
                    match state {
                        BufferState::Silence { .. } => {
                            stats.counters.silence_frames += 1;
                            if entering_silence {
                                yield Ok(crossfade.enter_silence(&silence_frame));
                            } else {
                                yield Ok(silence_frame.clone());
                            }
                        }
                        BufferState::Playing if !queue.is_empty() => {
                            let frame = queue.pop_front().unwrap();
                            let after_silence = was_silent;
                            yielded_audio = true;
                            yield Ok(crossfade.prepare_audio(frame, after_silence));
                        }
                        BufferState::Playing => {
                            // rx_closed and queue empty — don't yield, loop will break
                        }
                    }

                    // Fire epoch hook once on first real audio frame
                    if yielded_audio {
                        if let Some(hook) = epoch_hook.take() {
                            hook.stream_state.timing.start_new_epoch(
                                hook.epoch_candidate,
                                hook.connected_at,
                                hook.remote_ip,
                            );
                        }
                    }

                    // Drain any pending frames from rx into queue after emitting.
                    // This prevents starvation: with biased select, ticks always win,
                    // so without this drain, frames could pile up in rx while we
                    // emit silence (especially during recovery from underflow).
                    if !rx_closed {
                        loop {
                            match rx.try_recv() {
                                Ok(frame) => {
                                    if queue.len() >= overflow_cap {
                                        queue.pop_front();
                                        stats.counters.frames_dropped += 1;
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

                    if snapshots.tick() {
                        snapshots.capture(
                            &guard, stream_state.as_ref(), queue.len(), target_depth,
                            &stats.counters,
                        );
                    }
                }

                // PRIORITY 2: Receive frames into queue (when channel open and tick not ready)
                result = rx.recv(), if !rx_closed => {
                    match result {
                        Ok(frame) => {
                            if queue.len() >= overflow_cap {
                                // Queue overflow - drop oldest to prevent unbounded growth
                                queue.pop_front();
                                stats.counters.frames_dropped += 1;
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

        // Stats are committed by StatsRecorder::drop, which runs whether
        // the stream completes normally or is cancelled by an HTTP disconnect.
        drop(stats);
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

    /// Default overflow cap for pass-through tests (10 frames).
    const TEST_OVERFLOW_CAP: usize = 10;

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

    /// Creates a default CadenceConfig for tests (pass-through mode).
    fn test_config() -> CadenceConfig {
        CadenceConfig {
            silence_frame: test_silence_frame(),
            target_depth: 0,
            overflow_cap: TEST_OVERFLOW_CAP,
            skip_fill_gate: false,
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

        // Send 12 frames (overflow_cap + 2), should drop 2 oldest
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

        // Overflow queue by TEST_OVERFLOW_CAP + 3 frames
        let overflow_count = 3;
        for i in 0..(TEST_OVERFLOW_CAP + overflow_count) as u8 {
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

    // ─────────────────────────────────────────────────────────────────────
    // Jitter buffer tests
    // ─────────────────────────────────────────────────────────────────────

    /// Target depth for jitter buffer tests (5 frames = 50ms at 10ms/frame).
    const JITTER_TARGET: usize = 5;

    /// Creates a CadenceConfig with jitter buffer enabled.
    fn jitter_config() -> CadenceConfig {
        CadenceConfig {
            silence_frame: test_silence_frame(),
            target_depth: JITTER_TARGET,
            overflow_cap: JITTER_TARGET * 3,
            skip_fill_gate: false,
            frame_duration_ms: SILENCE_FRAME_DURATION_MS,
            audio_format: test_audio_format(),
            prefill_frames: vec![],
        }
    }

    /// Test harness that encapsulates the broadcast channel, guard, pinned stream,
    /// and tick duration. Reduces boilerplate in jitter buffer tests.
    struct JitterHarness {
        tx: broadcast::Sender<Bytes>,
        guard: Arc<LoggingStreamGuard>,
        stream: Pin<Box<dyn Stream<Item = Result<Bytes, std::io::Error>> + Send>>,
        tick_ms: u64,
    }

    impl JitterHarness {
        /// Build a harness from a (possibly customised) `CadenceConfig`.
        fn new(config: CadenceConfig) -> Self {
            let (tx, rx) = broadcast::channel::<Bytes>(32);
            let guard = test_guard();
            let tick_ms = config.frame_duration_ms as u64;
            let stream = Box::pin(create_wav_stream_with_cadence(
                rx,
                Arc::clone(&guard),
                config,
                None,
                None,
            ));
            Self {
                tx,
                guard,
                stream,
                tick_ms,
            }
        }

        /// Build a harness with the default jitter config.
        fn with_jitter() -> Self {
            Self::new(jitter_config())
        }

        /// Send `n` audio frames into the channel.
        fn send_audio(&self, n: usize) {
            for _ in 0..n {
                self.tx.send(test_audio_frame()).unwrap();
            }
        }

        /// Advance time by one tick and poll the stream to register timers.
        async fn advance_tick(&mut self) {
            poll_and_advance(
                &mut self.stream.as_mut(),
                Duration::from_millis(self.tick_ms),
            )
            .await;
        }

        /// Advance by `n` ticks, consuming and discarding each yielded frame.
        async fn advance_ticks(&mut self, n: usize) {
            for _ in 0..n {
                self.advance_tick().await;
                let _ = self.stream.next().await;
            }
        }

        /// Advance one tick and return the next yielded frame.
        async fn next_frame(&mut self) -> Bytes {
            self.advance_tick().await;
            self.stream
                .next()
                .await
                .expect("stream should yield")
                .unwrap()
        }

        /// Assert the next frame is audio (not all-zero).
        async fn expect_audio(&mut self, msg: &str) {
            let frame = self.next_frame().await;
            assert!(!frame.iter().all(|&b| b == 0), "{}", msg);
        }

        /// Assert the next frame is silence (all-zero).
        #[allow(dead_code)]
        async fn expect_silence(&mut self, msg: &str) {
            let frame = self.next_frame().await;
            assert!(frame.iter().all(|&b| b == 0), "{}", msg);
        }

        /// Close the channel and drain the stream to completion.
        /// Returns the cadence stats recorded by the guard.
        async fn finish(mut self) -> CadenceStats {
            drop(self.tx);
            drain_to_end(&mut self.stream.as_mut()).await;
            // Clone stats out before guard is dropped
            *self
                .guard
                .cadence_stats
                .get()
                .expect("cadence stats should be set")
        }

        /// Close the channel without draining. The receiver will see `Closed`
        /// on the next recv. Useful for tests that verify termination behavior.
        fn close_channel(&mut self) {
            let (replacement, _) = broadcast::channel::<Bytes>(1);
            drop(std::mem::replace(&mut self.tx, replacement));
        }
    }

    #[tokio::test(start_paused = true)]
    async fn fill_gate_waits_for_target_depth() {
        let mut h = JitterHarness::with_jitter();

        // Send fewer than target_depth frames
        h.send_audio(3);

        // Poll once to let fill gate receive frames, then advance a small amount
        poll_fn(|cx| {
            let _ = h.stream.as_mut().poll_next(cx);
            Poll::Ready(())
        })
        .await;
        tokio::time::advance(Duration::from_millis(1)).await;

        // Stream should not yield yet (fill gate not satisfied)
        let yielded_early = poll_fn(|cx| match h.stream.as_mut().poll_next(cx) {
            Poll::Ready(Some(_)) => Poll::Ready(true),
            Poll::Pending => Poll::Ready(false),
            Poll::Ready(None) => Poll::Ready(false),
        })
        .await;
        assert!(
            !yielded_early,
            "fill gate should block until target_depth is reached"
        );

        // Send remaining frames to satisfy gate
        h.send_audio(2);

        // Advance enough for fill gate to complete and first tick
        tokio::time::advance(Duration::from_millis(h.tick_ms * 2)).await;

        // Should now yield audio
        let frame = h
            .stream
            .next()
            .await
            .expect("stream should yield after fill gate")
            .unwrap();
        assert!(
            !frame.iter().all(|&b| b == 0),
            "expected audio frame after fill gate satisfied"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn fill_gate_times_out() {
        let mut h = JitterHarness::with_jitter();

        // Send only 2 frames (less than target 5)
        // target_depth = 5, frame_duration = 10ms, timeout = 5 * 10 * 2 = 100ms
        h.send_audio(2);

        // Advance past the fill gate timeout (100ms) + one tick
        h.advance_ticks(15).await;

        // Should yield something (audio or silence) after timeout
        let frame = h
            .stream
            .next()
            .await
            .expect("stream should yield after timeout")
            .unwrap();
        assert!(
            !frame.is_empty(),
            "expected non-empty frame after fill gate timeout"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn fill_gate_skipped_on_resume() {
        let mut config = jitter_config();
        config.skip_fill_gate = true;
        config.prefill_frames = (0..JITTER_TARGET + 1).map(|_| test_audio_frame()).collect();

        let mut h = JitterHarness::new(config);
        h.expect_audio("expected audio frame immediately when fill gate skipped")
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn fill_gate_skipped_when_target_zero() {
        // target_depth = 0 means pass-through
        let config = test_config();
        assert_eq!(config.target_depth, 0);

        let mut h = JitterHarness::new(config);
        h.send_audio(1);
        h.expect_audio("expected audio with target_depth=0 (no fill gate)")
            .await;
    }

    #[tokio::test(start_paused = true)]
    async fn jitter_absorbs_gap_without_silence() {
        let mut config = jitter_config();
        config.skip_fill_gate = true;
        // Pre-fill with target_depth frames. The first poll_and_advance consumes
        // one at t=0, so we have target_depth-1 left for the loop.
        // We'll drain 3 frames (target_depth-2 to be safe) and verify all are audio.
        let drain_count = JITTER_TARGET - 2; // 3
        let total_prefill = drain_count + 1; // +1 for the poll_and_advance consumption
        config.prefill_frames = (0..total_prefill)
            .map(|i| Bytes::from(vec![i as u8 + 1; 64]))
            .collect();

        let mut h = JitterHarness::new(config);

        // Drain frames without sending new ones
        let mut audio_count = 0;
        for _ in 0..drain_count {
            let frame = h.next_frame().await;
            if !frame.iter().all(|&b| b == 0) {
                audio_count += 1;
            }
        }

        assert_eq!(
            audio_count, drain_count,
            "jitter buffer should absorb gap without silence, got {} audio of {} expected",
            audio_count, drain_count
        );

        let stats = h.finish().await;
        assert_eq!(
            stats.silence_events, 0,
            "should have zero silence events when buffer absorbs gap (before tx drop)"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn overflow_uses_overflow_cap() {
        let mut config = jitter_config();
        config.skip_fill_gate = true;
        let overflow_cap = config.overflow_cap; // 15 (5 * 3)

        let mut h = JitterHarness::new(config);

        // Send overflow_cap + 3 frames
        let extra = 3;
        for i in 0..(overflow_cap + extra) as u8 {
            h.tx.send(Bytes::from(vec![i; 64])).unwrap();
        }

        // Process frames
        h.advance_ticks(20).await;

        let stats = h.finish().await;
        assert_eq!(
            stats.frames_dropped, extra as u64,
            "should drop {} frames when exceeding overflow_cap {}",
            extra, overflow_cap
        );
    }

    #[tokio::test(start_paused = true)]
    async fn prefill_trimmed_to_target_depth() {
        // Verify that trimming prefill to target_depth keeps newest frames.
        // We provide 10 frames (0..10), target_depth=5, so after trim: [5,6,7,8,9].
        let mut config = jitter_config();
        config.skip_fill_gate = true;
        // 10 prefill frames, target_depth = 5
        config.prefill_frames = (0..10u8).map(|i| Bytes::from(vec![i; 64])).collect();
        let (trimmed, _) = super::trim_prefill(
            config.prefill_frames,
            None,
            config.target_depth,
            config.frame_duration_ms,
        );
        config.prefill_frames = trimmed;
        // After trim: [5, 6, 7, 8, 9]

        let mut h = JitterHarness::new(config);

        // Collect all audio frames from the prefill
        let mut yielded = Vec::new();
        for _ in 0..3 {
            let frame = h.next_frame().await;
            if !frame.iter().all(|&b| b == 0) {
                yielded.push(frame[0]);
            }
        }

        // All yielded frames should be from the trimmed set (>= 5)
        assert!(
            !yielded.is_empty(),
            "should yield at least some prefill frames"
        );
        assert!(
            yielded.iter().all(|&b| b >= 5),
            "all yielded frames should be from trimmed set (>= 5), got {:?}",
            yielded
        );
    }

    #[tokio::test(start_paused = true)]
    async fn no_rebuffer_when_target_zero() {
        // Pass-through mode (target_depth=0)
        let mut config = test_config();
        config.prefill_frames = vec![test_audio_frame()];

        let mut h = JitterHarness::new(config);

        // First tick (t=0) yields prefill frame
        h.expect_audio("first frame should be audio from prefill")
            .await;

        // No more frames - next tick should yield silence immediately (no rebuffer hold)
        // In pass-through mode, crossfade produces a fade-out frame (may not be all zeros)
        // but should not be a real audio frame either. The important thing is it enters
        // silence mode. We verify via stats below.
        h.advance_ticks(1).await;

        // Send another frame - should exit silence immediately (no rebuffer hold)
        h.send_audio(1);
        h.expect_audio("should exit silence immediately in pass-through mode")
            .await;

        let stats = h.finish().await;
        assert_eq!(
            stats.silence_events, 1,
            "pass-through should have exactly 1 silence event (no rebuffer)"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn silence_exits_on_channel_close() {
        let mut config = jitter_config();
        config.skip_fill_gate = true;
        config.prefill_frames = vec![test_audio_frame()];

        let mut h = JitterHarness::new(config);

        // Consume prefill to enter silence
        h.advance_ticks(1).await;

        // Close channel while in silence
        h.close_channel();

        // Should drain and terminate without hanging
        let mut terminated = false;
        for _ in 0..20 {
            tokio::time::advance(Duration::from_millis(h.tick_ms)).await;
            let done = poll_fn(|cx| match h.stream.as_mut().poll_next(cx) {
                Poll::Ready(None) => Poll::Ready(true),
                _ => Poll::Ready(false),
            })
            .await;
            if done {
                terminated = true;
                break;
            }
        }
        assert!(
            terminated,
            "stream should terminate after channel close during silence"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn fill_gate_exits_on_channel_close() {
        let mut config = jitter_config();
        // No prefill, no skip — fill gate will block waiting for target_depth frames
        config.prefill_frames = vec![];
        config.skip_fill_gate = false;

        let (tx, rx) = broadcast::channel::<Bytes>(32);
        let guard = test_guard();
        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            Arc::clone(&guard),
            config,
            None,
            None,
        ));

        // Send 1 frame (less than target_depth=5), then close
        tx.send(test_audio_frame()).unwrap();
        drop(tx);

        // Stream should exit fill gate on close, drain the 1 frame, then terminate
        let mut terminated = false;
        for _ in 0..30 {
            tokio::time::advance(Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64)).await;
            let done = poll_fn(|cx| match stream.as_mut().poll_next(cx) {
                Poll::Ready(None) => Poll::Ready(true),
                _ => Poll::Ready(false),
            })
            .await;
            if done {
                terminated = true;
                break;
            }
        }
        assert!(
            terminated,
            "stream should terminate after channel close during fill gate"
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // trim_prefill tests
    // ─────────────────────────────────────────────────────────────────────

    #[test]
    fn trim_prefill_keeps_newest_and_adjusts_epoch() {
        let epoch = Instant::now();
        let frames: Vec<Bytes> = (0..10).map(|i| Bytes::from(vec![i; 64])).collect();
        let frame_duration_ms = 20;
        let target_depth = 5;

        let (trimmed, adjusted_epoch) =
            trim_prefill(frames.clone(), Some(epoch), target_depth, frame_duration_ms);

        // Should keep the last 5 frames (indices 5..10)
        assert_eq!(trimmed.len(), 5);
        assert_eq!(trimmed[0][0], 5);
        assert_eq!(trimmed[4][0], 9);

        // Epoch should advance by 5 skipped frames × 20ms = 100ms
        let adjusted = adjusted_epoch.expect("epoch should be present");
        let offset = adjusted.duration_since(epoch);
        assert_eq!(offset, Duration::from_millis(100));
    }

    #[test]
    fn trim_prefill_no_trim_when_at_target() {
        let epoch = Instant::now();
        let frames: Vec<Bytes> = (0..5).map(|i| Bytes::from(vec![i; 64])).collect();

        let (trimmed, adjusted_epoch) = trim_prefill(frames, Some(epoch), 5, 20);

        assert_eq!(trimmed.len(), 5);
        // Epoch unchanged — no trim occurred
        let adjusted = adjusted_epoch.unwrap();
        assert_eq!(adjusted.duration_since(epoch), Duration::ZERO);
    }

    #[test]
    fn trim_prefill_no_trim_when_below_target() {
        let epoch = Instant::now();
        let frames: Vec<Bytes> = (0..3).map(|i| Bytes::from(vec![i; 64])).collect();

        let (trimmed, adjusted_epoch) = trim_prefill(frames, Some(epoch), 5, 20);

        assert_eq!(trimmed.len(), 3);
        assert_eq!(
            adjusted_epoch.unwrap().duration_since(epoch),
            Duration::ZERO
        );
    }

    #[test]
    fn trim_prefill_passthrough_when_target_zero() {
        let epoch = Instant::now();
        let frames: Vec<Bytes> = (0..10).map(|i| Bytes::from(vec![i; 64])).collect();

        // target_depth = 0 means pass-through, no trimming regardless of count
        let (trimmed, adjusted_epoch) = trim_prefill(frames, Some(epoch), 0, 20);

        assert_eq!(trimmed.len(), 10);
        assert_eq!(
            adjusted_epoch.unwrap().duration_since(epoch),
            Duration::ZERO
        );
    }

    #[test]
    fn trim_prefill_handles_none_epoch() {
        let frames: Vec<Bytes> = (0..10).map(|i| Bytes::from(vec![i; 64])).collect();

        let (trimmed, adjusted_epoch) = trim_prefill(frames, None, 5, 20);

        assert_eq!(trimmed.len(), 5);
        assert!(
            adjusted_epoch.is_none(),
            "None epoch should remain None after trim"
        );
    }

    #[test]
    fn trim_prefill_epoch_scales_with_frame_duration() {
        let epoch = Instant::now();
        let frames: Vec<Bytes> = (0..8).map(|i| Bytes::from(vec![i; 64])).collect();

        // 40ms frames, target 3 → skip 5 → epoch advances 5 × 40ms = 200ms
        let (trimmed, adjusted_epoch) = trim_prefill(frames, Some(epoch), 3, 40);

        assert_eq!(trimmed.len(), 3);
        assert_eq!(
            adjusted_epoch.unwrap().duration_since(epoch),
            Duration::from_millis(200)
        );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Invariant clamp and early-drop regression tests
    // ─────────────────────────────────────────────────────────────────────

    #[tokio::test(start_paused = true)]
    async fn early_drop_commits_cadence_stats() {
        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let guard = test_guard();
        let guard_ref = Arc::clone(&guard);

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx,
            guard,
            test_config(),
            None,
            None,
        ));

        // Send a frame and consume one tick so the stream is running
        tx.send(test_audio_frame()).unwrap();
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;
        let _ = stream.next().await;

        // Advance into silence so counters are non-zero
        poll_and_advance(
            &mut stream.as_mut(),
            Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64),
        )
        .await;
        let _ = stream.next().await;

        // Drop the stream mid-loop without draining (simulates HTTP disconnect)
        drop(stream);
        drop(tx);

        // Stats should still be committed via StatsRecorder::drop
        let stats = guard_ref
            .cadence_stats
            .get()
            .expect("cadence stats should be set even after early drop");
        assert!(
            stats.silence_events > 0,
            "silence events should be recorded after early drop"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn zero_frame_duration_clamped_no_panic() {
        let config = CadenceConfig {
            silence_frame: test_silence_frame(),
            target_depth: 0,
            overflow_cap: TEST_OVERFLOW_CAP,
            skip_fill_gate: false,
            frame_duration_ms: 0, // Invalid: should be clamped to 1
            audio_format: test_audio_format(),
            prefill_frames: vec![],
        };

        let (tx, rx) = broadcast::channel::<Bytes>(16);
        let guard = test_guard();

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx, guard, config, None, None,
        ));

        tx.send(test_audio_frame()).unwrap();

        // Advance enough for the clamped 1ms timer to fire
        poll_and_advance(&mut stream.as_mut(), Duration::from_millis(5)).await;

        // Should yield a frame without panicking
        let frame = stream.next().await.expect("stream should yield").unwrap();
        assert!(
            !frame.is_empty(),
            "should emit a non-empty frame with clamped duration"
        );

        drop(tx);
    }

    #[tokio::test(start_paused = true)]
    async fn overflow_cap_clamped_to_target_depth() {
        // overflow_cap (2) < target_depth (5): should be clamped to 5
        // so the fill gate can be satisfied without artificial drops.
        let config = CadenceConfig {
            silence_frame: test_silence_frame(),
            target_depth: JITTER_TARGET, // 5
            overflow_cap: 2,             // Invalid: < target_depth, clamped to 5
            skip_fill_gate: false,
            frame_duration_ms: SILENCE_FRAME_DURATION_MS,
            audio_format: test_audio_format(),
            prefill_frames: vec![],
        };

        let (tx, rx) = broadcast::channel::<Bytes>(32);
        let guard = test_guard();
        let guard_ref = Arc::clone(&guard);

        let mut stream = Box::pin(create_wav_stream_with_cadence(
            rx, guard, config, None, None,
        ));

        // Send exactly target_depth frames before polling so the fill gate
        // can receive all of them in a single pass (all buffered in broadcast).
        for _ in 0..JITTER_TARGET {
            tx.send(test_audio_frame()).unwrap();
        }

        // Poll once: fill gate receives all 5 frames (broadcast has them
        // buffered), sees queue >= target_depth, and breaks. The metronome
        // isn't ready yet (time is paused), so poll returns Pending.
        poll_fn(|cx| {
            let _ = stream.as_mut().poll_next(cx);
            Poll::Ready(())
        })
        .await;

        // Advance one tick so the metronome fires
        time::advance(Duration::from_millis(SILENCE_FRAME_DURATION_MS as u64)).await;

        // Should yield audio (fill gate was satisfied because overflow_cap was clamped)
        let frame = stream
            .next()
            .await
            .expect("stream should yield after fill gate")
            .unwrap();
        assert!(
            !frame.iter().all(|&b| b == 0),
            "expected audio after fill gate with clamped overflow_cap"
        );

        // Close and drain to commit stats
        drop(tx);
        drain_to_end(&mut stream.as_mut()).await;

        let stats = guard_ref
            .cadence_stats
            .get()
            .expect("cadence stats should be set");
        assert_eq!(
            stats.frames_dropped, 0,
            "no frames should be dropped when overflow_cap is clamped to target_depth"
        );
    }
}
