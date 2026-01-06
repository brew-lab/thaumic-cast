//! Latency monitoring service for measuring audio playback delay.
//!
//! This service measures the latency between audio source and Sonos playback
//! by polling `GetPositionInfo` and comparing against stream timing.
//!
//! # Measurement Strategy
//!
//! Uses wall-clock timing comparison:
//! 1. Moderate-frequency polling (every 500ms) - sufficient for 1-second Sonos precision
//! 2. RTT compensation for network delay
//! 3. Exponential moving average for stability
//! 4. Incremental variance calculation for confidence scoring

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
    /// Sonos RelTime (ms) when playback was first detected.
    /// Used to calculate delta (how much Sonos has played since our stream started).
    baseline_sonos_ms: Option<u64>,
    /// Stream elapsed (ms) when baseline was captured.
    /// Used to calculate delta (how much audio we've sent since baseline).
    /// This is essential for handling metadata updates that cause Sonos to restart the track.
    baseline_stream_ms: Option<u64>,
    /// Last observed Sonos RelTime (ms) for detecting track restarts.
    /// When RelTime goes backwards significantly, we know the track restarted.
    last_sonos_reltime_ms: Option<u64>,
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
            baseline_sonos_ms: None,
            baseline_stream_ms: None,
            last_sonos_reltime_ms: None,
            ema_latency: 0.0,
            sample_count: 0,
            running_mean: 0.0,
            running_m2: 0.0,
            last_emit: None,
        }
    }

    /// Resets baseline positions (call when track changes or restarts).
    fn reset_baselines(&mut self) {
        self.baseline_sonos_ms = None;
        self.baseline_stream_ms = None;
        self.last_sonos_reltime_ms = None;
        self.ema_latency = 0.0;
        self.sample_count = 0;
        self.running_mean = 0.0;
        self.running_m2 = 0.0;
    }

    /// Calculates latency using stream timing and Sonos position.
    ///
    /// The approach:
    /// - Detect track restarts by checking if RelTime went backwards
    /// - Capture both stream and Sonos baselines together when playback first detected
    /// - Calculate deltas from those baselines
    /// - Latency = stream_delta - sonos_delta = buffer depth in pipeline
    ///
    /// Returns the latency in ms (positive = latency, negative = Sonos ahead somehow).
    /// Returns None if baselines were just reset (caller should skip this sample).
    fn calculate_latency(
        &mut self,
        stream_elapsed_ms: u64,
        sonos_reltime_ms: u64,
        rtt_ms: u32,
    ) -> Option<i64> {
        // Detect track restart: RelTime went backwards by more than 1 second
        // This happens when metadata updates cause Sonos to restart the track
        if let Some(last_reltime) = self.last_sonos_reltime_ms {
            if sonos_reltime_ms + 1000 < last_reltime {
                log::info!(
                    "[LatencyMonitor] Track restart detected: reltime {} -> {} (delta={}ms)",
                    last_reltime,
                    sonos_reltime_ms,
                    last_reltime as i64 - sonos_reltime_ms as i64
                );
                self.reset_baselines();
                // Don't return a measurement this cycle - let next poll capture fresh baseline
                return None;
            }
        }
        self.last_sonos_reltime_ms = Some(sonos_reltime_ms);

        // Capture both baselines together on first call (when Sonos starts playing our stream)
        if self.baseline_sonos_ms.is_none() {
            self.baseline_sonos_ms = Some(sonos_reltime_ms);
            self.baseline_stream_ms = Some(stream_elapsed_ms);
            log::info!(
                "[LatencyMonitor] Baseline captured: stream={}ms, sonos={}ms",
                stream_elapsed_ms,
                sonos_reltime_ms
            );
        }

        // Calculate deltas from baselines
        let stream_delta_ms =
            stream_elapsed_ms.saturating_sub(self.baseline_stream_ms.unwrap_or(0));
        let sonos_delta_ms = sonos_reltime_ms
            .saturating_sub(self.baseline_sonos_ms.unwrap_or(0))
            .saturating_add((rtt_ms / 2) as u64); // RTT/2 adjustment

        log::debug!(
            "[LatencyMonitor] stream_delta={}ms, sonos_delta={}ms (stream={}, sonos={}, rtt={}ms)",
            stream_delta_ms,
            sonos_delta_ms,
            stream_elapsed_ms,
            sonos_reltime_ms,
            rtt_ms
        );

        // Latency = (audio sent since baseline) - (audio played since baseline)
        // Positive = buffer building up in pipeline (normal, typically 2-3 seconds)
        // Negative = Sonos somehow ahead of us (shouldn't happen)
        Some((stream_delta_ms as i64) - (sonos_delta_ms as i64))
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
                            // Reset baselines if Sonos switches away from our stream
                            session.reset_baselines();
                            continue;
                        }

                        log::trace!(
                            "[LatencyMonitor] URI matched: {} contains {}",
                            position.track_uri,
                            stream_id
                        );

                        // Calculate latency (returns None if track restart detected)
                        let latency_ms = match session.calculate_latency(
                            stream_elapsed_ms,
                            position.rel_time_ms,
                            rtt_ms,
                        ) {
                            Some(ms) => ms,
                            None => continue, // Skip this cycle - baselines were just reset
                        };

                        log::debug!(
                            "[LatencyMonitor] stream_elapsed={}ms, sonos_reltime={}ms, latency={}ms, rtt={}ms",
                            stream_elapsed_ms,
                            position.rel_time_ms,
                            latency_ms,
                            rtt_ms
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
