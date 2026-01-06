//! Latency monitoring service for measuring audio playback delay.
//!
//! This service measures the latency between audio source and Sonos playback
//! by polling `GetPositionInfo` and comparing against stream timing.
//!
//! # Measurement Strategy
//!
//! Since UPnP `RelTime` only has second precision, we use statistical enhancement:
//! 1. High-frequency polling (every 100ms)
//! 2. Second-boundary transition detection for sub-second accuracy
//! 3. RTT compensation for network delay
//! 4. Exponential moving average for stability

use std::collections::VecDeque;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::events::{EventEmitter, LatencyEvent};
use crate::sonos::traits::SonosPlayback;
use crate::stream::StreamManager;
use crate::utils::now_millis;

/// Default polling interval for position queries.
const DEFAULT_POLL_INTERVAL_MS: u64 = 100;

/// Minimum samples needed before emitting latency updates.
const MIN_SAMPLES_FOR_CONFIDENCE: usize = 5;

/// EMA smoothing factor (higher = more responsive to changes).
const EMA_ALPHA: f64 = 0.3;

/// Key for identifying a monitoring session (stream_id, speaker_ip).
type SessionKey = (String, String);

/// A single position measurement from the Sonos speaker.
#[derive(Debug, Clone)]
struct PositionSample {
    /// RelTime in seconds (from Sonos).
    rel_time_seconds: u32,
    /// Round-trip time for the SOAP call in milliseconds.
    rtt_ms: u32,
    /// When this sample was captured (adjusted for RTT/2).
    captured_at: Instant,
}

/// Tracks latency measurement state for a single speaker.
struct LatencySession {
    /// Stream ID being played.
    stream_id: String,
    /// Speaker IP address.
    speaker_ip: String,
    /// Last observed RelTime seconds value.
    last_rel_time_seconds: Option<u32>,
    /// Recent position samples for transition detection.
    samples: VecDeque<PositionSample>,
    /// Recent latency measurements for EMA calculation.
    measurements: VecDeque<i64>,
    /// Exponential moving average of latency.
    ema_latency: f64,
    /// When monitoring started for this session.
    started_at: Instant,
    /// When we last emitted an update.
    last_emit: Option<Instant>,
}

impl LatencySession {
    /// Creates a new monitoring session.
    fn new(stream_id: String, speaker_ip: String) -> Self {
        Self {
            stream_id,
            speaker_ip,
            last_rel_time_seconds: None,
            samples: VecDeque::with_capacity(50),
            measurements: VecDeque::with_capacity(50),
            ema_latency: 0.0,
            started_at: Instant::now(),
            last_emit: None,
        }
    }

    /// Adds a new position sample and returns true if a second-boundary transition was detected.
    fn add_sample(&mut self, sample: PositionSample) -> bool {
        let transition_detected = self
            .last_rel_time_seconds
            .map(|last| sample.rel_time_seconds > last)
            .unwrap_or(false);

        self.last_rel_time_seconds = Some(sample.rel_time_seconds);
        self.samples.push_back(sample);

        // Keep last 50 samples
        while self.samples.len() > 50 {
            self.samples.pop_front();
        }

        transition_detected
    }

    /// Records a new latency measurement and updates the EMA.
    fn record_latency(&mut self, latency_ms: i64) {
        self.measurements.push_back(latency_ms);

        // Keep last 50 measurements
        while self.measurements.len() > 50 {
            self.measurements.pop_front();
        }

        // Update EMA
        if self.ema_latency == 0.0 {
            self.ema_latency = latency_ms as f64;
        } else {
            self.ema_latency = EMA_ALPHA * latency_ms as f64 + (1.0 - EMA_ALPHA) * self.ema_latency;
        }
    }

    /// Returns the current latency estimate in milliseconds.
    fn latency_ms(&self) -> u64 {
        self.ema_latency.max(0.0) as u64
    }

    /// Returns the confidence score (0.0 - 1.0) based on measurement stability.
    fn confidence(&self) -> f32 {
        if self.measurements.len() < MIN_SAMPLES_FOR_CONFIDENCE {
            return 0.3; // Low confidence until we have enough samples
        }

        // Calculate standard deviation
        let values: Vec<f64> = self.measurements.iter().map(|&x| x as f64).collect();
        let mean = values.iter().sum::<f64>() / values.len() as f64;
        let variance = values.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / values.len() as f64;
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
            Some(last) => last.elapsed() >= Duration::from_millis(500),
            None => self.measurements.len() >= MIN_SAMPLES_FOR_CONFIDENCE,
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
    /// Stop monitoring a stream/speaker pair.
    Stop {
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

    /// Stops monitoring latency for a stream/speaker pair.
    ///
    /// Call this when playback stops on a speaker.
    pub async fn stop_monitoring(&self, stream_id: &str, speaker_ip: &str) {
        let _ = self
            .command_tx
            .send(MonitorCommand::Stop {
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
        let poll_interval = Duration::from_millis(DEFAULT_POLL_INTERVAL_MS);

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
                                sessions.insert(
                                    key,
                                    LatencySession::new(stream_id, speaker_ip),
                                );
                            }
                        }
                        MonitorCommand::Stop { stream_id, speaker_ip } => {
                            let key = (stream_id.clone(), speaker_ip.clone());
                            if sessions.remove(&key).is_some() {
                                log::info!(
                                    "[LatencyMonitor] Stopped monitoring: stream={}, speaker={}",
                                    stream_id, speaker_ip
                                );
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

                        // Get stream timing
                        let stream = match stream_manager.get_stream(&stream_id) {
                            Some(s) => s,
                            None => continue,
                        };

                        let stream_pos_ms = stream.timing.position_ms();
                        if stream_pos_ms == 0 {
                            // Stream hasn't started sending audio yet
                            continue;
                        }

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

                        // Create position sample
                        let sample = PositionSample {
                            rel_time_seconds: (position.rel_time_ms / 1000) as u32,
                            rtt_ms: rtt.as_millis() as u32,
                            captured_at: start + rtt / 2, // Best estimate of when Sonos sampled
                        };

                        // Add sample and check for transition
                        let _transition = session.add_sample(sample.clone());

                        // Calculate latency with RTT compensation
                        let adjusted_sonos_pos_ms = position.rel_time_ms + (sample.rtt_ms / 2) as u64;
                        let latency_ms = stream_pos_ms as i64 - adjusted_sonos_pos_ms as i64;

                        log::debug!(
                            "[LatencyMonitor] raw: stream_pos={}ms, sonos_pos={}ms (rel_time={}), rtt={}ms, raw_latency={}ms",
                            stream_pos_ms,
                            adjusted_sonos_pos_ms,
                            position.rel_time_ms,
                            sample.rtt_ms,
                            latency_ms
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
