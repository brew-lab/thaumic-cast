//! Latency monitoring service for measuring absolute audio playback delay.
//!
//! This service measures the end-to-end latency between audio source and Sonos
//! playback by polling `GetPositionInfo` and comparing against stream timing.
//! The absolute latency is suitable for video sync applications.
//!
//! # Measurement Strategy
//!
//! Uses epoch-based timing where each Sonos HTTP connection defines a playback epoch.
//! Measures absolute latency: `stream_elapsed - sonos_reltime`
//! - `stream_elapsed` = wall-clock time since audio epoch (T0 for this connection)
//! - `sonos_reltime` = Sonos playback position in the track
//! - Result = total pipeline delay (typically 0.5-2s for PCM, 15-25s for AAC)
//!
//! The audio epoch (T0) is anchored to the capture time of the first frame the
//! connection serves (the oldest prefill frame kept after the PCM cadence trims
//! the prefill), capturing buffer-before-GET time for accurate measurement.
//!
//! # Features
//!
//! - Per-speaker epochs (prevents stray requests from clobbering timing)
//! - Stale detection (emits `Stale` event after 30s without valid position)
//! - RTT compensation for network delay
//! - Exponential moving average for stability
//! - Incremental variance (jitter) calculation for confidence scoring
//! - Track restart detection to maintain continuity
//! - Isolated polls: each speaker's `GetPositionInfo` runs in its own task with
//!   a short timeout, so a speaker that stops answering never delays another

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::Arc;
use std::time::{Duration, Instant};

use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::events::{EventEmitter, LatencyEvent};
use crate::protocol_constants::POSITION_POLL_TIMEOUT_MS;
use crate::runtime::TokioSpawner;
use crate::sonos::traits::SonosPlayback;
use crate::sonos::types::PositionInfo;
use crate::stream::{PlaybackEpoch, StreamRegistry, StreamTiming};
use crate::utils::now_millis;

/// Polling interval for position queries.
/// 500ms is sufficient since Sonos RelTime only has 1-second precision.
const POLL_INTERVAL_MS: u64 = 500;

/// Environment variable that turns on position polling for every playing
/// speaker, not only those driving video sync, so the cushion and its trend
/// reach the log. Off by default: it is one SOAP call per speaker every
/// second and a half for the whole cast, and the link judgement no longer
/// needs it (it reads the stream connection's own TCP counters instead).
pub const SPEAKER_DIAGNOSTICS_ENV: &str = "THAUMIC_SPEAKER_DIAGNOSTICS";

/// Whether cushion diagnostics are switched on for this process.
pub fn speaker_diagnostics_enabled() -> bool {
    std::env::var_os(SPEAKER_DIAGNOSTICS_ENV).is_some_and(|v| !v.is_empty() && v != "0")
}

/// Polling interval for a speaker that is only being watched for diagnostics,
/// not driving video sync. With the dither below this is one poll every
/// second and a half on average: enough samples for a trend fit to resolve
/// a few tens of milliseconds per minute within ten minutes, while keeping a
/// large unsynced cast to a handful of SOAP calls a second.
const DIAGNOSTIC_POLL_INTERVAL_MS: u64 = 1000;

/// How often each speaker's cushion and trend are written to the log.
const DIAGNOSTIC_LOG_INTERVAL_SECS: u64 = 10;

/// Random delay added to every poll, in milliseconds.
///
/// The speaker reports its position in whole seconds, so each sample of the
/// cushion carries an error that depends on where in the speaker's second
/// the poll lands. Polling on a fixed cadence keeps that phase almost
/// constant, and under a slow drift it creeps linearly, which a trend fit
/// cannot tell from the drift itself. Spreading each poll by up to a full
/// second makes the phase uniform, so the error averages out instead.
const POLL_DITHER_MS: u64 = 1000;

/// Cushion below which a speaker is about to run dry. The pipeline latency
/// this service measures is the audio between capture and the speaker's
/// playhead; when it approaches zero the speaker has nothing left to play
/// ahead and every network hiccup becomes a dropout.
const LOW_CUSHION_MS: i64 = 150;

/// Cushion above which a low-cushion warning is re-armed.
const LOW_CUSHION_CLEAR_MS: i64 = 300;

/// A trend at least this steep, sustained over [`TREND_MIN_SPAN_SECS`] and
/// at least [`TREND_MIN_SIGMA`] standard errors from zero, is reported. The
/// source and the speaker run on different clocks and their rates never
/// match exactly; what matters is whether the mismatch will empty the cushion
/// within a session.
const TREND_WARN_MS_PER_MIN: f64 = 10.0;

/// How many standard errors from zero a slope must be before it is called a
/// trend. Each sample carries up to a second of noise from the speaker's
/// position precision, so a short window fits a steep slope out of nothing;
/// the standard error says how much of the slope is noise.
const TREND_MIN_SIGMA: f64 = 3.0;

/// Shortest span of samples a trend is trusted over.
const TREND_MIN_SPAN_SECS: f64 = 60.0;

/// Projected time to an empty cushion below which the trend is a warning.
const TREND_WARN_HORIZON_MIN: f64 = 15.0;

/// Consecutive failed polls (timeouts or errors) after which a speaker is
/// polled at [`BACKOFF_POLL_INTERVAL_MS`] until it answers again.
const BACKOFF_AFTER_FAILURES: u32 = 3;

/// Polling interval for a speaker that has stopped answering. Its polls cost
/// nothing to the other speakers (each runs in its own task), but there is
/// no point asking twice a second for an answer that is not coming.
const BACKOFF_POLL_INTERVAL_MS: u64 = 5000;

/// Minimum samples needed before emitting latency updates.
const MIN_SAMPLES_FOR_CONFIDENCE: usize = 5;

/// EMA smoothing factor (higher = more responsive to changes).
const EMA_ALPHA: f64 = 0.3;

/// Maximum time since last valid position before considering epoch stale.
/// If we haven't received valid position info in this window, something is wrong.
/// Should be >= 10 * POLL_INTERVAL_MS to avoid false positives during network blips.
const STALE_EPOCH_TIMEOUT_SECS: u64 = 30;

/// Key for identifying a monitoring session (stream_id, speaker_ip).
type SessionKey = (String, String);

/// What a spawned poll task hands back to the monitor loop, which alone owns
/// session state and applies it.
struct PollResult {
    key: SessionKey,
    /// Identifies the poll, so a late answer is applied only to the session
    /// that is still waiting for it.
    poll_id: u64,
    /// Epoch the poll was measured against.
    epoch_id: u64,
    /// Time since the epoch's audio T0, read just before the request.
    stream_elapsed_ms: u64,
    /// Request round-trip time.
    rtt_ms: u32,
    /// The speaker's answer, or why there was none.
    outcome: Result<PositionInfo, String>,
}

/// Result of epoch synchronization check.
enum EpochStatus {
    /// Valid epoch available for measurement.
    Valid(PlaybackEpoch),
    /// No epoch yet (Sonos hasn't started consuming from this IP).
    NoEpoch,
    /// Epoch exists but is stale (no valid position data recently).
    Stale,
}

/// Incremental least-squares fit of cushion against time.
///
/// Answers one question: is the speaker's cushion shrinking, and how fast?
/// A steady negative slope means the speaker consumes audio faster than the
/// source produces it (its DAC clock runs ahead of the capture clock), and
/// since a live source can only ever deliver at its own rate, the cushion is
/// never replenished until playback restarts. Sample noise from the speaker's
/// one-second position precision averages out over a fit spanning minutes.
#[derive(Debug, Default, Clone, Copy)]
struct CushionTrend {
    n: f64,
    sum_x: f64,
    sum_y: f64,
    sum_xx: f64,
    sum_xy: f64,
    sum_yy: f64,
    /// Seconds of samples covered so far.
    span_secs: f64,
}

/// A fitted trend: the slope and how sure the fit is of it.
#[derive(Debug, Clone, Copy)]
struct Trend {
    /// Milliseconds of cushion per minute of wall clock; negative is draining.
    slope_ms_per_min: f64,
    /// Standard error of the slope, in the same unit.
    error_ms_per_min: f64,
}

impl Trend {
    /// Whether the slope is far enough from zero to be more than noise.
    fn is_significant(&self) -> bool {
        self.slope_ms_per_min.abs() >= TREND_MIN_SIGMA * self.error_ms_per_min
    }
}

impl CushionTrend {
    /// Adds a sample: `x_secs` since the first sample, `y_ms` of cushion.
    fn add(&mut self, x_secs: f64, y_ms: f64) {
        self.n += 1.0;
        self.sum_x += x_secs;
        self.sum_y += y_ms;
        self.sum_xx += x_secs * x_secs;
        self.sum_xy += x_secs * y_ms;
        self.sum_yy += y_ms * y_ms;
        self.span_secs = x_secs;
    }

    /// Least-squares slope of cushion against time with its standard error,
    /// once there are enough samples spread in time to fit one.
    fn fit(&self) -> Option<Trend> {
        if self.n < 3.0 {
            return None;
        }
        let sxx = self.sum_xx - self.sum_x * self.sum_x / self.n;
        if sxx <= f64::EPSILON {
            return None;
        }
        let sxy = self.sum_xy - self.sum_x * self.sum_y / self.n;
        let syy = self.sum_yy - self.sum_y * self.sum_y / self.n;
        let slope = sxy / sxx;
        let residual_variance = ((syy - slope * sxy) / (self.n - 2.0)).max(0.0);
        let error = (residual_variance / sxx).sqrt();
        Some(Trend {
            slope_ms_per_min: slope * 60.0,
            error_ms_per_min: error * 60.0,
        })
    }
}

/// Tracks latency measurement state for a single speaker.
struct LatencySession {
    /// Whether measurements are sent to clients (video sync). Every session
    /// is logged; only these emit events.
    emit_events: bool,
    /// When the speaker was last polled, and the dithered interval before the next poll.
    last_poll: Option<Instant>,
    next_poll_after: Duration,
    /// Cushion trend over the current epoch.
    trend: CushionTrend,
    /// When the first trend sample of the current epoch was taken.
    trend_started: Option<Instant>,
    /// Most recent raw (unsmoothed) cushion, and its extremes since the last log line.
    last_raw_ms: i64,
    window_min_ms: i64,
    window_max_ms: i64,
    /// When the cushion and trend were last written to the log.
    last_diag_log: Option<Instant>,
    /// Whether the low-cushion warning is armed (re-armed once it recovers).
    low_cushion_warned: bool,
    /// When the shrinking-trend warning was last written.
    last_trend_warning: Option<Instant>,
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
    /// Last epoch ID we measured against.
    /// If this changes, Sonos reconnected and we need to reset.
    last_epoch_id: u64,
    /// When we last saw valid position info (for stale detection).
    last_valid_position: Option<Instant>,
    /// Whether we've already emitted a Stale event for the current stale state.
    /// Prevents spamming stale events; cleared when valid data resumes.
    stale_emitted: bool,
    /// The poll currently outstanding for this speaker, if any. A speaker is
    /// never polled again until its previous poll has answered or timed out.
    in_flight: Option<u64>,
    /// Polls in a row that timed out or failed; resets on any answer.
    consecutive_failures: u32,
}

impl LatencySession {
    /// Creates a new monitoring session.
    fn new(emit_events: bool) -> Self {
        Self {
            emit_events,
            last_poll: None,
            next_poll_after: Duration::ZERO,
            trend: CushionTrend::default(),
            trend_started: None,
            last_raw_ms: 0,
            window_min_ms: i64::MAX,
            window_max_ms: i64::MIN,
            last_diag_log: None,
            low_cushion_warned: false,
            last_trend_warning: None,
            last_sonos_reltime_ms: None,
            sonos_offset_ms: 0,
            ema_latency: 0.0,
            sample_count: 0,
            running_mean: 0.0,
            running_m2: 0.0,
            last_emit: None,
            last_epoch_id: 0,
            last_valid_position: None,
            stale_emitted: false,
            in_flight: None,
            consecutive_failures: 0,
        }
    }

    /// Resets all state when switching to a different stream or epoch.
    /// This clears everything including the position offset.
    fn reset_all(&mut self) {
        self.trend = CushionTrend::default();
        self.trend_started = None;
        self.window_min_ms = i64::MAX;
        self.window_max_ms = i64::MIN;
        self.low_cushion_warned = false;
        self.last_sonos_reltime_ms = None;
        self.sonos_offset_ms = 0;
        self.ema_latency = 0.0;
        self.sample_count = 0;
        self.running_mean = 0.0;
        self.running_m2 = 0.0;
        self.last_valid_position = None;
        self.stale_emitted = false;
    }

    /// Syncs with current epoch for a speaker IP.
    ///
    /// Returns the epoch status: Valid with epoch, NoEpoch if none exists,
    /// or Stale if we haven't received valid position data recently.
    /// Resets session if epoch changed, but seeds EMA with previous value
    /// to avoid "jump to 0 then climb back" behavior.
    fn sync_epoch(&mut self, timing: &StreamTiming, speaker_ip: IpAddr) -> EpochStatus {
        let epoch = match timing.current_epoch_for(speaker_ip) {
            Some(e) => e,
            None => return EpochStatus::NoEpoch,
        };

        if epoch.id != self.last_epoch_id {
            if self.last_epoch_id > 0 {
                log::info!(
                    "[LatencyMonitor] Epoch changed {} -> {}, resetting (seeding with {}ms)",
                    self.last_epoch_id,
                    epoch.id,
                    self.ema_latency as u64
                );
                // Preserve last EMA as seed for new epoch
                let seed_latency = self.ema_latency;
                self.reset_all();
                self.ema_latency = seed_latency;
            }
            self.last_epoch_id = epoch.id;
        }

        // Check for stale epoch (no valid position data in a while)
        if let Some(last_valid) = self.last_valid_position {
            if last_valid.elapsed().as_secs() > STALE_EPOCH_TIMEOUT_SECS {
                log::debug!(
                    "[LatencyMonitor] Epoch {} appears stale (no valid position for {}s)",
                    epoch.id,
                    last_valid.elapsed().as_secs()
                );
                return EpochStatus::Stale;
            }
        }

        EpochStatus::Valid(epoch)
    }

    /// Records that we received valid position info (for stale detection).
    /// Also clears stale_emitted flag so we can emit again if it goes stale later.
    fn record_valid_position(&mut self) {
        self.last_valid_position = Some(Instant::now());
        self.stale_emitted = false;
    }

    /// Marks that we've emitted a stale event (to prevent spam).
    fn mark_stale_emitted(&mut self) {
        self.stale_emitted = true;
    }

    /// Returns true if we should emit a stale event (not already emitted).
    fn should_emit_stale(&self) -> bool {
        !self.stale_emitted
    }

    /// Returns the last epoch ID we measured against.
    fn last_epoch_id(&self) -> u64 {
        self.last_epoch_id
    }

    /// Calculates absolute end-to-end latency for video sync.
    ///
    /// Latency = stream_elapsed - (sonos_reltime + offset)
    /// - `stream_elapsed` = time since audio epoch (T0 for this Sonos connection)
    /// - `sonos_reltime` = Sonos playback position (adjusted for RTT and offset)
    ///
    /// When Sonos restarts its track position (due to metadata updates), we
    /// recalculate the offset to maintain the current latency estimate, avoiding
    /// accumulation of errors from Sonos's 1-second precision.
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
        // When this happens, recalculate offset to maintain current latency estimate
        // This avoids accumulating errors from Sonos's 1-second precision
        if let Some(last_reltime) = self.last_sonos_reltime_ms {
            if sonos_reltime_ms < last_reltime.saturating_sub(100) {
                // Calculate offset to maintain current EMA latency
                // latency = stream - (sonos + offset) => offset = stream - sonos - latency
                let target_latency = self.ema_latency.max(0.0) as u64;
                let rtt_adj = (rtt_ms / 2) as u64;
                self.sonos_offset_ms = stream_elapsed_ms
                    .saturating_sub(sonos_reltime_ms)
                    .saturating_sub(rtt_adj)
                    .saturating_sub(target_latency);
                log::info!(
                    "[LatencyMonitor] Track restart: reltime {} -> {}, maintaining ~{}ms latency (offset={}ms)",
                    last_reltime,
                    sonos_reltime_ms,
                    target_latency,
                    self.sonos_offset_ms
                );
            }
        }
        self.last_sonos_reltime_ms = Some(sonos_reltime_ms);

        // Apply offset and RTT adjustment to get continuous Sonos position
        let continuous_sonos_ms = sonos_reltime_ms
            .saturating_add(self.sonos_offset_ms)
            .saturating_add((rtt_ms / 2) as u64);

        // Absolute latency = (time since audio epoch) - (continuous Sonos position)
        // Positive = audio in pipeline waiting to be played (normal)
        let latency_ms = (stream_elapsed_ms as i64) - (continuous_sonos_ms as i64);

        log::trace!(
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

        let started = *self.trend_started.get_or_insert_with(Instant::now);
        self.trend.add(started.elapsed().as_secs_f64(), value);
        self.last_raw_ms = latency_ms;
        self.window_min_ms = self.window_min_ms.min(latency_ms);
        self.window_max_ms = self.window_max_ms.max(latency_ms);

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

    /// Returns the current jitter (standard deviation) in milliseconds.
    ///
    /// Uses incrementally computed standard deviation from Welford's algorithm.
    fn jitter_ms(&self) -> u64 {
        if self.sample_count < 2 {
            return 0;
        }
        let variance = self.running_m2 / self.sample_count as f64;
        variance.sqrt().max(0.0) as u64
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

    /// Whether the speaker is due another position poll.
    fn poll_due(&self) -> bool {
        match self.last_poll {
            None => true,
            Some(at) => at.elapsed() >= self.next_poll_after,
        }
    }

    /// Records a poll and draws the dithered interval before the next one:
    /// the base cadence for this session plus up to [`POLL_DITHER_MS`],
    /// taken from the sub-second part of the wall clock, which is as good as
    /// random relative to the speaker's own second boundaries. A speaker that
    /// has stopped answering is polled every [`BACKOFF_POLL_INTERVAL_MS`].
    fn mark_polled(&mut self) {
        self.last_poll = Some(Instant::now());
        if self.consecutive_failures >= BACKOFF_AFTER_FAILURES {
            self.next_poll_after = Duration::from_millis(BACKOFF_POLL_INTERVAL_MS);
            return;
        }
        let base = if self.emit_events {
            POLL_INTERVAL_MS
        } else {
            DIAGNOSTIC_POLL_INTERVAL_MS
        };
        let dither = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| u64::from(d.subsec_nanos()) / 1_000_000)
            .unwrap_or(0)
            % POLL_DITHER_MS;
        self.next_poll_after = Duration::from_millis(base + dither);
    }

    /// Writes the cushion, its extremes since the last line and its trend to
    /// the log every [`DIAGNOSTIC_LOG_INTERVAL_SECS`], and warns when the
    /// cushion is nearly gone or shrinking fast enough to be gone soon.
    ///
    /// This is what tells a field log apart: a stream whose server-side
    /// pipeline looks perfect can still go choppy for good if the speaker's
    /// cushion drains, and nothing else in the log can see that.
    fn log_diagnostics(&mut self, stream_id: &str, speaker_ip: &str, rtt_ms: u32) {
        let raw = self.last_raw_ms;
        if raw < LOW_CUSHION_MS && !self.low_cushion_warned {
            self.low_cushion_warned = true;
            log::warn!(
                "[LatencyMonitor] stream={}, speaker={}: cushion nearly exhausted ({}ms of audio \
                 ahead of the playhead); expect dropouts until playback is restarted",
                stream_id,
                speaker_ip,
                raw
            );
        } else if raw >= LOW_CUSHION_CLEAR_MS {
            self.low_cushion_warned = false;
        }

        let due = match self.last_diag_log {
            None => self.sample_count >= MIN_SAMPLES_FOR_CONFIDENCE,
            Some(at) => at.elapsed().as_secs() >= DIAGNOSTIC_LOG_INTERVAL_SECS,
        };
        if !due {
            return;
        }
        self.last_diag_log = Some(Instant::now());

        let fitted = self.trend.fit();
        let trend = match fitted {
            Some(t) if self.trend.span_secs >= TREND_MIN_SPAN_SECS => format!(
                "{:+.1}\u{b1}{:.1}ms/min over {:.0}s",
                t.slope_ms_per_min, t.error_ms_per_min, self.trend.span_secs
            ),
            Some(_) => format!("(settling, {:.0}s of samples)", self.trend.span_secs),
            None => "(no trend yet)".to_string(),
        };
        log::info!(
            "[LatencyMonitor] stream={}, speaker={}: cushion={}ms (last {}ms, {}..{}ms since last \
             line, jitter {}ms), trend {}, rtt={}ms",
            stream_id,
            speaker_ip,
            self.latency_ms(),
            raw,
            self.window_min_ms,
            self.window_max_ms,
            self.jitter_ms(),
            trend,
            rtt_ms
        );
        self.window_min_ms = i64::MAX;
        self.window_max_ms = i64::MIN;

        if let Some(t) = fitted {
            let v = t.slope_ms_per_min;
            if self.trend.span_secs >= TREND_MIN_SPAN_SECS
                && v <= -TREND_WARN_MS_PER_MIN
                && t.is_significant()
            {
                let minutes_left = self.ema_latency.max(0.0) / -v;
                let warn_due = self
                    .last_trend_warning
                    .map_or(true, |at| at.elapsed().as_secs() >= 60);
                if minutes_left <= TREND_WARN_HORIZON_MIN && warn_due {
                    self.last_trend_warning = Some(Instant::now());
                    log::warn!(
                        "[LatencyMonitor] stream={}, speaker={}: cushion shrinking {:.1}\u{b1}{:.1}ms/min; \
                         at this rate the speaker runs dry in ~{:.1} min. The speaker is consuming audio \
                         faster than the source produces it (clock drift), and a live source cannot catch up.",
                        stream_id,
                        speaker_ip,
                        v,
                        t.error_ms_per_min,
                        minutes_left
                    );
                }
            }
        }
    }
}

/// Command sent to the latency monitor background task.
enum MonitorCommand {
    /// Start monitoring a stream/speaker pair.
    Start {
        stream_id: String,
        speaker_ip: String,
        /// Whether to send measurements to clients (video sync) as well as logging them.
        emit_events: bool,
    },
    /// Stop monitoring for a single speaker.
    StopSpeaker {
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
    stream_registry: Arc<StreamRegistry>,
    emitter: Arc<dyn EventEmitter>,
    cancel: CancellationToken,
    /// Task spawner for background tasks.
    spawner: TokioSpawner,
}

impl LatencyMonitor {
    /// Creates a new LatencyMonitor.
    ///
    /// Note: Call `start()` to spawn the background monitoring task.
    /// This must be done from within an async context (Tokio runtime).
    ///
    /// # Arguments
    /// * `sonos` - Sonos client for position queries
    /// * `stream_registry` - Stream registry for timing information
    /// * `emitter` - Event emitter for latency updates
    /// * `cancel` - Cancellation token for graceful shutdown
    /// * `spawner` - Task spawner for background tasks
    pub fn new(
        sonos: Arc<dyn SonosPlayback>,
        stream_registry: Arc<StreamRegistry>,
        emitter: Arc<dyn EventEmitter>,
        cancel: CancellationToken,
        spawner: TokioSpawner,
    ) -> Self {
        let (command_tx, command_rx) = mpsc::channel(32);

        Self {
            command_tx,
            command_rx: parking_lot::Mutex::new(Some(command_rx)),
            sonos,
            stream_registry,
            emitter,
            cancel,
            spawner,
        }
    }

    /// Starts the background monitoring task.
    ///
    /// Must be called from within a Tokio runtime context.
    /// Can only be called once; subsequent calls are no-ops.
    pub fn start(&self) {
        let command_rx = self.command_rx.lock().take();
        if let Some(rx) = command_rx {
            let sonos = Arc::clone(&self.sonos);
            let stream_registry = Arc::clone(&self.stream_registry);
            let emitter = Arc::clone(&self.emitter);
            let cancel = self.cancel.clone();
            let spawner = self.spawner.clone();
            self.spawner.spawn(async move {
                Self::run_monitor(sonos, stream_registry, emitter, rx, cancel, spawner).await;
            });
        }
    }

    /// Starts monitoring latency for a stream/speaker pair.
    ///
    /// Call this when playback starts on a speaker. Every speaker is polled
    /// and its cushion logged; with `emit_events` the measurements are also
    /// sent to clients, which video sync needs at the faster poll rate.
    pub async fn start_monitoring(&self, stream_id: &str, speaker_ip: &str, emit_events: bool) {
        let _ = self
            .command_tx
            .send(MonitorCommand::Start {
                stream_id: stream_id.to_string(),
                speaker_ip: speaker_ip.to_string(),
                emit_events,
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

    /// Stops monitoring for a single speaker.
    ///
    /// Call this when a speaker is removed from a multi-group cast.
    pub async fn stop_speaker(&self, stream_id: &str, speaker_ip: &str) {
        let _ = self
            .command_tx
            .send(MonitorCommand::StopSpeaker {
                stream_id: stream_id.to_string(),
                speaker_ip: speaker_ip.to_string(),
            })
            .await;
    }

    /// Background task that performs the actual monitoring.
    ///
    /// The loop never awaits a speaker. Each due poll runs in its own task,
    /// bounded by [`POSITION_POLL_TIMEOUT_MS`], and sends its result back on
    /// a channel; the loop applies it to the session, which it alone owns.
    /// A speaker that hangs therefore delays only its own next poll.
    async fn run_monitor(
        sonos: Arc<dyn SonosPlayback>,
        stream_registry: Arc<StreamRegistry>,
        emitter: Arc<dyn EventEmitter>,
        mut command_rx: mpsc::Receiver<MonitorCommand>,
        cancel: CancellationToken,
        spawner: TokioSpawner,
    ) {
        let mut sessions: HashMap<SessionKey, LatencySession> = HashMap::new();
        // Unbounded is safe: each session has at most one poll in flight.
        let (result_tx, mut result_rx) = mpsc::unbounded_channel::<PollResult>();
        let mut next_poll_id: u64 = 0;

        // Use interval instead of sleep to reduce timer allocations and prevent drift.
        // Delay mode skips missed ticks rather than bursting to catch up.
        let mut poll_interval = tokio::time::interval(Duration::from_millis(POLL_INTERVAL_MS));
        poll_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

        log::info!("[LatencyMonitor] Background task started");

        loop {
            tokio::select! {
                _ = cancel.cancelled() => {
                    log::info!("[LatencyMonitor] Shutting down");
                    break;
                }

                Some(cmd) = command_rx.recv() => {
                    match cmd {
                        MonitorCommand::Start { stream_id, speaker_ip, emit_events } => {
                            let key = (stream_id.clone(), speaker_ip.clone());
                            match sessions.get_mut(&key) {
                                Some(existing) => {
                                    // A video-sync start after a diagnostic one upgrades it.
                                    existing.emit_events |= emit_events;
                                }
                                None => {
                                    log::info!(
                                        "[LatencyMonitor] Starting monitoring: stream={}, speaker={}, events={}",
                                        stream_id, speaker_ip, emit_events
                                    );
                                    sessions.insert(key, LatencySession::new(emit_events));
                                }
                            }
                        }
                        MonitorCommand::StopSpeaker { stream_id, speaker_ip } => {
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

                Some(result) = result_rx.recv() => {
                    // The session may have been stopped while its poll was out.
                    if let Some(session) = sessions.get_mut(&result.key) {
                        apply_poll_result(session, result, emitter.as_ref());
                    }
                }

                _ = poll_interval.tick() => {
                    // Walk the sessions, spawning a poll for each one that is due and
                    // collecting orphaned ones for cleanup. Nothing here awaits.
                    // Sessions become orphaned when StreamGuard::drop removes the stream
                    // without calling stop_stream (e.g., WS handler panic/unexpected exit).
                    // Use Option to avoid Vec allocation on every poll (common case: no orphans).
                    let mut orphaned_keys: Option<Vec<SessionKey>> = None;

                    for (key, session) in sessions.iter_mut() {
                        let (stream_id, speaker_ip) = key;

                        // Get stream for timing info
                        let stream = match stream_registry.get_stream(stream_id) {
                            Some(s) => s,
                            None => {
                                // Stream no longer exists - mark session for removal
                                orphaned_keys
                                    .get_or_insert_with(Vec::new)
                                    .push(key.clone());
                                continue;
                            }
                        };

                        // Parse speaker IP and sync with current epoch for this speaker
                        let speaker_ip_addr: IpAddr = match speaker_ip.parse() {
                            Ok(ip) => ip,
                            Err(_) => {
                                log::warn!("[LatencyMonitor] Invalid speaker IP: {}", speaker_ip);
                                continue;
                            }
                        };

                        // Sync epoch - skip if no epoch yet, emit stale if stale
                        let epoch = match session.sync_epoch(&stream.timing, speaker_ip_addr) {
                            EpochStatus::Valid(e) => e,
                            EpochStatus::NoEpoch => continue, // Sonos hasn't started consuming yet
                            EpochStatus::Stale => {
                                // Emit stale event once per stale transition
                                if session.should_emit_stale() {
                                    let epoch_id = session.last_epoch_id();
                                    if session.emit_events {
                                        let event = LatencyEvent::Stale {
                                            stream_id: stream_id.clone(),
                                            speaker_ip: speaker_ip.clone(),
                                            epoch_id,
                                            timestamp: now_millis(),
                                        };
                                        emitter.emit_latency(event);
                                    }
                                    session.mark_stale_emitted();
                                    log::warn!(
                                        "[LatencyMonitor] Emitting stale: stream={}, speaker={}, epoch={}",
                                        stream_id,
                                        speaker_ip,
                                        epoch_id
                                    );
                                }
                                continue;
                            }
                        };

                        if session.in_flight.is_some() || !session.poll_due() {
                            continue;
                        }
                        session.mark_polled();
                        next_poll_id += 1;
                        session.in_flight = Some(next_poll_id);

                        spawner.spawn(poll_position(
                            Arc::clone(&sonos),
                            key.clone(),
                            next_poll_id,
                            epoch,
                            result_tx.clone(),
                        ));
                    }

                    // Clean up orphaned sessions (stream no longer exists).
                    // This handles cases where StreamGuard::drop removed the stream
                    // but stop_stream was never called (panic, unexpected exit, etc.).
                    if let Some(keys) = orphaned_keys {
                        for key in keys {
                            sessions.remove(&key);
                            log::info!(
                                "[LatencyMonitor] Pruned orphaned session: stream={}, speaker={}",
                                key.0,
                                key.1
                            );
                        }
                    }
                }
            }
        }
    }
}

/// Queries one speaker's position and sends the result back to the monitor.
///
/// Runs as its own task. The request is abandoned after
/// [`POSITION_POLL_TIMEOUT_MS`] whatever the transport's own timeout, so the
/// session is free to poll again soon after a speaker stops answering.
async fn poll_position(
    sonos: Arc<dyn SonosPlayback>,
    key: SessionKey,
    poll_id: u64,
    epoch: PlaybackEpoch,
    results: mpsc::UnboundedSender<PollResult>,
) {
    // Get time elapsed since audio epoch (T0 for this Sonos connection)
    let stream_elapsed_ms = epoch.audio_epoch.elapsed().as_millis() as u64;

    // Query Sonos position with RTT measurement
    let start = Instant::now();
    let outcome = match tokio::time::timeout(
        Duration::from_millis(POSITION_POLL_TIMEOUT_MS),
        sonos.get_position_info(&key.1),
    )
    .await
    {
        Ok(Ok(position)) => Ok(position),
        Ok(Err(e)) => Err(e.to_string()),
        Err(_) => Err(format!("no answer within {}ms", POSITION_POLL_TIMEOUT_MS)),
    };
    let rtt_ms = start.elapsed().as_millis() as u32;

    // The monitor has shut down if this fails; nothing to do.
    let _ = results.send(PollResult {
        key,
        poll_id,
        epoch_id: epoch.id,
        stream_elapsed_ms,
        rtt_ms,
        outcome,
    });
}

/// Applies a finished poll to its session: the latency sample, the
/// diagnostics log and, for video sync, the client event.
fn apply_poll_result(session: &mut LatencySession, poll: PollResult, emitter: &dyn EventEmitter) {
    if session.in_flight != Some(poll.poll_id) {
        // An answer for a poll this session is no longer waiting for.
        return;
    }
    session.in_flight = None;
    let (stream_id, speaker_ip) = &poll.key;

    let position = match poll.outcome {
        Ok(p) => p,
        Err(e) => {
            session.consecutive_failures = session.consecutive_failures.saturating_add(1);
            if session.consecutive_failures == BACKOFF_AFTER_FAILURES {
                log::info!(
                    "[LatencyMonitor] speaker={}: {} position polls in a row failed ({}); \
                     polling every {}s until it answers",
                    speaker_ip,
                    BACKOFF_AFTER_FAILURES,
                    e,
                    BACKOFF_POLL_INTERVAL_MS / 1000
                );
            } else {
                log::trace!(
                    "[LatencyMonitor] Failed to get position from {}: {}",
                    speaker_ip,
                    e
                );
            }
            return;
        }
    };
    if session.consecutive_failures >= BACKOFF_AFTER_FAILURES {
        log::info!(
            "[LatencyMonitor] speaker={}: answering position polls again after {} failures",
            speaker_ip,
            session.consecutive_failures
        );
    }
    session.consecutive_failures = 0;

    // The speaker reconnected while the poll was out; the next tick resets
    // the session for the new epoch, and this sample belongs to the old one.
    if poll.epoch_id != session.last_epoch_id() {
        return;
    }

    // Verify Sonos is playing OUR stream (not previous content)
    // Our stream URLs look like: http://192.168.x.x:port/stream/{stream_id}/live.wav
    if !position.track_uri.contains(stream_id.as_str()) {
        log::debug!(
            "[LatencyMonitor] Waiting for stream {} (current URI: {})",
            stream_id,
            position.track_uri
        );
        // Reset all state if Sonos switches away from our stream
        session.reset_all();
        return;
    }

    log::trace!(
        "[LatencyMonitor] URI matched: {} contains {}",
        position.track_uri,
        stream_id
    );

    // Calculate absolute latency (handles track restarts via offset)
    let latency_ms =
        session.calculate_latency(poll.stream_elapsed_ms, position.rel_time_ms, poll.rtt_ms);

    // Record that we received valid position info (for stale detection)
    session.record_valid_position();

    session.record_latency(latency_ms);
    session.log_diagnostics(stream_id, speaker_ip, poll.rtt_ms);

    // Emit update if appropriate
    if session.emit_events && session.should_emit() {
        let event = LatencyEvent::Updated {
            stream_id: stream_id.clone(),
            speaker_ip: speaker_ip.clone(),
            epoch_id: poll.epoch_id,
            latency_ms: session.latency_ms(),
            jitter_ms: session.jitter_ms(),
            confidence: session.confidence(),
            timestamp: now_millis(),
        };
        emitter.emit_latency(event);
        session.mark_emitted();

        log::debug!(
            "[LatencyMonitor] stream={}, speaker={}: latency={}ms, jitter={}ms, confidence={:.2}",
            stream_id,
            speaker_ip,
            session.latency_ms(),
            session.jitter_ms(),
            session.confidence()
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Feeds `minutes` of samples along `cushion(t)`, polled the way the
    /// monitor polls a diagnostic session: every second plus a dither of up
    /// to a second, with the speaker's position reported in whole seconds, so
    /// each sample of the cushion is off by up to a second depending on the
    /// phase of the poll.
    fn fit(minutes: f64, cushion: impl Fn(f64) -> f64) -> Trend {
        let mut trend = CushionTrend::default();
        let mut t: f64 = 0.0;
        // Small deterministic LCG for the dither so the test is repeatable.
        let mut seed: u64 = 0x2545_f491_4f6c_dd1d;
        while t <= minutes * 60.0 {
            trend.add(t, observed_cushion(t, cushion(t)));
            seed = seed
                .wrapping_mul(6364136223846793005)
                .wrapping_add(1442695040888963407);
            let dither = (seed >> 33) as f64 / (1u64 << 31) as f64;
            t += 1.0 + dither;
        }
        trend.fit().expect("enough samples")
    }

    /// The cushion the monitor computes at time `t` when the true cushion is
    /// `true_ms`: the speaker reports its playhead floored to a whole second.
    fn observed_cushion(t: f64, true_ms: f64) -> f64 {
        let playhead_ms = t * 1000.0 - true_ms;
        let reported_ms = (playhead_ms / 1000.0).floor() * 1000.0;
        t * 1000.0 - reported_ms
    }

    #[test]
    fn a_steady_cushion_fits_a_flat_trend_within_its_own_error() {
        let trend = fit(10.0, |_| 800.0);
        assert!(
            !trend.is_significant(),
            "flat cushion read as a trend: {trend:?}"
        );
        assert!(trend.error_ms_per_min < 8.0, "{trend:?}");
    }

    #[test]
    fn a_draining_cushion_is_measured_through_the_position_precision() {
        // 40 ms/min: the rate that empties a 200 ms prefill in five minutes.
        let trend = fit(10.0, |t| 800.0 - t * (40.0 / 60.0));
        assert!(trend.is_significant(), "{trend:?}");
        assert!(
            (trend.slope_ms_per_min + 40.0).abs() <= TREND_MIN_SIGMA * trend.error_ms_per_min,
            "{trend:?}"
        );
        assert!(trend.error_ms_per_min < 8.0, "{trend:?}");
    }

    #[test]
    fn a_fixed_poll_phase_would_report_a_confidently_wrong_drift() {
        // Why the poll is dithered: on a fixed cadence the whole-second
        // reporting error creeps with the drift, so the fit sees a clean line
        // with a tiny error at the wrong slope. This documents the failure.
        let mut trend = CushionTrend::default();
        let mut t: f64 = 0.0;
        while t <= 600.0 {
            trend.add(t, observed_cushion(t, 800.0 - t * (40.0 / 60.0)));
            t += 1.0;
        }
        let fitted = trend.fit().expect("enough samples");
        assert!(
            (fitted.slope_ms_per_min + 40.0).abs() > TREND_MIN_SIGMA * fitted.error_ms_per_min,
            "fixed-phase fit happened to be right: {fitted:?}"
        );
    }

    mod polling {
        use super::super::*;
        use crate::error::SoapResult;
        use crate::events::{NetworkEvent, SonosEvent, StreamEvent, TopologyEvent};
        use crate::state::StreamingConfig;
        use crate::stream::{AudioCodec, AudioFormat, StreamMetadata};
        use async_trait::async_trait;

        const HUNG_IPS: [&str; 3] = ["192.168.1.10", "192.168.1.12", "192.168.1.13"];
        const HUNG_IP: &str = HUNG_IPS[0];
        const HEALTHY_IP: &str = "192.168.1.11";

        /// How long each test watches the speakers.
        const WATCH: Duration = Duration::from_millis(5500);

        /// Speaker double: the [`HUNG_IPS`] never answer within ten seconds,
        /// every other speaker answers at once. Records when each
        /// `GetPositionInfo` call starts.
        struct FakeSpeakers {
            stream_id: String,
            calls: parking_lot::Mutex<Vec<(String, Instant)>>,
        }

        impl FakeSpeakers {
            fn calls_to(&self, ip: &str) -> Vec<Instant> {
                self.calls
                    .lock()
                    .iter()
                    .filter(|(called, _)| called == ip)
                    .map(|(_, at)| *at)
                    .collect()
            }
        }

        #[async_trait]
        impl SonosPlayback for FakeSpeakers {
            async fn play_uri(
                &self,
                _: &str,
                _: &str,
                _: AudioCodec,
                _: &AudioFormat,
                _: Option<&StreamMetadata>,
                _: &str,
            ) -> SoapResult<()> {
                Ok(())
            }
            async fn play(&self, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn stop(&self, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn switch_to_queue(&self, _: &str, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn get_position_info(&self, ip: &str) -> SoapResult<PositionInfo> {
                self.calls.lock().push((ip.to_string(), Instant::now()));
                if HUNG_IPS.contains(&ip) {
                    tokio::time::sleep(Duration::from_secs(10)).await;
                }
                Ok(PositionInfo {
                    track_uri: format!("http://10.0.0.1:1400/stream/{}/live.wav", self.stream_id),
                    rel_time_ms: 0,
                })
            }
            async fn join_group(&self, _: &str, _: &str) -> SoapResult<()> {
                Ok(())
            }
            async fn leave_group(&self, _: &str) -> SoapResult<()> {
                Ok(())
            }
        }

        struct NoEvents;

        impl EventEmitter for NoEvents {
            fn emit_stream(&self, _: StreamEvent) {}
            fn emit_sonos(&self, _: SonosEvent) {}
            fn emit_network(&self, _: NetworkEvent) {}
            fn emit_topology(&self, _: TopologyEvent) {}
            fn emit_latency(&self, _: LatencyEvent) {}
        }

        /// Starts a monitor watching three hung speakers and one healthy one,
        /// all already fetching a live stream, and returns the speaker double.
        async fn watch_hung_and_healthy_speakers(cancel: &CancellationToken) -> Arc<FakeSpeakers> {
            let registry = Arc::new(StreamRegistry::new(StreamingConfig::default()));
            let stream_id = registry
                .create_stream(AudioCodec::Pcm, AudioFormat::default(), 200, 10)
                .expect("stream");
            let stream = registry.get_stream(&stream_id).expect("stream");
            for ip in HUNG_IPS.iter().chain([&HEALTHY_IP]) {
                stream.timing.start_new_epoch(
                    Some(Instant::now()),
                    Instant::now(),
                    ip.parse().unwrap(),
                );
            }
            let speakers = Arc::new(FakeSpeakers {
                stream_id: stream_id.clone(),
                calls: parking_lot::Mutex::new(Vec::new()),
            });
            let monitor = LatencyMonitor::new(
                Arc::clone(&speakers) as Arc<dyn SonosPlayback>,
                registry,
                Arc::new(NoEvents),
                cancel.clone(),
                TokioSpawner::new(tokio::runtime::Handle::current()),
            );
            monitor.start();
            for ip in HUNG_IPS.iter().chain([&HEALTHY_IP]) {
                monitor.start_monitoring(&stream_id, ip, true).await;
            }
            speakers
        }

        #[tokio::test]
        async fn a_hung_speaker_does_not_delay_another_speakers_polls_by_more_than_50ms() {
            let cancel = CancellationToken::new();
            let speakers = watch_hung_and_healthy_speakers(&cancel).await;
            tokio::time::sleep(WATCH).await;
            cancel.cancel();

            let healthy = speakers.calls_to(HEALTHY_IP);
            let grid_start = speakers
                .calls
                .lock()
                .first()
                .expect("speakers were polled")
                .1;
            // First poll on the first or second tick, then at most 1.5 s apart
            // (500 ms plus the full dither, which lands on a tick): at least
            // four in 5.5 s. A loop that waited out each hung speaker's
            // 1.5 s timeout in turn would be blocked almost the whole time.
            assert!(
                healthy.len() >= 4,
                "healthy speaker polled {} times in {WATCH:?}",
                healthy.len()
            );
            // Polls are only ever issued on the monitor's 500 ms tick, whose
            // first firing issued the first poll. A poll that lands more than
            // 50 ms off that grid was held up by something.
            let tick = POLL_INTERVAL_MS as u128;
            for at in &healthy {
                let offset = at.saturating_duration_since(grid_start).as_millis() % tick;
                let lateness = offset.min(tick - offset);
                assert!(
                    lateness <= 50,
                    "healthy speaker polled {lateness} ms off its tick"
                );
            }
        }

        #[tokio::test]
        async fn a_hung_speaker_is_polled_again_only_after_its_poll_times_out() {
            let cancel = CancellationToken::new();
            let speakers = watch_hung_and_healthy_speakers(&cancel).await;
            tokio::time::sleep(WATCH).await;
            cancel.cancel();

            let hung = speakers.calls_to(HUNG_IP);
            assert!(
                hung.len() >= 2,
                "a poll that never answers must be abandoned, not waited on: {} polls",
                hung.len()
            );
            for pair in hung.windows(2) {
                let gap = pair[1].duration_since(pair[0]);
                assert!(
                    gap >= Duration::from_millis(POSITION_POLL_TIMEOUT_MS),
                    "second poll issued {gap:?} after the first, while it was still in flight"
                );
            }
        }

        fn poll(poll_id: u64, outcome: Result<PositionInfo, String>) -> PollResult {
            PollResult {
                key: ("stream".to_string(), HUNG_IP.to_string()),
                poll_id,
                epoch_id: 0,
                stream_elapsed_ms: 1000,
                rtt_ms: 10,
                outcome,
            }
        }

        #[test]
        fn three_failed_polls_back_off_until_the_speaker_answers() {
            let mut session = LatencySession::new(true);
            for poll_id in 1..=BACKOFF_AFTER_FAILURES as u64 {
                session.mark_polled();
                assert!(session.next_poll_after < Duration::from_millis(BACKOFF_POLL_INTERVAL_MS));
                session.in_flight = Some(poll_id);
                apply_poll_result(
                    &mut session,
                    poll(poll_id, Err("timeout".into())),
                    &NoEvents,
                );
                assert_eq!(session.in_flight, None);
            }
            session.mark_polled();
            assert_eq!(
                session.next_poll_after,
                Duration::from_millis(BACKOFF_POLL_INTERVAL_MS)
            );

            session.in_flight = Some(99);
            let answer = PositionInfo {
                track_uri: String::new(),
                rel_time_ms: 0,
            };
            apply_poll_result(&mut session, poll(99, Ok(answer)), &NoEvents);
            assert_eq!(session.consecutive_failures, 0);
            session.mark_polled();
            assert!(session.next_poll_after < Duration::from_millis(BACKOFF_POLL_INTERVAL_MS));
        }

        #[test]
        fn an_answer_to_a_poll_the_session_no_longer_awaits_is_ignored() {
            let mut session = LatencySession::new(true);
            session.in_flight = Some(2);
            apply_poll_result(&mut session, poll(1, Err("timeout".into())), &NoEvents);
            assert_eq!(session.in_flight, Some(2));
            assert_eq!(session.consecutive_failures, 0);
        }
    }

    #[test]
    fn a_trend_needs_three_samples_spread_in_time() {
        let mut trend = CushionTrend::default();
        assert!(trend.fit().is_none());
        trend.add(0.0, 500.0);
        trend.add(0.0, 600.0);
        trend.add(0.0, 550.0);
        assert!(trend.fit().is_none(), "no spread in time");
        trend.add(60.0, 400.0);
        assert!(trend.fit().is_some());
    }
}
