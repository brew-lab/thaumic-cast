//! The session's absolute latency, which video sync uses.
//!
//! Latency is `stream_elapsed - sonos_reltime`, smoothed, with a jitter and a
//! confidence figure (see [`crate::services::speaker_monitor::monitor`] for
//! how it is measured). The same figure, unsmoothed, is the wall-clock
//! cushion whose level and trend go to the log.

use std::time::{Duration, Instant};

use crate::services::speaker_monitor::session::SpeakerSession;

/// How often each compressed-codec speaker's cushion and trend are written
/// to the log.
const DIAGNOSTIC_LOG_INTERVAL_SECS: u64 = 30;

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

/// Minimum samples needed before emitting latency updates.
const MIN_SAMPLES_FOR_CONFIDENCE: usize = 5;

/// EMA smoothing factor (higher = more responsive to changes).
const EMA_ALPHA: f64 = 0.3;

/// Incremental least-squares fit of cushion against time.
///
/// Answers one question: is the speaker's cushion shrinking, and how fast?
/// A steady negative slope means the speaker consumes audio faster than the
/// source produces it (its DAC clock runs ahead of the capture clock), and
/// since a live source can only ever deliver at its own rate, the cushion is
/// never replenished until playback restarts. Sample noise from the speaker's
/// one-second position precision averages out over a fit spanning minutes.
#[derive(Debug, Default, Clone, Copy)]
pub(super) struct CushionTrend {
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

impl SpeakerSession {
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
    pub(crate) fn calculate_latency(
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
    pub(crate) fn record_latency(&mut self, latency_ms: i64) {
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
    pub(crate) fn latency_ms(&self) -> u64 {
        self.ema_latency.max(0.0) as u64
    }

    /// Returns the current jitter (standard deviation) in milliseconds.
    ///
    /// Uses incrementally computed standard deviation from Welford's algorithm.
    pub(crate) fn jitter_ms(&self) -> u64 {
        if self.sample_count < 2 {
            return 0;
        }
        let variance = self.running_m2 / self.sample_count as f64;
        variance.sqrt().max(0.0) as u64
    }

    /// Returns the confidence score (0.0 - 1.0) based on measurement stability.
    ///
    /// Uses incrementally computed standard deviation - no heap allocation.
    pub(crate) fn confidence(&self) -> f32 {
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
    pub(crate) fn should_emit(&self) -> bool {
        match self.last_emit {
            Some(last) => last.elapsed() >= Duration::from_millis(1000),
            None => self.sample_count >= MIN_SAMPLES_FOR_CONFIDENCE,
        }
    }

    /// Marks that we just emitted an update.
    pub(crate) fn mark_emitted(&mut self) {
        self.last_emit = Some(Instant::now());
    }

    /// Writes the cushion, its extremes since the last line and its trend to
    /// the log every [`DIAGNOSTIC_LOG_INTERVAL_SECS`], and warns when the
    /// cushion is nearly gone or shrinking fast enough to be gone soon.
    ///
    /// This is what tells a field log apart: a stream whose server-side
    /// pipeline looks perfect can still go choppy for good if the speaker's
    /// cushion drains, and nothing else in the log can see that.
    pub(crate) fn log_diagnostics(&mut self, stream_id: &str, speaker_ip: &str, rtt_ms: u32) {
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::speaker_monitor::session::{
        MONITOR_POLL_DITHER_MS, MONITOR_POLL_INTERVAL_MS,
    };

    /// Feeds `minutes` of samples along `cushion(t)`, polled the way the
    /// monitor polls a monitor-only speaker: every two seconds plus a dither
    /// of up to a second, with the speaker's position reported in whole
    /// seconds, so each sample of the cushion is off by up to a second
    /// depending on the phase of the poll.
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
            t +=
                (MONITOR_POLL_INTERVAL_MS as f64 + dither * MONITOR_POLL_DITHER_MS as f64) / 1000.0;
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
