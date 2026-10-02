use super::*;
use crate::services::speaker_monitor::SpeakerControlState;

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
        t += (MONITOR_POLL_INTERVAL_MS as f64 + dither * MONITOR_POLL_DITHER_MS as f64) / 1000.0;
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

mod dither {
    use super::super::*;

    /// Kolmogorov-Smirnov critical value at p = 0.01 for `n` samples.
    fn ks_critical(n: usize) -> f64 {
        1.628 / (n as f64).sqrt()
    }

    /// Kolmogorov-Smirnov statistic of `samples` against the uniform
    /// distribution on `[0, span)`.
    fn ks_uniform(samples: &mut [f64], span: f64) -> f64 {
        samples.sort_unstable_by(f64::total_cmp);
        let n = samples.len() as f64;
        samples
            .iter()
            .enumerate()
            .map(|(i, x)| {
                let f = x / span;
                (f - i as f64 / n).max((i as f64 + 1.0) / n - f)
            })
            .fold(0.0, f64::max)
    }

    /// Sends `count` polls from `session` the way the monitor loop does,
    /// each at its own dithered moment and the first `start_ms` into the
    /// second, and returns where in the second each one went.
    fn poll_phases(session: &mut SpeakerSession, start_ms: u64, count: usize) -> Vec<f64> {
        let origin = Instant::now();
        let mut sent_ms = start_ms;
        (0..count)
            .map(|_| {
                session.mark_polled_at(origin + Duration::from_millis(sent_ms), 1);
                let phase = (sent_ms % 1000) as f64;
                sent_ms += session.next_poll_after.as_millis() as u64;
                phase
            })
            .collect()
    }

    /// The same polls under the old dither: read from the wall clock's
    /// sub-second part at the 500 ms wake-up that sent each poll, the
    /// wall clock running `wall_offset_ms` ahead of the wake-ups' grid.
    fn wall_clock_phases(wall_offset_ms: u64, count: usize) -> Vec<f64> {
        let mut sent_ms = 0;
        (0..count)
            .map(|_| {
                let wake = sent_ms / POLL_INTERVAL_MS * POLL_INTERVAL_MS;
                let dither = (wake + wall_offset_ms) % MONITOR_POLL_DITHER_MS;
                let phase = (sent_ms % 1000) as f64;
                sent_ms += MONITOR_POLL_INTERVAL_MS + dither;
                phase
            })
            .collect()
    }

    #[test]
    fn dither_draws_cover_the_second() {
        let critical = ks_critical(500);
        for start_ms in [0, 250, 500] {
            let mut session = SpeakerSession::new(false, 42);
            let mut phases = poll_phases(&mut session, start_ms, 500);
            let d = ks_uniform(&mut phases, 1000.0);
            assert!(
                d < critical,
                "monitor-only polls from phase {start_ms}: D={d:.3}"
            );

            let mut video = SpeakerSession::new(true, 42);
            let mut phases = poll_phases(&mut video, start_ms, 500);
            let d = ks_uniform(&mut phases, 1000.0);
            assert!(
                d < critical,
                "video sync polls from phase {start_ms}: D={d:.3}"
            );
        }
        let mut session = SpeakerSession::new(false, 7);
        let mut draws: Vec<f64> = (0..500)
            .map(|_| session.next_dither_ms(1000) as f64)
            .collect();
        assert!(draws.iter().all(|d| (0.0..1000.0).contains(d)));
        let d = ks_uniform(&mut draws, 1000.0);
        assert!(d < critical, "raw draws: D={d:.3}");
        assert_eq!(session.next_dither_ms(0), 0);
    }

    #[test]
    fn dither_is_independent_of_wall_clock_phase() {
        // The draws depend on the seed alone: the same seed gives the
        // same intervals whenever they are drawn.
        let mut straight = SpeakerSession::new(false, 99);
        let mut paused = SpeakerSession::new(false, 99);
        for i in 0..40 {
            straight.mark_polled(1);
            if i % 10 == 0 {
                std::thread::sleep(Duration::from_millis(3));
            }
            paused.mark_polled(1);
            assert_eq!(straight.next_poll_after, paused.next_poll_after);
        }

        // Where the old wall-clock dither collapsed onto a few points,
        // the draw still fills the second.
        for wall_offset_ms in [0, 2, 250, 252] {
            let mut old = wall_clock_phases(wall_offset_ms, 72);
            let old_gap = largest_phase_gap_ms(&mut old).expect("polls");
            assert!(
                old_gap >= 245.0,
                "offset {wall_offset_ms}: the old dither left {old_gap:.0} ms"
            );
            let mut session = SpeakerSession::new(false, wall_offset_ms);
            let mut new = poll_phases(&mut session, wall_offset_ms, 72);
            let new_gap = largest_phase_gap_ms(&mut new).expect("polls");
            assert!(
                new_gap < 120.0,
                "offset {wall_offset_ms}: the draw left {new_gap:.0} ms"
            );
        }
    }

    #[test]
    fn phase_gap_reported_under_120ms_at_72_polls() {
        for seed in 1..=20 {
            let mut session = SpeakerSession::new(false, seed);
            let mut phases = poll_phases(&mut session, 0, 72);
            let gap = largest_phase_gap_ms(&mut phases).expect("polls");
            assert!(gap < 120.0, "seed {seed}: {gap:.0} ms");
        }
    }

    #[test]
    fn phase_gap_counts_the_gap_that_wraps_round_the_second() {
        assert_eq!(largest_phase_gap_ms(&mut []), None);
        assert_eq!(largest_phase_gap_ms(&mut [400.0]), Some(1000.0));
        assert_eq!(largest_phase_gap_ms(&mut [990.0, 10.0]), Some(980.0));
        assert_eq!(
            largest_phase_gap_ms(&mut [100.0, 900.0, 500.0]),
            Some(400.0)
        );
        assert_eq!(
            largest_phase_gap_ms(&mut [0.0, 250.0, 500.0, 750.0]),
            Some(250.0)
        );
    }

    #[test]
    fn sessions_seeded_from_different_speakers_draw_apart() {
        let ip = |s: &str| s.parse::<IpAddr>().expect("address");
        let a = dither_seed(&("s".to_string(), ip("192.168.1.10")));
        let b = dither_seed(&("s".to_string(), ip("192.168.1.11")));
        assert_ne!(a, b);
    }
}

mod polling {
    use super::super::*;
    use tokio_util::sync::CancellationToken;

    use crate::error::SoapResult;
    use crate::events::LatencyEvent;
    use crate::events::{NetworkEvent, SonosEvent, StreamEvent, TopologyEvent};
    use crate::protocol_constants::POSITION_POLL_TIMEOUT_MS;
    use crate::runtime::TokioSpawner;
    use crate::services::speaker_monitor::monitor::{
        apply_poll_result, elapsed_with_inserted, SpeakerMonitor,
    };
    use crate::services::speaker_monitor::{GenaTransport, TransportStateView};
    use crate::sonos::traits::SonosPlayback;
    use crate::state::StreamingConfig;
    use crate::stream::tap::test_support::{
        started_tap, started_tap_with_codec, started_tap_with_declared_end, started_tap_with_drift,
    };
    use crate::stream::StreamRegistry;
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
        fn new(stream_id: &str) -> Arc<Self> {
            Arc::new(Self {
                stream_id: stream_id.to_string(),
                calls: parking_lot::Mutex::new(Vec::new()),
            })
        }

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
        async fn set_next_uri(
            &self,
            _: &str,
            _: &crate::sonos::traits::NextItem<'_>,
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
        async fn get_transport_info(&self, _: &str) -> SoapResult<TransportState> {
            Ok(TransportState::Playing)
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

    /// Keeps the network events the monitor sends.
    #[derive(Default)]
    struct NetworkEvents(parking_lot::Mutex<Vec<NetworkEvent>>);

    impl NetworkEvents {
        /// The states of the speaker health events sent for `ip`, in order.
        fn health_states(&self, ip: &str) -> Vec<crate::events::SpeakerHealthState> {
            self.0
                .lock()
                .iter()
                .filter_map(|e| match e {
                    NetworkEvent::SpeakerHealth {
                        speaker_ip, state, ..
                    } if speaker_ip == ip => Some(*state),
                    _ => None,
                })
                .collect()
        }
    }

    impl EventEmitter for NetworkEvents {
        fn emit_stream(&self, _: StreamEvent) {}
        fn emit_sonos(&self, _: SonosEvent) {}
        fn emit_network(&self, event: NetworkEvent) {
            self.0.lock().push(event);
        }
        fn emit_topology(&self, _: TopologyEvent) {}
        fn emit_latency(&self, _: LatencyEvent) {}
    }

    /// GENA double that has heard nothing.
    struct NoGena;

    impl TransportStateView for NoGena {
        fn gena_transport(&self, _: &str) -> Option<GenaTransport> {
            None
        }
    }

    /// A running monitor over a live stream, and the speaker double it polls.
    struct Harness {
        monitor: SpeakerMonitor,
        speakers: Arc<FakeSpeakers>,
        events: Arc<NetworkEvents>,
        stream_id: String,
    }

    impl Harness {
        async fn start(cancel: &CancellationToken) -> Self {
            let registry = Arc::new(StreamRegistry::new(StreamingConfig::default()));
            let stream_id = registry
                .create_stream(AudioCodec::Pcm, AudioFormat::default(), 200, 10)
                .expect("stream");
            let speakers = FakeSpeakers::new(&stream_id);
            let events = Arc::new(NetworkEvents::default());
            let monitor = SpeakerMonitor::new(
                Arc::clone(&speakers) as Arc<dyn SonosPlayback>,
                registry,
                Arc::clone(&events) as Arc<dyn EventEmitter>,
                Arc::new(NoGena),
                cancel.clone(),
                TokioSpawner::new(tokio::runtime::Handle::current()),
            );
            monitor.start();
            Self {
                monitor,
                speakers,
                events,
                stream_id,
            }
        }

        /// `ip` fetches the stream: its connection starts an epoch and
        /// registers. The returned tap is the open connection.
        fn fetch(&self, ip: &str, monitor: bool) -> Arc<ConnectionTap> {
            let tap = started_tap(&self.stream_id, ip, monitor);
            self.monitor.registrar().register(&tap);
            tap
        }
    }

    /// Starts a monitor watching three hung speakers and one healthy one,
    /// all already fetching a live stream with video sync, and returns the
    /// speaker double and the open connections.
    async fn watch_hung_and_healthy_speakers(
        cancel: &CancellationToken,
    ) -> (Arc<FakeSpeakers>, Vec<Arc<ConnectionTap>>) {
        let harness = Harness::start(cancel).await;
        let mut taps = Vec::new();
        for ip in HUNG_IPS.iter().chain([&HEALTHY_IP]) {
            taps.push(harness.fetch(ip, false));
            harness
                .monitor
                .start_video_sync(&harness.stream_id, ip)
                .await;
        }
        (harness.speakers, taps)
    }

    #[tokio::test]
    async fn a_hung_speaker_does_not_delay_another_speakers_polls_by_more_than_50ms() {
        let cancel = CancellationToken::new();
        let (speakers, _taps) = watch_hung_and_healthy_speakers(&cancel).await;
        tokio::time::sleep(WATCH).await;
        cancel.cancel();

        let healthy = speakers.calls_to(HEALTHY_IP);
        // At most 1.5 s apart (500 ms plus the full dither): at least four
        // in 5.5 s. A loop that waited out each hung speaker's 1.5 s
        // timeout in turn would be blocked almost the whole time.
        assert!(
            healthy.len() >= 4,
            "healthy speaker polled {} times in {WATCH:?}",
            healthy.len()
        );
        // Each poll is sent at its own dithered moment, so consecutive
        // polls are never further apart than the longest dithered interval.
        // One held up by the hung speaker would overshoot it.
        let longest = POLL_INTERVAL_MS + POLL_DITHER_MS;
        for pair in healthy.windows(2) {
            let gap = pair[1].saturating_duration_since(pair[0]).as_millis() as u64;
            assert!(
                gap <= longest + 50,
                "healthy speaker polled {gap} ms after its previous poll"
            );
        }
    }

    /// The monitor wakes every 500 ms, but polls must not land on that
    /// grid: the reserve bounds only narrow if the polls' phase against the
    /// speaker's whole-second RelTime is spread across the second. On the
    /// grid every poll hits one of two phases and the estimate stalls at
    /// about half a second wide, which is what the first field run showed.
    #[tokio::test]
    async fn polls_are_sent_at_their_dithered_moment_not_on_the_tick() {
        let cancel = CancellationToken::new();
        let (speakers, _taps) = watch_hung_and_healthy_speakers(&cancel).await;
        tokio::time::sleep(WATCH).await;
        cancel.cancel();

        let healthy = speakers.calls_to(HEALTHY_IP);
        let first = *healthy.first().expect("speaker was polled");
        let tick = POLL_INTERVAL_MS as u128;
        let off_grid = healthy
            .iter()
            .skip(1)
            .filter(|at| {
                let offset = at.saturating_duration_since(first).as_millis() % tick;
                offset.min(tick - offset) > 50
            })
            .count();
        assert!(
            off_grid >= 1,
            "every one of {} polls landed on the monitor's 500 ms tick",
            healthy.len()
        );
    }

    #[tokio::test]
    async fn a_hung_speaker_is_polled_again_only_after_its_poll_times_out() {
        let cancel = CancellationToken::new();
        let (speakers, _taps) = watch_hung_and_healthy_speakers(&cancel).await;
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

    /// Replaces `a_plain_cast_never_polls_the_speakers`: with monitoring on
    /// (the default) a plain cast polls the speaker that fetches, at the
    /// monitor-only cadence, and never a speaker that does not fetch — a
    /// grouped slave, here one that video sync was even asked for.
    #[tokio::test]
    async fn a_plain_cast_polls_only_fetching_speakers_within_budget() {
        const FETCHING: &str = "192.168.1.20";
        const SLAVE: &str = "192.168.1.21";
        let cancel = CancellationToken::new();
        let harness = Harness::start(&cancel).await;
        let _tap = harness.fetch(FETCHING, true);
        harness
            .monitor
            .start_video_sync(&harness.stream_id, SLAVE)
            .await;

        let watch = Duration::from_millis(6200);
        tokio::time::sleep(watch).await;
        cancel.cancel();

        let polls = harness.speakers.calls_to(FETCHING);
        // First poll at once, then every 2-3 s: two or three in 6.2 s.
        assert!(
            (2..=4).contains(&polls.len()),
            "fetching speaker polled {} times in {watch:?}",
            polls.len()
        );
        for pair in polls.windows(2) {
            assert!(
                pair[1].duration_since(pair[0]) >= Duration::from_millis(MONITOR_POLL_INTERVAL_MS),
                "monitor-only polls closer than the base interval"
            );
        }
        assert!(
            harness.speakers.calls_to(SLAVE).is_empty(),
            "a speaker that never fetches must never be polled"
        );
    }

    /// Off restores the old behaviour: a plain cast is not polled at all,
    /// and video sync still works.
    #[tokio::test]
    async fn speaker_monitor_off_never_polls() {
        const PLAIN: &str = "192.168.1.30";
        const SYNCED: &str = "192.168.1.31";
        let cancel = CancellationToken::new();
        let harness = Harness::start(&cancel).await;
        let _plain = harness.fetch(PLAIN, false);
        let _synced = harness.fetch(SYNCED, false);
        harness
            .monitor
            .start_video_sync(&harness.stream_id, SYNCED)
            .await;

        tokio::time::sleep(Duration::from_millis(2600)).await;
        cancel.cancel();

        assert!(
            harness.speakers.calls_to(PLAIN).is_empty(),
            "with monitoring off a cast without video sync must not poll"
        );
        assert!(
            harness.speakers.calls_to(SYNCED).len() >= 2,
            "video sync keeps polling whatever the setting"
        );
    }

    /// A monitored speaker's health reaches clients from its first tick,
    /// naming its stream, so a client learns the speaker is measured
    /// before the first 30 s report; an unmonitored plain cast sends none.
    #[tokio::test]
    async fn a_monitored_speaker_reports_its_health_and_an_unmonitored_one_does_not() {
        use crate::events::SpeakerHealthState;
        const MONITORED: &str = "192.168.1.40";
        const PLAIN: &str = "192.168.1.41";
        let cancel = CancellationToken::new();
        let harness = Harness::start(&cancel).await;
        let _monitored = harness.fetch(MONITORED, true);
        let _plain = harness.fetch(PLAIN, false);

        tokio::time::sleep(Duration::from_millis(1200)).await;
        cancel.cancel();

        assert_eq!(
            harness.events.health_states(MONITORED),
            vec![SpeakerHealthState::Locking],
            "one event on the first tick, and no repeat while the state holds"
        );
        let named_stream = harness.events.0.lock().iter().all(|e| match e {
            NetworkEvent::SpeakerHealth { stream_id, .. } => *stream_id == harness.stream_id,
            _ => true,
        });
        assert!(
            named_stream,
            "the event names the stream the speaker fetches"
        );
        assert!(
            harness.events.health_states(PLAIN).is_empty(),
            "a speaker that is not polled has no health to report"
        );
    }

    /// A compressed connection's reserve is never measured, so its
    /// speaker is reported unmeasured from the first tick; "locking"
    /// would stand for the whole cast.
    #[tokio::test]
    async fn a_monitored_speaker_on_a_compressed_stream_reports_unmeasured() {
        use crate::events::SpeakerHealthState;
        const COMPRESSED: &str = "192.168.1.42";
        const PCM: &str = "192.168.1.43";
        let cancel = CancellationToken::new();
        let harness = Harness::start(&cancel).await;
        let compressed =
            started_tap_with_codec(&harness.stream_id, COMPRESSED, true, AudioCodec::Aac);
        harness.monitor.registrar().register(&compressed);
        let _pcm = harness.fetch(PCM, true);

        tokio::time::sleep(Duration::from_millis(1200)).await;
        cancel.cancel();

        assert_eq!(
            harness.events.health_states(COMPRESSED),
            vec![SpeakerHealthState::Unmeasured],
        );
        assert_eq!(
            harness.events.health_states(PCM),
            vec![SpeakerHealthState::Locking],
            "a PCM connection beside it is reported as before"
        );
    }

    /// The unmeasured event carries no reserve figures and no drift mode:
    /// there is no reserve to report or to steer.
    #[test]
    fn an_unmeasured_speaker_reports_no_reserve_figures() {
        let aac = started_tap_with_codec("stream", HUNG_IP, true, AudioCodec::Aac);
        let mut session = SpeakerSession::new(false, 0);
        session.attach(&aac);
        answer_polls(&mut session, &aac, 10);

        assert_eq!(session.health_state(), MonitorState::Unmeasured);
        match session.health_event("stream", HUNG_IP.parse().unwrap(), session.health_state()) {
            NetworkEvent::SpeakerHealth {
                state,
                reserve_ms,
                reserve_acked,
                floor_ms,
                head_start_ms,
                time_to_floor_s,
                drift_mode,
                notice,
                ..
            } => {
                assert_eq!(state, crate::events::SpeakerHealthState::Unmeasured);
                assert_eq!(reserve_ms, None);
                assert!(!reserve_acked);
                assert_eq!(floor_ms, None);
                assert_eq!(head_start_ms, None);
                assert_eq!(time_to_floor_s, None);
                assert_eq!(drift_mode, None);
                assert!(notice.is_none());
            }
            other => panic!("not a speaker health event: {other:?}"),
        }

        // The same polls on a PCM connection: still locking, as before.
        let pcm = started_tap("stream", HUNG_IP, true);
        let mut session = SpeakerSession::new(false, 0);
        session.attach(&pcm);
        answer_polls(&mut session, &pcm, 10);
        assert_eq!(session.health_state(), MonitorState::Locking);
    }

    /// A speaker found playing something else is reported dormant without
    /// the figures of a reserve it is no longer building.
    #[test]
    fn a_dormant_speaker_reports_dormant() {
        let mut session = SpeakerSession::new(false, 0);
        session.monitor = true;
        session.dormant = true;
        assert!(session.reports_health());
        assert_eq!(session.health_state(), MonitorState::Dormant);
        match session.health_event("stream", HUNG_IP.parse().unwrap(), MonitorState::Dormant) {
            NetworkEvent::SpeakerHealth {
                state,
                reserve_ms,
                target_ms,
                ..
            } => {
                assert_eq!(state, crate::events::SpeakerHealthState::Dormant);
                assert_eq!(reserve_ms, None);
                assert_eq!(target_ms, None);
            }
            other => panic!("not a speaker health event: {other:?}"),
        }
    }

    fn poll(poll_id: u64, outcome: Result<PositionInfo, String>) -> PollResult {
        PollResult {
            key: ("stream".to_string(), HUNG_IP.parse().unwrap()),
            poll_id,
            epoch_id: 0,
            stream_elapsed_ms: 1000,
            rtt_ms: 10,
            sent_at: Instant::now(),
            answered_at: Instant::now(),
            delivered_ms_at_send: None,
            delivered_ms_at_answer: None,
            net_inserted_ms: 0.0,
            outcome,
            transport: None,
        }
    }

    fn ours(rel_time_ms: u64) -> PositionInfo {
        PositionInfo {
            track_uri: "http://10.0.0.1:1400/stream/stream/live.wav".to_string(),
            rel_time_ms,
        }
    }

    #[test]
    fn three_failed_polls_back_off_until_the_speaker_answers() {
        let mut session = SpeakerSession::new(true, 0);
        for poll_id in 1..=BACKOFF_AFTER_FAILURES as u64 {
            session.mark_polled(0);
            assert!(session.next_poll_after < Duration::from_millis(BACKOFF_POLL_INTERVAL_MS));
            session.in_flight = Some(poll_id);
            apply_poll_result(
                &mut session,
                poll(poll_id, Err("timeout".into())),
                &NoEvents,
                None,
            );
            assert_eq!(session.in_flight, None);
        }
        session.mark_polled(0);
        assert_eq!(
            session.next_poll_after,
            Duration::from_millis(BACKOFF_POLL_INTERVAL_MS)
        );

        session.in_flight = Some(99);
        let answer = PositionInfo {
            track_uri: String::new(),
            rel_time_ms: 0,
        };
        apply_poll_result(&mut session, poll(99, Ok(answer)), &NoEvents, None);
        assert_eq!(session.consecutive_failures, 0);
        session.mark_polled(0);
        assert!(session.next_poll_after < Duration::from_millis(BACKOFF_POLL_INTERVAL_MS));
    }

    #[test]
    fn an_answer_to_a_poll_the_session_no_longer_awaits_is_ignored() {
        let mut session = SpeakerSession::new(true, 0);
        session.in_flight = Some(2);
        apply_poll_result(
            &mut session,
            poll(1, Err("timeout".into())),
            &NoEvents,
            None,
        );
        assert_eq!(session.in_flight, Some(2));
        assert_eq!(session.consecutive_failures, 0);
    }

    #[test]
    fn a_speaker_playing_another_track_is_left_alone_until_it_fetches_again() {
        let mut session = SpeakerSession::new(false, 0);
        let tap = started_tap("stream", HUNG_IP, true);
        session.attach(&tap);
        assert!(session.wants_polls());

        let elsewhere = || PositionInfo {
            track_uri: "x-sonos-spotify:track".to_string(),
            rel_time_ms: 5000,
        };
        // Attaching syncs the session to the connection's epoch, so the
        // answers must belong to it to count.
        let epoch_id = tap.epoch().expect("started").id;
        let answer = |poll_id| PollResult {
            epoch_id,
            ..poll(poll_id, Ok(elsewhere()))
        };
        session.in_flight = Some(1);
        apply_poll_result(&mut session, answer(1), &NoEvents, None);
        assert!(
            session.wants_polls(),
            "one odd answer does not end monitoring"
        );
        session.in_flight = Some(2);
        apply_poll_result(&mut session, answer(2), &NoEvents, None);
        assert!(!session.wants_polls(), "dormant until the next fetch");

        let refetch = started_tap("stream", HUNG_IP, true);
        session.attach(&refetch);
        assert!(session.wants_polls(), "a new fetch re-arms the session");
    }

    #[test]
    fn a_poll_while_the_speaker_is_known_paused_is_not_measured() {
        let mut session = SpeakerSession::new(true, 0);
        session.in_flight = Some(1);
        let mut paused = poll(1, Ok(ours(4000)));
        paused.transport = Some(Ok(TransportState::Paused));
        apply_poll_result(&mut session, paused, &NoEvents, None);
        assert_eq!(session.sample_count, 0, "a paused poll is not a sample");
        assert!(
            session.last_valid_position.is_some(),
            "but it is a valid answer, so the session does not go stale"
        );

        session.in_flight = Some(2);
        apply_poll_result(&mut session, poll(2, Ok(ours(4000))), &NoEvents, None);
        assert_eq!(session.sample_count, 0, "the polled state still holds");

        let mut playing = poll(3, Ok(ours(4000)));
        playing.transport = Some(Ok(TransportState::Playing));
        session.in_flight = Some(3);
        apply_poll_result(&mut session, playing, &NoEvents, None);
        assert_eq!(session.sample_count, 1);
    }

    /// Audio drift correction inserted is played by the speaker but was
    /// never captured: without counting it, video sync would read the
    /// latency that much too low, drifting by about 70 ms an hour at the
    /// field's 20 ppm.
    #[test]
    fn video_sync_counts_the_audio_drift_correction_inserted() {
        let measure = |net_inserted_ms: f64| {
            let mut session = SpeakerSession::new(true, 0);
            session.in_flight = Some(1);
            let mut answered = poll(1, Ok(ours(4000)));
            answered.net_inserted_ms = net_inserted_ms;
            apply_poll_result(&mut session, answered, &NoEvents, None);
            assert_eq!(session.sample_count, 1);
            session.last_raw_ms
        };
        assert_eq!(measure(54.0) - measure(0.0), 54);
        assert_eq!(measure(-20.0) - measure(0.0), -20);
        assert_eq!(elapsed_with_inserted(10, -50.0), 0);
    }

    #[test]
    fn a_pcm_session_estimates_the_reserve_and_publishes_it() {
        use crate::services::speaker_monitor::test_support::PollGen;

        let tap = started_tap("stream", HUNG_IP, true);
        let mut session = SpeakerSession::new(false, 0);
        session.attach(&tap);
        let epoch_id = tap.epoch().expect("started").id;
        let origin = tap.connected_at;
        let at = |ms: f64| origin + Duration::from_secs_f64(ms / 1000.0);

        // Four minutes of polls of a speaker holding 600 ms, answered as
        // the real poll task would report them.
        let mut gen = PollGen::new(61);
        let mut poll_id = 0;
        gen.run_until(240_000.0, |p| {
            poll_id += 1;
            session.in_flight = Some(poll_id);
            let result = PollResult {
                key: ("stream".to_string(), HUNG_IP.parse().unwrap()),
                poll_id,
                epoch_id,
                stream_elapsed_ms: p.ts as u64,
                rtt_ms: (p.tr - p.ts) as u32,
                sent_at: at(p.ts),
                answered_at: at(p.tr),
                delivered_ms_at_send: Some(p.d_ts_ms as u64),
                delivered_ms_at_answer: Some(p.d_tr_ms as u64),
                net_inserted_ms: 0.0,
                outcome: Ok(ours(p.rel_ms)),
                transport: None,
            };
            apply_poll_result(&mut session, result, &NoEvents, None);
        });
        assert!(
            session.sample_count > 90,
            "video sync's latency is still measured alongside the reserve"
        );
        // Every measured poll's phase is kept for the report's phase gap.
        assert_eq!(
            session.phases_since_report.len(),
            session.polls_since_report as usize
        );

        let events = NetworkEvents::default();
        session.report(
            "stream",
            HUNG_IP.parse().unwrap(),
            &tap,
            at(240_000.0),
            &events,
        );
        assert!(
            session.phases_since_report.is_empty(),
            "each report measures its own window's phases"
        );
        let est = session.tracker.last_estimate().copied().expect("estimate");
        assert!((est.reserve_ms - 600.0).abs() <= 50.0, "{est:?}");
        let published = tap.speaker_snapshot().expect("published");
        assert_eq!(published.reserve_ms, Some(est.reserve_ms.round() as i32));
        // The report goes to clients with the same figures.
        let sent = events.0.lock();
        match sent.as_slice() {
            [NetworkEvent::SpeakerHealth {
                reserve_ms,
                reserve_precision_ms,
                epoch_id: sent_epoch,
                ..
            }] => {
                assert_eq!(*reserve_ms, Some(est.reserve_ms.round() as i32));
                assert_eq!(
                    *reserve_precision_ms,
                    Some(est.half_width_ms.round() as u32)
                );
                assert_eq!(*sent_epoch, epoch_id);
            }
            other => panic!("expected one speaker health event, got {other:?}"),
        }
    }

    /// Answers `count` polls of `session` on `tap`'s connection, a
    /// second apart, from a speaker holding 600 ms.
    fn answer_polls(session: &mut SpeakerSession, tap: &ConnectionTap, count: u64) {
        let epoch_id = tap.epoch().expect("started").id;
        for poll_id in 1..=count {
            let ts = poll_id * 1000;
            let at = tap.connected_at + Duration::from_millis(ts);
            let delivered = tap.delivered_ms().map(|_| ts);
            session.in_flight = Some(poll_id);
            let result = PollResult {
                epoch_id,
                stream_elapsed_ms: ts,
                sent_at: at,
                answered_at: at + Duration::from_millis(10),
                delivered_ms_at_send: delivered,
                delivered_ms_at_answer: delivered.map(|d| d + 10),
                ..poll(poll_id, Ok(ours(ts.saturating_sub(600) / 1000 * 1000)))
            };
            apply_poll_result(session, result, &NoEvents, None);
        }
    }

    #[test]
    fn the_wall_clock_cushion_is_logged_only_for_compressed_codecs() {
        let pcm = started_tap("stream", HUNG_IP, true);
        let mut session = SpeakerSession::new(false, 0);
        session.attach(&pcm);
        answer_polls(&mut session, &pcm, 10);
        assert!(session.sample_count >= 10);
        assert!(
            session.last_diag_log.is_none(),
            "a PCM connection's reserve is measured; the cushion line would mislead"
        );

        let aac = started_tap_with_codec("stream", HUNG_IP, true, AudioCodec::Aac);
        let mut session = SpeakerSession::new(false, 0);
        session.attach(&aac);
        answer_polls(&mut session, &aac, 10);
        assert!(
            session.last_diag_log.is_some(),
            "a compressed connection keeps the cushion line and its trend"
        );
    }

    #[test]
    fn a_forced_rate_counts_until_the_guard_pins_it() {
        use crate::stream::rate_adapter::RateControl;
        for mode in [DriftMode::Off, DriftMode::Observe, DriftMode::On] {
            let control = Arc::new(RateControl::forced(150.0));
            let tap = started_tap_with_drift(
                "stream",
                HUNG_IP,
                true,
                AudioCodec::Pcm,
                mode,
                Some(control.clone()),
            );
            let mut session = SpeakerSession::new(false, 0);
            session.attach(&tap);
            assert_eq!(session.tracker.command_ppm(), 150.0, "{mode}");
            // Once the net-insertion guard holds the adapter at 0 ppm,
            // the forced rate no longer reaches the audio.
            control.pin();
            assert_eq!(session.command_in_force(&tap), 0.0, "{mode}");
        }
    }

    #[test]
    fn the_reserve_is_reported_every_30s() {
        let tap = started_tap("stream", HUNG_IP, true);
        let mut session = SpeakerSession::new(false, 0);
        session.attach(&tap);
        let attached = session.last_report.expect("attaching starts the clock");
        assert!(!session.report_due(attached + Duration::from_secs(29)));
        let due = attached + SPEAKER_REPORT_INTERVAL;
        assert!(session.report_due(due));
        session.report("stream", HUNG_IP.parse().unwrap(), &tap, due, &NoEvents);
        assert!(!session.report_due(due + Duration::from_secs(29)));
        assert!(session.report_due(due + SPEAKER_REPORT_INTERVAL));
    }

    #[test]
    fn a_connection_is_summarised_once_when_it_ends_or_is_replaced() {
        let ip: IpAddr = HUNG_IP.parse().unwrap();
        let mut session = SpeakerSession::new(false, 0);
        let first = started_tap("stream", HUNG_IP, true);
        session.attach(&first);
        // Replaced before a tick noticed it closing: attaching the next
        // connection summarises the first.
        let second = started_tap("stream", HUNG_IP, true);
        session.attach(&second);
        assert!(
            session.reconnect_gap.is_some(),
            "the replaced connection was summarised, which starts the gap"
        );
        assert!(session.summary_owed, "and the new one is owed its own");
        // The tick that finds it closed, then StopSpeaker or StopStream:
        // only the first logs.
        assert!(session.end_connection("stream", ip, Instant::now()));
        assert!(!session.end_connection("stream", ip, Instant::now()));
    }

    #[test]
    fn no_summary_is_owed_while_the_speaker_is_not_polled() {
        let ip: IpAddr = HUNG_IP.parse().unwrap();
        // Monitoring off and no video sync: never polled, never summarised.
        let mut session = SpeakerSession::new(false, 0);
        session.attach(&started_tap("stream", HUNG_IP, false));
        assert!(!session.end_connection("stream", ip, Instant::now()));
        // Video sync polls whatever the setting, so it is summarised.
        let mut session = SpeakerSession::new(true, 0);
        session.attach(&started_tap("stream", HUNG_IP, false));
        assert!(session.end_connection("stream", ip, Instant::now()));
    }

    /// Body bytes a Playbar reads behind the default WAV header before
    /// it takes the item to be over: 44 + 4294967295, 6h12m50s at 48 kHz
    /// stereo.
    const FIELD_DECLARED_END: u64 = 44 + u32::MAX as u64;

    /// A speaker that stops reading at its declared end, reported on: it
    /// holds about 250 ms, is polled for four minutes, and its
    /// acknowledgements lag a steady 20 ms until, half a second before
    /// the report, a single 525 ms lag. Read as a stall that is a 505 ms
    /// one leaving -5 ms, so `head_start_ran_out`.
    ///
    /// A synthetic shape, not the 6h12m field end (see
    /// `the_field_end_reading_on_past_the_declared_end_gets_no_notice`):
    /// it is what a speaker might do at a segment end. `tap` is the
    /// connection, its body `past_end` bytes beyond the declared end
    /// (negative: short of it). Returns the notice the report left
    /// standing and the session.
    fn report_a_stall_at_the_end(
        tap: &Arc<ConnectionTap>,
        past_end: i64,
    ) -> (
        Option<crate::services::speaker_monitor::SpeakerNoticeKind>,
        SpeakerSession,
    ) {
        let mut lags = vec![20.0; 59];
        lags.push(525.0);
        report_an_end(tap, past_end, &lags)
    }

    /// A speaker holding about 250 ms, polled for four minutes and
    /// reported on every 30 s, whose last window's ticks and pipeline
    /// snapshots saw acknowledgements lag by `lags_ms`. `tap` is the
    /// connection, its body `past_end` bytes beyond the declared end
    /// (negative: short of it) at the last report. Returns the notice
    /// that report left standing and the session.
    fn report_an_end(
        tap: &Arc<ConnectionTap>,
        past_end: i64,
        lags_ms: &[f64],
    ) -> (
        Option<crate::services::speaker_monitor::SpeakerNoticeKind>,
        SpeakerSession,
    ) {
        use crate::services::speaker_monitor::test_support::PollGen;

        let mut session = SpeakerSession::new(false, 0);
        session.attach(tap);
        let epoch_id = tap.epoch().expect("started").id;
        let origin = tap.connected_at;
        let at = |ms: f64| origin + Duration::from_secs_f64(ms / 1000.0);
        let mut gen = PollGen::new(61);
        gen.start_ms = 250.0;
        let mut poll_id = 0;
        let ip: IpAddr = HUNG_IP.parse().unwrap();
        for window_end in (30_000..=240_000).step_by(30_000) {
            let window_end = f64::from(window_end);
            gen.run_until(window_end, |p| {
                poll_id += 1;
                session.in_flight = Some(poll_id);
                let result = PollResult {
                    key: ("stream".to_string(), HUNG_IP.parse().unwrap()),
                    poll_id,
                    epoch_id,
                    stream_elapsed_ms: p.ts as u64,
                    rtt_ms: (p.tr - p.ts) as u32,
                    sent_at: at(p.ts),
                    answered_at: at(p.tr),
                    delivered_ms_at_send: Some(p.d_ts_ms as u64),
                    delivered_ms_at_answer: Some(p.d_tr_ms as u64),
                    net_inserted_ms: 0.0,
                    outcome: Ok(ours(p.rel_ms)),
                    transport: None,
                };
                apply_poll_result(&mut session, result, &NoEvents, None);
            });
            if window_end < 240_000.0 {
                session.report("stream", ip, tap, at(window_end), &NoEvents);
            }
        }
        let sent = FIELD_DECLARED_END.saturating_add_signed(past_end);
        tap.record_body_bytes(sent as usize);
        // What the window's ticks and pipeline snapshots saw of the
        // acknowledgements.
        session.tick_lags_ms.extend_from_slice(lags_ms);
        // The report's own tick.
        session.sample_ack_lag(tap);
        session.report("stream", ip, tap, at(240_000.0), &NoEvents);
        (session.notices.active().map(|n| n.kind), session)
    }

    /// The 6h12m field end as the log has it. The Playbar was read at
    /// 192 kB/s with acknowledgements a few kB behind throughout: the
    /// last report (nothing wrong in its lags here) came with the body
    /// about 8.2 s short of the 44 + 4294967295 bytes, the body passed
    /// them and went on being read and acknowledged for 1,793,025 bytes
    /// (9.3 s), and then the speaker hung up with the last delivery
    /// 585 ms old. None of that is a notice, and the end is logged as the
    /// item's.
    ///
    /// The field's `head_start_ran_out` ("Wi-Fi held back 505 ms") came
    /// from that last report, well short of the end, and has another
    /// cause: one 88 ms ack lag on a reserve drift had drained to 83 ms,
    /// on a link judged poor. The declared end does not cover it.
    #[test]
    fn the_field_end_reading_on_past_the_declared_end_gets_no_notice() {
        use crate::stream::cadence::end_suffix;
        use crate::stream::EndedBy;

        const RATE: i64 = 192_000;
        let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
        // Acknowledgements 1.5 to 3 kB (8 to 16 ms) behind, as sampled.
        let lags: Vec<f64> = (0..60).map(|i| 8.0 + f64::from(i % 3) * 4.0).collect();
        let short = -(RATE * 82 / 10);
        let (notice, mut session) = report_an_end(&tap, short, &lags);
        assert_eq!(notice, None);
        assert!(!tap.near_declared_end(), "8.2 s short is measured as usual");
        assert!(session.tracker.stall_ms().is_some());

        // Half-second ticks carry the body on past the end, still read.
        let origin = tap.connected_at;
        let mut sent = FIELD_DECLARED_END.saturating_add_signed(short);
        let close = FIELD_DECLARED_END + 1_793_025;
        while sent < close {
            let step = (RATE as u64 / 2).min(close - sent);
            tap.record_body_bytes(step as usize);
            sent += step;
            session.sample_ack_lag(&tap);
        }
        assert!(tap.near_declared_end() && tap.reached_declared_end());
        assert!(session.declared_end_in_window && session.declared_end_reached);
        // A report landing in those 9 s decides nothing either.
        let ip: IpAddr = HUNG_IP.parse().unwrap();
        session.tick_lags_ms.extend_from_slice(&lags);
        session.report(
            "stream",
            ip,
            &tap,
            origin + Duration::from_secs(270),
            &NoEvents,
        );
        assert_eq!(session.notices.active().map(|n| n.kind), None);
        assert_eq!(session.tracker.stall_ms(), None);

        // The speaker hangs up: the end line and the summary say so.
        assert_eq!(
            end_suffix(EndedBy::Client, tap.reached_declared_end(), 585),
            " at its declared end"
        );
        assert!(session.declared_end_reached, "for the summary");
        // Owed as it is for any speaker being polled.
        session.summary_owed = true;
        assert!(session.end_connection("stream", ip, Instant::now()));
        assert!(!session.declared_end_reached, "taken by the summary");
    }

    #[test]
    fn a_speaker_that_stops_reading_at_its_declared_end_gets_no_notice() {
        // Half a second of audio past the end.
        let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
        let (notice, session) = report_a_stall_at_the_end(&tap, 96_000);
        assert_eq!(notice, None, "the end of the item is not Wi-Fi trouble");
        assert_eq!(session.tracker.stall_ms(), None, "and no stall");
        assert!(session.tracker.last_estimate().is_some_and(|e| e.locked()));
        assert!(!session.declared_end_in_window, "consumed by the report");
        assert!(session.declared_end_reached, "for the summary");

        // Just short of the end the speaker still has audio to read, but
        // the window is already the end's.
        let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
        let (notice, session) = report_a_stall_at_the_end(&tap, -96_000);
        assert_eq!(notice, None);
        assert!(!session.declared_end_reached);
    }

    #[test]
    fn the_same_stall_short_of_the_declared_end_is_still_a_notice() {
        use crate::services::speaker_monitor::SpeakerNoticeKind;

        // A connection with no declared end, as before.
        let tap = started_tap("stream", HUNG_IP, true);
        let (notice, _) = report_a_stall_at_the_end(&tap, 96_000);
        assert_eq!(notice, Some(SpeakerNoticeKind::HeadStartRanOut));
        // Well before the end: a real stall. The field's notice sat
        // about as far short of its end, so the declared end is no guard
        // against it.
        let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
        let (notice, session) = report_a_stall_at_the_end(&tap, -10 * 192_000);
        assert_eq!(notice, Some(SpeakerNoticeKind::HeadStartRanOut));
        assert_eq!(session.tracker.stall_ms(), Some(505.0));
        // A speaker still reading a minute past the end is not honouring it.
        let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
        let (notice, _) = report_a_stall_at_the_end(&tap, 61 * 192_000);
        assert_eq!(notice, Some(SpeakerNoticeKind::HeadStartRanOut));
    }

    #[test]
    fn a_window_that_came_near_the_declared_end_stays_the_ends() {
        let tap = started_tap_with_declared_end("stream", HUNG_IP, FIELD_DECLARED_END);
        let mut session = SpeakerSession::new(false, 0);
        session.attach(&tap);
        tap.record_body_bytes(FIELD_DECLARED_END as usize);
        session.sample_ack_lag(&tap);
        assert!(session.declared_end_in_window);
        assert!(session.declared_end_reached);
        // A new connection starts clean.
        session.attach(&started_tap("stream", HUNG_IP, true));
        assert!(!session.declared_end_in_window);
        assert!(!session.declared_end_reached);
    }

    #[test]
    fn a_poll_with_no_trustworthy_transport_state_is_still_measured() {
        let mut session = SpeakerSession::new(true, 0);
        session.in_flight = Some(1);
        apply_poll_result(&mut session, poll(1, Ok(ours(4000))), &NoEvents, None);
        assert_eq!(session.sample_count, 1);
    }
}

#[test]
fn process_poll_ceiling_stretches_intervals() {
    let mean_dither = MONITOR_POLL_DITHER_MS / 2;
    for sessions in 1..=5 {
        assert_eq!(
            monitor_poll_interval_ms(mean_dither, sessions),
            MONITOR_POLL_INTERVAL_MS + mean_dither,
            "up to five speakers poll at the base interval"
        );
    }
    for sessions in 1..=40usize {
        let interval = monitor_poll_interval_ms(mean_dither, sessions);
        let per_minute = sessions as u64 * 60_000 / interval;
        assert!(
            per_minute <= SPEAKER_MONITOR_MAX_POLLS_PER_MIN,
            "{sessions} speakers poll {per_minute} times a minute"
        );
    }
    assert_eq!(
        monitor_poll_interval_ms(mean_dither, 10),
        2 * (MONITOR_POLL_INTERVAL_MS + mean_dither),
        "ten speakers each poll half as often"
    );
    assert_eq!(MONITOR_POLLS_PER_MIN, 24);
}

#[test]
fn more_than_12_monitor_only_speakers_cannot_hold_a_lock() {
    for sessions in 1..=12 {
        assert!(!monitor_capacity_exceeded(sessions), "{sessions} speakers");
    }
    assert!(monitor_capacity_exceeded(13));
    assert_eq!(monitor_polls_per_window(5), 72.0);
}

#[test]
fn the_draining_warning_fires_once_until_the_drain_recovers() {
    use MonitorState::{Draining, Locking, Ok};
    let mut warned = false;
    let mut step =
        |state, tte, clock_drains| draining_warning_due(&mut warned, state, tte, clock_drains);
    assert!(step(Draining, Some(900.0), true), "fires on entering");
    assert!(!step(Draining, Some(880.0), true), "once");
    // The estimate unlocks, or an offset step clears it, while the clock
    // still drains: no new warning when it comes back.
    assert!(!step(Locking, None, true));
    assert!(!step(Draining, Some(860.0), true));
    // Between the warning and clearing thresholds nothing changes.
    assert!(!step(Ok, Some(40.0 * 60.0), true));
    assert!(!step(Draining, Some(850.0), true));
    // Recovering past the clearing threshold re-arms it.
    assert!(!step(Ok, Some(DRAINING_CLEAR_SECS), true));
    assert!(step(Draining, Some(800.0), true));
    // So does the clock ceasing to drain.
    assert!(!step(Ok, None, false));
    assert!(step(Draining, Some(800.0), true));
}

#[test]
fn a_low_speaker_that_is_also_draining_still_gets_the_draining_warning() {
    use MonitorState::{Draining, Low};
    let mut warned = false;
    assert!(
        !draining_warning_due(&mut warned, Low, Some(35.0 * 60.0), true),
        "low, but not projected to reach the floor soon"
    );
    assert!(draining_warning_due(&mut warned, Low, Some(600.0), true));
    assert!(!draining_warning_due(
        &mut warned,
        Draining,
        Some(580.0),
        true
    ));
}

#[test]
fn the_acknowledged_reserve_is_logged_only_when_measured() {
    use crate::services::speaker_monitor::AckedReserve;
    let acked = |measured| {
        Some(AckedReserve {
            min_ms: 431.4,
            p10_ms: 470.0,
            median_ms: 480.0,
            measured,
            stall_ms: None,
        })
    };
    assert_eq!(
        format_acked(acked(true), Some(540.2)),
        " (acked min30s=431 p10=470) dropped=70"
    );
    assert_eq!(format_acked(acked(false), Some(540.0)), " dropped=70");
    assert_eq!(
        format_acked(acked(true), None),
        " (acked min30s=431 p10=470)"
    );
    assert_eq!(format_acked(None, None), "");
}

#[test]
fn topology_changes_go_on_the_next_report_line_and_into_the_summary_count() {
    let rebooted = |to| MemberChange::DeviceRebooted {
        uuid: "RINCON_SUB".to_string(),
        from: 31,
        to,
    };
    let mut session = SpeakerSession::new(false, 0);
    assert_eq!(format_topology(&session.topology_since_report), "");

    session.note_topology(rebooted(32));
    assert_eq!(
        format_topology(&session.topology_since_report),
        " topology[RINCON_SUB rebooted (BootSeq 31->32)]"
    );

    // A flapping device fills the line up to its cap; the summary still
    // counts every change.
    for to in 33..45 {
        session.note_topology(rebooted(to));
    }
    assert_eq!(session.topology_since_report.len(), MAX_TOPOLOGY_NOTES);
    assert_eq!(session.connection_topology_changes, 13);
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

#[test]
fn the_report_line_shows_a_forced_rate_in_every_mode() {
    let mut drift = DriftController::default();
    drift.start_connection(DriftMode::Off, true);
    assert_eq!(format_drift(&drift, Some(0.0), None, false), "drift=off");
    assert_eq!(
        format_drift(&drift, Some(12.4), Some(150.0), false),
        "drift=off forced=+150ppm ins=+12ms"
    );
    assert_eq!(
        format_drift(&drift, Some(2000.0), Some(150.0), true),
        "drift=off forced=+150ppm(pinned) ins=+2000ms"
    );
    drift.start_connection(DriftMode::Observe, true);
    let line = format_drift(&drift, Some(-3.0), Some(-42.5), false);
    assert!(line.starts_with("drift=observe would_cmd="), "{line}");
    assert!(line.ends_with(" forced=-42.5ppm ins=-3ms"), "{line}");
    assert_eq!(line.matches("ins=").count(), 1, "{line}");
}

#[test]
fn the_report_line_shows_the_controller_holding_or_steering_by_a_carried_estimate() {
    let mut drift = DriftController::new(SpeakerControlState {
        integral_ppm: 19.0,
        seeded: true,
        ..SpeakerControlState::default()
    });
    drift.start_connection(DriftMode::On, true);
    drift.update(&ControlInput {
        settling: true,
        ..ControlInput::default()
    });
    assert_eq!(
        format_drift(&drift, Some(431.0), None, false),
        "drift=on cmd=+19.0ppm(settle) I=+19.0 taught=0m pull=\u{2014} ins=+431ms"
    );
    // Steering by the estimate carried across a switch.
    drift.update(&ControlInput {
        now_s: 30.0,
        estimate: Some(crate::services::speaker_monitor::ReserveEstimate {
            at: 30_000.0,
            reserve_ms: 500.0,
            half_width_ms: 60.0,
            inconsistent: false,
            jitter_ms: 25.0,
            polls: 12,
            lock_reason: crate::services::speaker_monitor::LockReason::Held,
        }),
        target_ms: Some(500.0),
        head_start_ms: Some(500),
        carry: crate::services::speaker_monitor::EstimateCarry::Teaches,
        ..ControlInput::default()
    });
    assert_eq!(
        format_drift(&drift, Some(431.0), None, false),
        "drift=on cmd=+19.0ppm(carried) I=+19.0 taught=0m pull=\u{2014} ins=+431ms"
    );
}

#[test]
fn the_report_line_shows_how_long_the_integral_was_taught_and_the_clock_fit_drawing_it() {
    use crate::services::speaker_monitor::{ClockEstimate, LockReason, ReserveEstimate};
    let mut drift = DriftController::new(SpeakerControlState {
        integral_ppm: 17.6,
        seeded: true,
        taught_s: 93.0 * 60.0,
        ..SpeakerControlState::default()
    });
    drift.start_connection(DriftMode::On, true);
    let tight = ReserveEstimate {
        at: 0.0,
        reserve_ms: 450.0,
        half_width_ms: 30.0,
        inconsistent: false,
        jitter_ms: 25.0,
        polls: 72,
        lock_reason: LockReason::Tight,
    };
    let report = |now_s: f64, clock: Option<ClockEstimate>| ControlInput {
        now_s,
        estimate: Some(tight),
        target_ms: Some(450.0),
        head_start_ms: Some(500),
        clock,
        ..ControlInput::default()
    };
    // On target, so only the fit moves the integral: taught for 93 min
    // it is weighed as 8.5 ppm off, the fit's ±2 ppm as ±3, and 0.089 of
    // the 1.4 ppm gap is drawn.
    drift.update(&report(
        0.0,
        Some(ClockEstimate {
            ppm: 19.0,
            se_ppm: 2.0,
            span_ms: 90.0 * 60_000.0,
            dof: 85,
        }),
    ));
    assert_eq!(
        format_drift(&drift, Some(54.0), None, false),
        "drift=on cmd=+10.0ppm I=+17.7 taught=93m pull=+0.12ppm ins=+54ms"
    );
    // With no fit precise enough, nothing is drawn.
    drift.update(&report(30.0, None));
    drift.start_connection(DriftMode::Observe, true);
    drift.update(&report(60.0, None));
    let line = format_drift(&drift, None, None, false);
    assert!(
        line.ends_with(" I=+17.7 taught=94m pull=\u{2014}"),
        "{line}"
    );
}
