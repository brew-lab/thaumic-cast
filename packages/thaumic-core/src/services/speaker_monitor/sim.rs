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
use std::time::{Duration, Instant};

use bytes::Bytes;
use futures::{Stream, StreamExt};
use tokio::sync::broadcast;

use super::bounds::PollObservation;
use super::clock_fit::ClockEstimate;
use super::notice::{NoticeInput, NoticeState, SpeakerNotice};
use super::reserve::ReserveEstimate;
use super::segment::SegmentBreak;
use super::test_support::Lcg;
use super::tracker::{ReserveTracker, DRAINING_WARN_SECS};
use crate::stream::cadence::{create_wav_stream_with_cadence, CadenceConfig, LoggingStreamGuard};
use crate::stream::manager::TimestampedFrame;
use crate::stream::tap::WAV_HEADER_BYTES;
use crate::stream::{AudioCodec, AudioFormat, ConnectionTap, HeadStart};

/// Frame length the stream runs at, as in production.
const FRAME_MS: u32 = 10;

/// Jitter buffer of the simulated stream, as in production.
const JITTER_BUFFER_MS: u64 = 200;

/// How often the tracker is asked for an estimate, as the monitor does.
const ESTIMATE_EVERY_MS: f64 = 30_000.0;

/// The track URI the speaker reports.
const TRACK_URI: &str = "http://10.0.0.1:49400/stream/sim/live.wav";

/// Where the simulated monitor's poll dither comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SimDither {
    /// A random draw, uniform over the second, as the monitor now makes.
    Random,
    /// The monitor's old dither: the wall clock's sub-second part at the
    /// 500 ms wake-up that sent the poll, the wall clock running this many
    /// ms ahead of the wake-ups' grid.
    WallClock(u64),
}

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
    /// The stream's PCM connect burst, ms.
    pub connect_burst_ms: u64,
    /// A delivery stall: from `.0` ms after the connection starts, nothing
    /// reaches the speaker for `.1` ms, after which everything sent in the
    /// meantime arrives at once, as after a Wi-Fi retransmission burst.
    pub stall: Option<(f64, f64)>,
    /// Poll loss bursts: every `.0` ms from the connection's start, polls
    /// sent in the first `.1` ms go unanswered, as over a Wi-Fi link that
    /// drops out for a while and comes back.
    pub poll_loss: Option<(f64, f64)>,
    /// How the polls are dithered.
    pub dither: SimDither,
    /// Poll counts at which to take an extra estimate, into
    /// [`SimReport::at_polls`]. It is taken on a copy of the tracker, so it
    /// does not disturb the 30 s estimates.
    pub estimate_at_polls: Vec<usize>,
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
            connect_burst_ms: 0,
            stall: None,
            poll_loss: None,
            dither: SimDither::Random,
            estimate_at_polls: Vec::new(),
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
    /// The tracker's projected time to the low floor.
    pub time_to_floor_s: Option<f64>,
    /// The segment break the estimate revealed, if any.
    pub brk: Option<SegmentBreak>,
    /// Whether the tracker's low-reserve alarm stood after the estimate.
    pub low: bool,
    /// The notice standing after the estimate, decided as the monitor does
    /// (with no link verdict).
    pub notice: Option<SpeakerNotice>,
}

/// What a simulation run saw.
#[derive(Debug, Default)]
pub(crate) struct SimReport {
    /// When the speaker ran dry, ms since the connection started.
    pub underruns: Vec<f64>,
    /// Every 30 s estimate.
    pub estimates: Vec<SimEstimate>,
    /// The estimates asked for by [`SimSpeaker::estimate_at_polls`], with
    /// the poll count each was taken at.
    pub at_polls: Vec<(usize, Option<ReserveEstimate>)>,
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
        let prefill = (0..(JITTER_BUFFER_MS + self.connect_burst_ms) / u64::from(FRAME_MS))
            .map(|_| TimestampedFrame {
                captured_at: Instant::now(),
                data: audio.clone(),
            })
            .collect();
        let config = CadenceConfig::new(
            format.silence_frame(FRAME_MS),
            JITTER_BUFFER_MS,
            self.connect_burst_ms,
            FRAME_MS,
            format,
            prefill,
        );
        let head_start = HeadStart::new(config.burst_ms(), self.connect_burst_ms);
        // Burst frames are yielded before the first tick; the source has
        // nothing to deliver for them.
        let mut burst_left = config.burst_frames.len();
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
        tracker.start_connection(true, Some(head_start));
        let mut report = SimReport::default();
        let mut notices = NoticeState::new();
        let notice_base = Instant::now();
        let mut pending: Option<PendingPoll> = None;
        let mut next_poll = 5_000.0;
        let mut next_estimate = ESTIMATE_EVERY_MS;
        let mut stalled_at: Option<f64> = None;
        let mut polls = 0;

        let start = tokio::time::Instant::now();
        let end = minutes * 60_000.0;
        loop {
            // The source delivers one frame per frame period, just ahead of
            // the metronome tick that sends it on.
            if burst_left > 0 {
                burst_left -= 1;
            } else {
                let _ = tx.send(audio.clone());
            }
            let Some(Ok(frame)) = stream.next().await else {
                break;
            };
            guard
                .bytes_sent
                .fetch_add(frame.len() as u64, Ordering::Relaxed);
            let now = start.elapsed().as_secs_f64() * 1000.0;
            let sent_ms = tap.audio_bytes_sent() as f64 * 1000.0 / byte_rate;
            // During a stall the speaker has only what reached it before.
            let received_ms = match self.stall {
                Some((from, len)) if now >= from && now < from + len => {
                    *stalled_at.get_or_insert(sent_ms)
                }
                _ => sent_ms,
            };

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
                let lost = self
                    .poll_loss
                    .is_some_and(|(every, len)| p.ts % every < len);
                let obs = PollObservation {
                    ts: p.ts,
                    tr: p.tr,
                    rel_ms: p.rel_ms.expect("read before answered"),
                    d_ts_ms: p.d_ts_ms,
                    d_tr_ms: delivered,
                };
                if !lost {
                    tracker.observe(&obs, TRACK_URI, false);
                    polls += 1;
                }
                if self.estimate_at_polls.contains(&polls) {
                    let (reserve, _) = tracker.clone().estimate(now);
                    report.at_polls.push((polls, reserve));
                }
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
                let dither = match self.dither {
                    SimDither::Random => rng.unit() * 1000.0,
                    SimDither::WallClock(offset_ms) => {
                        let wake = (now / 500.0).floor() * 500.0;
                        (wake + offset_ms as f64) % 1000.0
                    }
                };
                next_poll = now + 2000.0 + dither;
            }

            if now >= next_estimate {
                let (reserve, brk) = tracker.estimate(now);
                let acked = tracker.observe_ack_lag(&mut []);
                let notice = notices.update(
                    notice_base + Duration::from_secs_f64(now / 1000.0),
                    &NoticeInput {
                        locked: reserve.is_some_and(|r| r.locked()),
                        acked,
                        offset_step: brk == Some(SegmentBreak::OffsetStep),
                        pre_break: tracker.pre_break(),
                        head_start: tracker.head_start(),
                        stall_ms: tracker.stall_ms(),
                        time_to_floor_s: tracker.time_to_floor_s(),
                        ..NoticeInput::default()
                    },
                );
                report.estimates.push(SimEstimate {
                    at: now,
                    reserve,
                    true_reserve_ms: delivered - playback.playhead_at(now),
                    clock: tracker.clock(),
                    time_to_floor_s: tracker.time_to_floor_s(),
                    brk,
                    low: tracker.is_low(),
                    notice,
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
            .filter(|e| e.reserve.is_some_and(|r| r.locked()))
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
            .find(|e| e.time_to_floor_s.is_some_and(|s| s < DRAINING_WARN_SECS))
            .map(|e| e.at)
            .expect("a time to the floor under half an hour was projected");
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

    /// The field case of 2026-09-28: a Playbar that starts playing with
    /// about 70 ms in hand, and a Wi-Fi loss burst that holds up 90 ms of
    /// audio. Paced from the first frame, the speaker never gets further
    /// ahead than it started, so the stall empties it. A 500 ms connect burst
    /// leaves it with over half a second in hand, which rides the stall out.
    #[tokio::test(start_paused = true)]
    async fn connect_burst_rides_out_a_90ms_stall() {
        let run = |connect_burst_ms| SimSpeaker {
            prebuffer_ms: 70.0,
            connect_burst_ms,
            stall: Some((20_000.0, 90.0)),
            seed: 13,
            ..SimSpeaker::default()
        };

        let unburst = run(0).run(0.5, true).await;
        let dry_at = *unburst
            .underruns
            .first()
            .expect("without a burst the stall empties the speaker");
        assert!(
            (20_000.0..20_090.0).contains(&dry_at),
            "ran dry at {dry_at:.0} ms"
        );

        let burst = run(500).run(0.5, true).await;
        assert!(
            burst.underruns.is_empty(),
            "a 500 ms burst rides out a 90 ms stall: {:?}",
            burst.underruns
        );
    }

    /// The `p`th percentile (0-100) of `values`, nearest rank.
    fn percentile(values: &mut [f64], p: f64) -> f64 {
        values.sort_unstable_by(f64::total_cmp);
        let rank = ((p / 100.0) * values.len() as f64).ceil() as usize;
        values[rank.clamp(1, values.len()) - 1]
    }

    /// Reserve half-widths at 36 and 72 polls (a minute and a half and
    /// three minutes at the monitor-only cadence) over the given runs. Four
    /// minutes is enough for 72 polls even at the longest old intervals.
    async fn half_widths(runs: impl Iterator<Item = SimSpeaker>) -> (Vec<f64>, Vec<f64>) {
        let (mut at_36, mut at_72) = (Vec::new(), Vec::new());
        for speaker in runs {
            let report = SimSpeaker {
                estimate_at_polls: vec![36, 72],
                ..speaker
            }
            .run(4.0, false)
            .await;
            for (polls, estimate) in report.at_polls {
                let hw = estimate.expect("an estimate from 36 polls").half_width_ms;
                if polls == 36 {
                    at_36.push(hw)
                } else {
                    at_72.push(hw)
                }
            }
        }
        (at_36, at_72)
    }

    /// The evidence for how wide a held lock may grow: the half-width's
    /// distribution at 36 and 72 polls under the old wall-clock dither,
    /// swept over where the wall clock sits against the monitor's wake-ups,
    /// and under the random draw, swept over seeds. Run with `--nocapture`
    /// to see the percentiles.
    ///
    /// The old dither is fine for most offsets but collapses onto a few
    /// phases for offsets near 0 and 250 ms, which leaves its worst case at
    /// the lattice gap; the random draw has no such offsets.
    #[tokio::test(start_paused = true)]
    async fn hw_distribution_old_vs_new_dither() {
        let base = |seed| SimSpeaker {
            tick_jitter_ms: 50.0,
            seed,
            ..SimSpeaker::default()
        };
        let (mut old_36, mut old_72) = half_widths((0..500).step_by(20).map(|offset| SimSpeaker {
            dither: SimDither::WallClock(offset),
            ..base(offset + 1)
        }))
        .await;
        let (mut new_36, mut new_72) = half_widths((1..=50).map(base)).await;

        let row = |label: &str, hw: &mut Vec<f64>| {
            let [p50, p90, p99] = [50.0, 90.0, 99.0].map(|p| percentile(hw, p));
            eprintln!(
                "{label}: n={} HW p50={p50:.0} p90={p90:.0} p99={p99:.0} max={:.0}",
                hw.len(),
                hw[hw.len() - 1]
            );
            (p50, p90, p99)
        };
        let old_36 = row("wall clock, 36 polls", &mut old_36);
        let old_72 = row("wall clock, 72 polls", &mut old_72);
        let new_36 = row("random, 36 polls", &mut new_36);
        let new_72 = row("random, 72 polls", &mut new_72);

        // At the tail, the lattice offsets make the old dither the worse.
        assert!(new_36.1 < old_36.1, "{new_36:?} against {old_36:?}");
        assert!(new_72.1 < old_72.1, "{new_72:?} against {old_72:?}");
        assert!(new_36.2 < old_36.2, "{new_36:?} against {old_36:?}");
        assert!(new_72.2 < old_72.2, "{new_72:?} against {old_72:?}");
    }

    /// A speaker on a 500 ms head start whose link drops every poll for 16 s
    /// every ten minutes, as the field's Wi-Fi did. Each burst costs the
    /// window a handful of polls and widens the estimate; the lock must ride
    /// that out, with no segment break and no low alarm.
    #[tokio::test(start_paused = true)]
    async fn loss_bursts_of_16s_every_10min_keep_lock_and_raise_no_notice_at_500ms() {
        for seed in [21, 22, 23] {
            let speaker = SimSpeaker {
                prebuffer_ms: 70.0,
                connect_burst_ms: 500,
                tick_jitter_ms: 50.0,
                poll_loss: Some((10.0 * MINUTE, 16_000.0)),
                seed,
                ..SimSpeaker::default()
            };
            let report = speaker.run(60.0, false).await;
            assert!(report.underruns.is_empty(), "seed {seed}");
            let first_lock = report
                .estimates
                .iter()
                .position(|e| e.reserve.is_some_and(|r| r.locked()))
                .expect("locks");
            assert!(
                report.estimates[first_lock].at <= 5.0 * MINUTE,
                "seed {seed}: locked at {:.1} min",
                report.estimates[first_lock].at / MINUTE
            );
            for e in &report.estimates[first_lock..] {
                let r = e.reserve.expect("an estimate");
                assert!(
                    r.locked(),
                    "seed {seed}: dropped at {:.1} min: {r:?}",
                    e.at / MINUTE
                );
                assert_eq!(e.brk, None, "seed {seed}");
                assert!(!e.low, "seed {seed}: low at {:.1} min", e.at / MINUTE);
                assert_eq!(
                    e.notice,
                    None,
                    "seed {seed}: notice at {:.1} min",
                    e.at / MINUTE
                );
                assert!(
                    (r.reserve_ms - e.true_reserve_ms).abs() <= r.half_width_ms,
                    "seed {seed}: {r:?} vs {:.0}",
                    e.true_reserve_ms
                );
            }
        }
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
                .find(|e| e.reserve.is_some_and(|r| r.locked()))
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
