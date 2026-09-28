//! A simulated speaker pulling a real cadence stream, for scenario tests.
//!
//! [`SimSpeaker`] pulls frames from a real [`create_wav_stream_with_cadence`]
//! stream on paused tokio time, counts them into a real [`ConnectionTap`] the
//! way the HTTP body does, and plays them at its own clock rate from a buffer
//! it fills to `prebuffer_ms` before starting (and again after running dry).
//! It answers position polls from its own playhead, whole seconds, with tick
//! jitter, at the monitor-only cadence, and hands every answer to a real
//! [`ReserveTracker`]. Because the simulation knows the true reserve at every
//! moment, the scenarios can hold the estimator to it.
//!
//! This is the measurement half of the simulator the plan describes; link
//! stalls, refetches and the drift compensator belong to the scenarios that
//! need them.

use std::net::IpAddr;
use std::pin::Pin;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Instant;

use bytes::Bytes;
use futures::{Stream, StreamExt};
use tokio::sync::broadcast;

use super::bounds::PollObservation;
use super::clock_fit::ClockEstimate;
use super::reserve::ReserveEstimate;
use super::segment::SegmentBreak;
use super::test_support::Lcg;
use super::tracker::ReserveTracker;
use crate::stream::cadence::{create_wav_stream_with_cadence, CadenceConfig, LoggingStreamGuard};
use crate::stream::manager::TimestampedFrame;
use crate::stream::tap::WAV_HEADER_BYTES;
use crate::stream::{AudioCodec, AudioFormat, ConnectionTap};

/// Frame length the stream runs at, as in production.
const FRAME_MS: u32 = 10;

/// Jitter buffer of the simulated stream, as in production.
const JITTER_BUFFER_MS: u64 = 200;

/// How often the tracker is asked for an estimate, as the monitor does.
const ESTIMATE_EVERY_MS: f64 = 30_000.0;

/// The track URI the speaker reports.
const TRACK_URI: &str = "http://10.0.0.1:49400/stream/sim/live.wav";

/// A simulated speaker.
#[derive(Debug, Clone)]
pub(crate) struct SimSpeaker {
    /// How much faster the speaker plays than our clock runs, in ppm.
    pub clock_ppm: f64,
    /// Audio the speaker buffers before it starts playing, and again after
    /// running dry: its initial reserve.
    pub prebuffer_ms: f64,
    /// Round trip of each poll, drawn uniformly from this range.
    pub rtt_ms: (f64, f64),
    /// Uniform jitter, ± this, on where the reported second ticks over.
    pub tick_jitter_ms: f64,
    /// Whether the speaker rounds its playhead instead of truncating it.
    pub round_reltime: bool,
    /// Seed for the poll dither, round trips and jitter.
    pub seed: u64,
}

impl Default for SimSpeaker {
    fn default() -> Self {
        Self {
            clock_ppm: 0.0,
            prebuffer_ms: 700.0,
            rtt_ms: (5.0, 40.0),
            tick_jitter_ms: 0.0,
            round_reltime: false,
            seed: 1,
        }
    }
}

/// One 30 s estimate and the truth at its moment.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SimEstimate {
    /// Simulated time, ms since the connection started.
    pub at: f64,
    /// The tracker's reserve estimate, if it made one.
    pub reserve: Option<ReserveEstimate>,
    /// The true reserve.
    pub true_reserve_ms: f64,
    /// The tracker's clock estimate.
    pub clock: Option<ClockEstimate>,
    /// The tracker's projected time to empty.
    pub time_to_empty_s: Option<f64>,
    /// The segment break the estimate revealed, if any.
    pub brk: Option<SegmentBreak>,
}

/// What a simulation run saw.
#[derive(Debug, Default)]
pub(crate) struct SimReport {
    /// When the speaker ran dry, ms since the connection started.
    pub underruns: Vec<f64>,
    /// Every 30 s estimate.
    pub estimates: Vec<SimEstimate>,
}

/// The speaker's buffer and playhead.
struct Playback {
    rate: f64,
    prebuffer_ms: f64,
    playing: bool,
    /// Audio played, ms.
    played_ms: f64,
    /// When `played_ms` was last brought up to date.
    at: f64,
}

impl Playback {
    /// Brings the playhead up to `now`, given `received_ms` of audio in hand,
    /// and returns the time it ran dry, if it did.
    fn advance(&mut self, now: f64, received_ms: f64) -> Option<f64> {
        let mut dry_at = None;
        if self.playing {
            let played = self.played_ms + (now - self.at) * self.rate;
            if played >= received_ms {
                dry_at = Some(self.at + (received_ms - self.played_ms) / self.rate);
                self.played_ms = received_ms;
                self.playing = false;
            } else {
                self.played_ms = played;
            }
        }
        self.at = now;
        if !self.playing && received_ms - self.played_ms >= self.prebuffer_ms {
            self.playing = true;
        }
        dry_at
    }

    /// The playhead at `t`, no earlier than the last update.
    fn playhead_at(&self, t: f64) -> f64 {
        if self.playing {
            self.played_ms + (t - self.at).max(0.0) * self.rate
        } else {
            self.played_ms
        }
    }
}

/// A poll that has been sent and not yet answered.
struct PendingPoll {
    ts: f64,
    read_at: f64,
    tr: f64,
    d_ts_ms: f64,
    rel_ms: Option<u64>,
}

impl SimSpeaker {
    /// Runs the speaker against a live stream for `minutes` of simulated
    /// time, or until it first runs dry if `stop_at_underrun`. Must run on a
    /// runtime with paused time.
    pub(crate) async fn run(&self, minutes: f64, stop_at_underrun: bool) -> SimReport {
        let format = AudioFormat::default();
        let frame_bytes = format.frame_bytes(FRAME_MS);
        let byte_rate = format.frame_bytes(1000) as f64;
        let ip: IpAddr = "192.168.2.204".parse().expect("address");

        let (tx, rx) = broadcast::channel::<Bytes>(64);
        let guard = Arc::new(LoggingStreamGuard::new("sim".into(), ip));
        let tap = ConnectionTap::new(
            "sim",
            ip,
            Instant::now(),
            AudioCodec::Pcm,
            &format,
            Arc::clone(&guard),
            true,
        );
        let audio = Bytes::from(vec![0x11u8; frame_bytes]);
        let prefill = (0..JITTER_BUFFER_MS / u64::from(FRAME_MS))
            .map(|_| TimestampedFrame {
                captured_at: Instant::now(),
                data: audio.clone(),
            })
            .collect();
        let config = CadenceConfig::new(
            format.silence_frame(FRAME_MS),
            JITTER_BUFFER_MS,
            FRAME_MS,
            format,
            prefill,
        );
        let mut stream: Pin<Box<dyn Stream<Item = std::io::Result<Bytes>>>> = Box::pin(
            create_wav_stream_with_cadence(rx, Arc::clone(&guard), config, None, None),
        );
        // The body sends the WAV header first, and counts it.
        guard
            .bytes_sent
            .fetch_add(u64::from(WAV_HEADER_BYTES), Ordering::Relaxed);

        let mut rng = Lcg::new(self.seed);
        let mut playback = Playback {
            rate: 1.0 + self.clock_ppm * 1e-6,
            prebuffer_ms: self.prebuffer_ms,
            playing: false,
            played_ms: 0.0,
            at: 0.0,
        };
        let mut tracker = ReserveTracker::new();
        tracker.start_connection(true);
        let mut report = SimReport::default();
        let mut pending: Option<PendingPoll> = None;
        let mut next_poll = 5_000.0;
        let mut next_estimate = ESTIMATE_EVERY_MS;

        let start = tokio::time::Instant::now();
        let end = minutes * 60_000.0;
        loop {
            // The source delivers one frame per frame period, just ahead of
            // the metronome tick that sends it on.
            let _ = tx.send(audio.clone());
            let Some(Ok(frame)) = stream.next().await else {
                break;
            };
            guard
                .bytes_sent
                .fetch_add(frame.len() as u64, Ordering::Relaxed);
            let now = start.elapsed().as_secs_f64() * 1000.0;
            let received_ms = tap.audio_bytes_sent() as f64 * 1000.0 / byte_rate;

            // Read the playhead for a poll whose read moment falls in this
            // frame period, before the playhead moves past it.
            if let Some(p) = pending.as_mut() {
                if p.rel_ms.is_none() && p.read_at <= now {
                    let jitter = rng.range(-self.tick_jitter_ms, self.tick_jitter_ms.max(1e-9));
                    let head = (playback.playhead_at(p.read_at) + jitter) / 1000.0;
                    let secs = if self.round_reltime {
                        head.round()
                    } else {
                        head.floor()
                    };
                    p.rel_ms = Some(secs.max(0.0) as u64 * 1000);
                }
            }

            if let Some(dry_at) = playback.advance(now, received_ms) {
                report.underruns.push(dry_at);
                if stop_at_underrun {
                    break;
                }
            }

            let delivered = tap.delivered_ms().expect("pcm") as f64;
            if pending.as_ref().is_some_and(|p| p.tr <= now) {
                let p = pending.take().expect("pending");
                let obs = PollObservation {
                    ts: p.ts,
                    tr: p.tr,
                    rel_ms: p.rel_ms.expect("read before answered"),
                    d_ts_ms: p.d_ts_ms,
                    d_tr_ms: delivered,
                };
                tracker.observe(&obs, TRACK_URI, false);
            }
            if pending.is_none() && now >= next_poll {
                let rtt = rng.range(self.rtt_ms.0, self.rtt_ms.1);
                pending = Some(PendingPoll {
                    ts: now,
                    read_at: now + rng.unit() * rtt,
                    tr: now + rtt,
                    d_ts_ms: delivered,
                    rel_ms: None,
                });
                next_poll = now + 2000.0 + rng.unit() * 1000.0;
            }

            if now >= next_estimate {
                let (reserve, brk) = tracker.estimate(now);
                report.estimates.push(SimEstimate {
                    at: now,
                    reserve,
                    true_reserve_ms: delivered - playback.playhead_at(now),
                    clock: tracker.clock(),
                    time_to_empty_s: tracker.time_to_empty_s(),
                    brk,
                });
                next_estimate += ESTIMATE_EVERY_MS;
            }
            if now >= end {
                break;
            }
        }
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MINUTE: f64 = 60_000.0;

    /// Every error within `worst` ms and their RMS within `rms`.
    fn assert_accurate(errors: &[f64], worst: f64, rms: f64) {
        assert!(!errors.is_empty());
        let max = errors.iter().fold(0f64, |a, e| a.max(e.abs()));
        let actual_rms = (errors.iter().map(|e| e * e).sum::<f64>() / errors.len() as f64).sqrt();
        assert!(max <= worst, "worst error {max:.0} ms: {errors:?}");
        assert!(
            actual_rms <= rms,
            "RMS error {actual_rms:.0} ms: {errors:?}"
        );
    }

    /// The field case: a speaker 40 ppm fast against a live source, which
    /// cannot run ahead of real time. Its reserve drains at 2.4 ms a minute
    /// until it runs dry. The prebuffer is shortened from the field's ~750 ms
    /// so the underrun lands inside two simulated hours; the drain is linear,
    /// so nothing else changes.
    #[tokio::test(start_paused = true)]
    async fn plus_40ppm_uncompensated_underruns_before_2h() {
        let speaker = SimSpeaker {
            clock_ppm: 40.0,
            prebuffer_ms: 250.0,
            tick_jitter_ms: 50.0,
            seed: 7,
            ..SimSpeaker::default()
        };
        let report = speaker.run(120.0, true).await;

        let dry_at = *report.underruns.first().expect("the speaker runs dry");
        // 250 ms at 2.4 ms/min is 104 minutes.
        assert!(
            dry_at > 95.0 * MINUTE && dry_at < 115.0 * MINUTE,
            "ran dry at {:.1} min",
            dry_at / MINUTE
        );

        // The estimator followed the true reserve down while it was locked.
        let locked: Vec<&SimEstimate> = report
            .estimates
            .iter()
            .filter(|e| e.reserve.is_some_and(|r| r.locked))
            .collect();
        assert!(
            locked.len() * 10 >= report.estimates.len() * 8,
            "locked for {} of {} estimates",
            locked.len(),
            report.estimates.len()
        );
        let errors: Vec<f64> = locked
            .iter()
            .map(|e| e.reserve.expect("locked").reserve_ms - e.true_reserve_ms)
            .collect();
        assert_accurate(&errors, 80.0, 35.0);

        // The clock was measured, from the playhead alone.
        let clock = report
            .estimates
            .iter()
            .rev()
            .find_map(|e| e.clock)
            .expect("clock");
        assert!(
            (clock.ppm - 40.0).abs() <= 15.0,
            "clock {clock:?} after {:.0} min",
            dry_at / MINUTE
        );

        // And the drain was projected well before the speaker ran dry.
        let warned_at = report
            .estimates
            .iter()
            .find(|e| e.time_to_empty_s.is_some_and(|s| s < 20.0 * 60.0))
            .map(|e| e.at)
            .expect("a time to empty under 20 minutes was projected");
        assert!(
            dry_at - warned_at >= 5.0 * MINUTE,
            "projected only {:.1} min ahead",
            (dry_at - warned_at) / MINUTE
        );
    }

    /// A speaker that runs dry refills its prebuffer before playing on: its
    /// playhead stalls for as long as the prebuffer lasts, and the reserve
    /// steps up by as much. The monitor must report that as a suspected
    /// underrun, once, and nothing before it.
    #[tokio::test(start_paused = true)]
    async fn running_dry_is_reported_as_a_suspected_underrun() {
        let speaker = SimSpeaker {
            clock_ppm: 100.0,
            prebuffer_ms: 300.0,
            tick_jitter_ms: 50.0,
            seed: 9,
            ..SimSpeaker::default()
        };
        let report = speaker.run(65.0, false).await;
        // 300 ms at 6 ms/min is 50 minutes.
        let dry_at = *report.underruns.first().expect("the speaker runs dry");
        assert_eq!(report.underruns.len(), 1, "{:?}", report.underruns);
        let steps: Vec<f64> = report
            .estimates
            .iter()
            .filter(|e| e.brk == Some(SegmentBreak::OffsetStep))
            .map(|e| e.at)
            .collect();
        assert!(
            steps.len() == 1 && steps[0] > dry_at && steps[0] - dry_at <= 6.0 * MINUTE,
            "offset steps at {steps:?} ms, ran dry at {dry_at:.0} ms"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn jitter_100ms_still_locks_within_5min() {
        for seed in [11, 12] {
            let speaker = SimSpeaker {
                clock_ppm: 40.0,
                tick_jitter_ms: 100.0,
                seed,
                ..SimSpeaker::default()
            };
            let report = speaker.run(12.0, false).await;
            assert!(report.underruns.is_empty());
            let first_lock = report
                .estimates
                .iter()
                .find(|e| e.reserve.is_some_and(|r| r.locked))
                .map(|e| e.at)
                .expect("locks");
            assert!(
                first_lock <= 5.0 * MINUTE,
                "seed {seed}: locked at {:.1} min",
                first_lock / MINUTE
            );
            let errors: Vec<f64> = report
                .estimates
                .iter()
                .filter(|e| e.at >= first_lock)
                .map(|e| e.reserve.expect("estimate").reserve_ms - e.true_reserve_ms)
                .collect();
            // Tick jitter of ±100 ms costs the estimate a little precision
            // (about 30 ms RMS against 20 without), not its lock.
            assert_accurate(&errors, 100.0, 45.0);
        }
    }
}
