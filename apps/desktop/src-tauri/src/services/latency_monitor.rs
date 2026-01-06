//! Latency monitoring service for measuring absolute audio playback delay.
//!
//! This service measures the end-to-end latency between audio source and Sonos
//! playback by polling `GetPositionInfo` and comparing against stream timing.
//! The absolute latency is suitable for video sync applications.
//!
//! # Measurement Strategy
//!
//! Measures absolute latency: `stream_elapsed - sonos_reltime`
//! - `stream_elapsed` = wall-clock time since first audio frame received
//! - `sonos_reltime` = Sonos playback position in the track
//! - Result = total pipeline delay (typically 0.5-2s for PCM, 15-25s for AAC)
//!
//! Additional features:
//! 1. Moderate-frequency polling (every 500ms) - sufficient for 1-second Sonos precision
//! 2. RTT compensation for network delay
//! 3. Exponential moving average for stability
//! 4. Incremental variance calculation for confidence scoring
//! 5. Track restart detection to reset statistics

use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::events::{EventEmitter, LatencyEvent};
use crate::sonos::traits::SonosPlayback;
use crate::stream::StreamManager;
use crate::utils::now_millis;

/// Polling interval for position queries.
/// 500ms is sufficient since Sonos RelTime only has 1-second precision.
const POLL_INTERVAL_MS: u64 = 500;

/// Minimum samples needed before emitting latency updates.
const MIN_SAMPLES_FOR_CONFIDENCE: usize = 5;

/// EMA smoothing factor (higher = more responsive to changes).
const EMA_ALPHA: f64 = 0.3;

/// Key for identifying a monitoring session (stream_id, speaker_ip).
type SessionKey = (String, String);

/// Tracks latency measurement state for a single speaker.
struct LatencySession {
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
}

impl LatencySession {
    /// Creates a new monitoring session.
    fn new() -> Self {
        Self {
            last_sonos_reltime_ms: None,
            sonos_offset_ms: 0,
            ema_latency: 0.0,
            sample_count: 0,
            running_mean: 0.0,
            running_m2: 0.0,
            last_emit: None,
        }
    }

    /// Resets all state when switching to a different stream.
    /// This clears everything including the position offset.
    fn reset_all(&mut self) {
        self.last_sonos_reltime_ms = None;
        self.sonos_offset_ms = 0;
        self.ema_latency = 0.0;
        self.sample_count = 0;
        self.running_mean = 0.0;
        self.running_m2 = 0.0;
    }

    /// Calculates absolute end-to-end latency for video sync.
    ///
    /// Latency = stream_elapsed - (sonos_reltime + offset)
    /// - `stream_elapsed` = time since first audio frame received
    /// - `sonos_reltime` = Sonos playback position (adjusted for RTT and offset)
    ///
    /// When Sonos restarts its track position (due to metadata updates), we
    /// accumulate the "lost" position into an offset to maintain continuity.
    ///
    /// This measures the total pipeline delay: the time between audio being
    /// captured at the source and being played by Sonos.
    fn calculate_latency(
        &mut self,
        stream_elapsed_ms: u64,
        sonos_reltime_ms: u64,
        rtt_ms: u32,
    ) -> i64 {
        // Detect track restart: RelTime went backwards
        // When this happens, accumulate the lost position into the offset
        if let Some(last_reltime) = self.last_sonos_reltime_ms {
            if sonos_reltime_ms < last_reltime.saturating_sub(100) {
                // Calculate how much position was "lost" and add to offset
                let lost_ms = last_reltime.saturating_sub(sonos_reltime_ms);
                self.sonos_offset_ms += lost_ms;
                log::info!(
                    "[LatencyMonitor] Track restart: reltime {} -> {} (offset now {}ms)",
                    last_reltime,
                    sonos_reltime_ms,
                    self.sonos_offset_ms
                );
            }
        }
        self.last_sonos_reltime_ms = Some(sonos_reltime_ms);

        // Apply offset and RTT adjustment to get continuous Sonos position
        let continuous_sonos_ms = sonos_reltime_ms
            .saturating_add(self.sonos_offset_ms)
            .saturating_add((rtt_ms / 2) as u64);

        // Absolute latency = (time since first frame) - (continuous Sonos position)
        // Positive = audio in pipeline waiting to be played (normal)
        let latency_ms = (stream_elapsed_ms as i64) - (continuous_sonos_ms as i64);

        log::debug!(
            "[LatencyMonitor] stream={}ms, sonos={}ms (continuous={}ms, offset={}ms), latency={}ms",
            stream_elapsed_ms,
            sonos_reltime_ms,
            continuous_sonos_ms,
            self.sonos_offset_ms,
            latency_ms
        );

        latency_ms
    }

    /// Records a new latency measurement and updates statistics.
    ///
    /// Uses Welford's online algorithm for incremental variance calculation,
    /// avoiding heap allocation on each update.
    fn record_latency(&mut self, latency_ms: i64) {
        let value = latency_ms as f64;

        // Update EMA
        if self.sample_count == 0 {
            self.ema_latency = value;
        } else {
            self.ema_latency = EMA_ALPHA * value + (1.0 - EMA_ALPHA) * self.ema_latency;
        }

        // Welford's online algorithm for incremental mean and variance
        self.sample_count += 1;
        let delta = value - self.running_mean;
        self.running_mean += delta / self.sample_count as f64;
        let delta2 = value - self.running_mean;
        self.running_m2 += delta * delta2;
    }

    /// Returns the current latency estimate in milliseconds.
    fn latency_ms(&self) -> u64 {
        self.ema_latency.max(0.0) as u64
    }

    /// Returns the confidence score (0.0 - 1.0) based on measurement stability.
    ///
    /// Uses incrementally computed standard deviation - no heap allocation.
    fn confidence(&self) -> f32 {
        if self.sample_count < MIN_SAMPLES_FOR_CONFIDENCE {
            return 0.3; // Low confidence until we have enough samples
        }

        // Calculate standard deviation from running variance
        let variance = self.running_m2 / self.sample_count as f64;
        let std_dev = variance.sqrt();

        // Higher confidence if measurements are consistent
        match std_dev {
            d if d < 50.0 => 0.95,
            d if d < 100.0 => 0.85,
            d if d < 200.0 => 0.70,
            d if d < 500.0 => 0.50,
            _ => 0.30,
        }
    }

    /// Returns true if enough time has passed to emit an update (rate limiting).
    fn should_emit(&self) -> bool {
        match self.last_emit {
            Some(last) => last.elapsed() >= Duration::from_millis(1000),
            None => self.sample_count >= MIN_SAMPLES_FOR_CONFIDENCE,
        }
    }

    /// Marks that we just emitted an update.
    fn mark_emitted(&mut self) {
        self.last_emit = Some(Instant::now());
    }
}

/// Command sent to the latency monitor background task.
enum MonitorCommand {
    /// Start monitoring a stream/speaker pair.
    Start {
        stream_id: String,
        speaker_ip: String,
    },
    /// Stop all monitoring for a stream.
    StopStream { stream_id: String },
}

/// Latency monitoring service.
///
/// Measures audio playback latency by comparing stream position against
/// Sonos-reported playback position. Uses high-frequency polling and
/// statistical enhancement to achieve sub-second accuracy despite
/// `RelTime` only having second precision.
pub struct LatencyMonitor {
    /// Command sender for the background task.
    command_tx: mpsc::Sender<MonitorCommand>,
    /// Command receiver (taken when start() is called).
    command_rx: parking_lot::Mutex<Option<mpsc::Receiver<MonitorCommand>>>,
    /// Dependencies for the background task.
    sonos: Arc<dyn SonosPlayback>,
    stream_manager: Arc<StreamManager>,
    emitter: Arc<dyn EventEmitter>,
    cancel: CancellationToken,
}

impl LatencyMonitor {
    /// Creates a new LatencyMonitor.
    ///
    /// Note: Call `start()` to spawn the background monitoring task.
    /// This must be done from within an async context (Tokio runtime).
    ///
    /// # Arguments
    /// * `sonos` - Sonos client for position queries
    /// * `stream_manager` - Stream manager for timing information
    /// * `emitter` - Event emitter for latency updates
    /// * `cancel` - Cancellation token for graceful shutdown
    pub fn new(
        sonos: Arc<dyn SonosPlayback>,
        stream_manager: Arc<StreamManager>,
        emitter: Arc<dyn EventEmitter>,
        cancel: CancellationToken,
    ) -> Self {
        let (command_tx, command_rx) = mpsc::channel(32);

        Self {
            command_tx,
            command_rx: parking_lot::Mutex::new(Some(command_rx)),
            sonos,
            stream_manager,
            emitter,
            cancel,
        }
    }

    /// Starts the background monitoring task.
    ///
    /// Must be called from within a Tokio runtime context.
    /// Can only be called once; subsequent calls are no-ops.
    pub fn start(&self) {
        let command_rx = self.command_rx.lock().take();
        if let Some(rx) = command_rx {
            tauri::async_runtime::spawn(Self::run_monitor(
                Arc::clone(&self.sonos),
                Arc::clone(&self.stream_manager),
                Arc::clone(&self.emitter),
                rx,
                self.cancel.clone(),
            ));
        }
    }

    /// Starts monitoring latency for a stream/speaker pair.
    ///
    /// Call this when playback starts on a speaker.
    pub async fn start_monitoring(&self, stream_id: &str, speaker_ip: &str) {
        let _ = self
            .command_tx
            .send(MonitorCommand::Start {
                stream_id: stream_id.to_string(),
                speaker_ip: speaker_ip.to_string(),
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

    /// Background task that performs the actual monitoring.
    async fn run_monitor(
        sonos: Arc<dyn SonosPlayback>,
        stream_manager: Arc<StreamManager>,
        emitter: Arc<dyn EventEmitter>,
        mut command_rx: mpsc::Receiver<MonitorCommand>,
        cancel: CancellationToken,
    ) {
        let sessions: DashMap<SessionKey, LatencySession> = DashMap::new();
        let poll_interval = Duration::from_millis(POLL_INTERVAL_MS);

        log::info!("[LatencyMonitor] Background task started");

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    log::info!("[LatencyMonitor] Shutting down");
                    break;
                }

                Some(cmd) = command_rx.recv() => {
                    match cmd {
                        MonitorCommand::Start { stream_id, speaker_ip } => {
                            let key = (stream_id.clone(), speaker_ip.clone());
                            if !sessions.contains_key(&key) {
                                log::info!(
                                    "[LatencyMonitor] Starting monitoring: stream={}, speaker={}",
                                    stream_id, speaker_ip
                                );
                                sessions.insert(key, LatencySession::new());
                            }
                        }
                        MonitorCommand::StopStream { stream_id } => {
                            sessions.retain(|k, _| k.0 != stream_id);
                            log::info!(
                                "[LatencyMonitor] Stopped all monitoring for stream={}",
                                stream_id
                            );
                        }
                    }
                }

                _ = tokio::time::sleep(poll_interval) => {
                    // Poll all active sessions
                    for mut entry in sessions.iter_mut() {
                        // Extract key before mutable borrow to satisfy borrow checker
                        let (stream_id, speaker_ip) = entry.key().clone();
                        let session = entry.value_mut();

                        // Get stream for timing info
                        let stream = match stream_manager.get_stream(&stream_id) {
                            Some(s) => s,
                            None => continue,
                        };

                        // Get time elapsed since stream started (first frame received)
                        let stream_elapsed_ms = match stream.timing.elapsed_since_start() {
                            Some(d) => d.as_millis() as u64,
                            None => continue, // Stream hasn't received any frames yet
                        };

                        // Query Sonos position with RTT measurement
                        let start = Instant::now();
                        let position = match sonos.get_position_info(&speaker_ip).await {
                            Ok(p) => p,
                            Err(e) => {
                                log::trace!(
                                    "[LatencyMonitor] Failed to get position from {}: {}",
                                    speaker_ip, e
                                );
                                continue;
                            }
                        };
                        let rtt = start.elapsed();
                        let rtt_ms = rtt.as_millis() as u32;

                        // Verify Sonos is playing OUR stream (not previous content)
                        // Our stream URLs look like: http://192.168.x.x:port/stream/{stream_id}/audio.flac
                        if !position.track_uri.contains(&stream_id) {
                            log::debug!(
                                "[LatencyMonitor] Waiting for stream {} (current URI: {})",
                                stream_id,
                                position.track_uri
                            );
                            // Reset all state if Sonos switches away from our stream
                            session.reset_all();
                            continue;
                        }

                        log::trace!(
                            "[LatencyMonitor] URI matched: {} contains {}",
                            position.track_uri,
                            stream_id
                        );

                        // Calculate absolute latency (handles track restarts via offset)
                        let latency_ms = session.calculate_latency(
                            stream_elapsed_ms,
                            position.rel_time_ms,
                            rtt_ms,
                        );

                        session.record_latency(latency_ms);

                        // Emit update if appropriate
                        if session.should_emit() {
                            let event = LatencyEvent::Updated {
                                stream_id: stream_id.clone(),
                                speaker_ip: speaker_ip.clone(),
                                latency_ms: session.latency_ms(),
                                confidence: session.confidence(),
                                timestamp: now_millis(),
                            };
                            emitter.emit_latency(event);
                            session.mark_emitted();

                            log::debug!(
                                "[LatencyMonitor] stream={}, speaker={}: latency={}ms, confidence={:.2}",
                                stream_id,
                                speaker_ip,
                                session.latency_ms(),
                                session.confidence()
                            );
                        }
                    }
                }
            }
        }
    }
}
