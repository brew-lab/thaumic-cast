//! Continuity of a PCM playout across its segment connections, end to end
//! through the real cadence.
//!
//! The source is a counter: every 4-byte sample frame carries its own index,
//! so any byte skipped, repeated or misaligned anywhere in the concatenated
//! segment data shows up as a break in the count. A tone would hide a whole
//! frame skipped or repeated whenever it happens to be phase-continuous.

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Instant as StdInstant;

use bytes::Bytes;
use futures::StreamExt;
use tokio::sync::broadcast;
use tokio::time::{sleep, timeout, Duration};

use super::*;
use crate::stream::manager::TimestampedFrame;
use crate::stream::{create_wav_stream_with_cadence, CadenceConfig, EndedBy, HeadStart};

/// Bytes in one sample frame at 48 kHz 16-bit stereo.
const FRAME: usize = 4;
/// Sample frames per millisecond at 48 kHz.
const PER_MS: u32 = 48;
/// Audio queued before the first connection (the jitter buffer), in ms.
const PREFILL_MS: u32 = 100;

/// A stream source counting sample frames, and the playouts it feeds.
struct Rig {
    tx: broadcast::Sender<Bytes>,
    format: AudioFormat,
    layout: SegmentLayout,
    registry: Arc<PlayoutRegistry>,
    ip: IpAddr,
    /// The first counter value the next playout's prefill starts at.
    next_tick: Arc<std::sync::atomic::AtomicU32>,
    head_start_ms: u64,
    /// Milliseconds of audio in each cadence frame.
    tick_ms: u32,
    /// Whether playouts are made with the drift controller steering them.
    drift_on: bool,
    /// Where playouts tell their events.
    events: Option<Arc<dyn PlayoutEvents>>,
}

/// One cadence frame of `tick_ms` whose sample frames count on from the
/// start of tick `tick`.
fn counter_frame(tick: u32, tick_ms: u32) -> Bytes {
    let per_tick = PER_MS * tick_ms;
    let mut data = Vec::with_capacity(per_tick as usize * FRAME);
    for i in 0..per_tick {
        data.extend_from_slice(&(tick * per_tick + i).to_le_bytes());
    }
    Bytes::from(data)
}

impl Rig {
    /// A rig cutting segments of `data_bytes`, with its source running in
    /// 10 ms frames.
    fn new(data_bytes: u64) -> Self {
        Self::with_frames(data_bytes, 10)
    }

    /// A rig cutting segments of `data_bytes`, with its source running in
    /// frames of `tick_ms`.
    fn with_frames(data_bytes: u64, tick_ms: u32) -> Self {
        let format = AudioFormat::new(48_000, 2, 16);
        let (tx, _) = broadcast::channel::<Bytes>(64);
        let next_tick = Arc::new(std::sync::atomic::AtomicU32::new(PREFILL_MS / tick_ms));
        let rig = Self {
            tx,
            format,
            layout: SegmentLayout::new(&format, data_bytes),
            registry: Arc::new(PlayoutRegistry::default()),
            ip: "192.168.1.50".parse().unwrap(),
            next_tick,
            head_start_ms: 0,
            tick_ms,
            drift_on: false,
            events: None,
        };
        let tx = rig.tx.clone();
        let next = Arc::clone(&rig.next_tick);
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_millis(u64::from(tick_ms)));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
            loop {
                interval.tick().await;
                let tick = next.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                let _ = tx.send(counter_frame(tick, tick_ms));
            }
        });
        rig
    }

    fn guard(&self) -> Arc<LoggingStreamGuard> {
        Arc::new(LoggingStreamGuard::new("s".into(), self.ip))
    }

    /// Asks the registry what a fetch is.
    fn route(&self, url_segment: u32, range: Option<u64>) -> Route {
        let guard = self.guard();
        self.registry
            .route(self.ip, url_segment, range, &self.layout, move |_| guard)
    }

    /// Starts a playout from the live edge for a fetch the registry sent
    /// to a new one, with the ring's last ticks as its prefill.
    fn start(&self, start: SegmentStart) -> SegmentBody {
        let now = self.next_tick.load(std::sync::atomic::Ordering::Relaxed);
        let rx = self.tx.subscribe();
        let prefill = (now.saturating_sub(PREFILL_MS / self.tick_ms)..now)
            .map(|tick| TimestampedFrame {
                captured_at: StdInstant::now(),
                data: counter_frame(tick, self.tick_ms),
            })
            .collect();
        let config = CadenceConfig::new(
            self.format.silence_frame(self.tick_ms),
            u64::from(PREFILL_MS),
            0,
            self.tick_ms,
            self.format,
            prefill,
        );
        let stats = Arc::new(ChainStats::new("s", self.ip));
        let tap = (self.head_start_ms > 0).then(|| {
            let mut tap = ConnectionTap::new(
                "s",
                self.ip,
                StdInstant::now(),
                crate::stream::AudioCodec::Pcm,
                &self.format,
                Arc::clone(&stats),
                true,
            );
            if self.drift_on {
                let control = Arc::new(crate::stream::RateControl::new());
                control.mark_engaged();
                tap = tap.with_drift(crate::model::DriftMode::On, Some(control));
            }
            let tap = Arc::new(tap);
            tap.set_head_start(HeadStart::new(self.head_start_ms, self.head_start_ms));
            tap
        });
        let cadence: PcmStream = Box::pin(create_wav_stream_with_cadence(
            rx,
            Arc::clone(&stats),
            config,
            None,
            None,
        ));
        PlayoutChain::start(ChainParts {
            stream_id: "s".into(),
            speaker_ip: self.ip,
            format: self.format,
            layout: self.layout,
            cadence,
            stats,
            tap,
            start,
            guard: self.guard(),
            registry: Some(Arc::clone(&self.registry)),
            continuation: PcmContinuation::Restart,
            segment_didl: PcmSegmentDidl::Broadcast,
            head_start: Duration::from_millis(self.head_start_ms),
            events: self.events.clone(),
        })
    }

    /// A fetch that must continue the playout.
    fn attach(&self, url_segment: u32) -> SegmentBody {
        match self.route(url_segment, None) {
            Route::Attach(body) => body,
            other => panic!(
                "segment {url_segment}: expected a continuation, got {}",
                label(&other)
            ),
        }
    }

    /// The first fetch of a playout.
    fn first(&self) -> SegmentBody {
        match self.route(0, None) {
            Route::New(NewReason::NoPlayout, start) => self.start(start),
            other => panic!("expected a new playout, got {}", label(&other)),
        }
    }
}

fn label(route: &Route) -> String {
    match route {
        Route::Attach(_) => "attach".into(),
        Route::Side(_) => "side".into(),
        Route::Unsatisfiable(n) => format!("unsatisfiable({n})"),
        Route::New(reason, _) => format!("new({})", reason.label()),
    }
}

/// Reads a body to its end.
async fn read_to_end(body: &mut SegmentBody) -> Vec<u8> {
    let mut out = Vec::new();
    while let Some(item) = body.next().await {
        out.extend_from_slice(&item.expect("body item"));
    }
    out
}

/// Reads at least `n` bytes of a body (whole items, so possibly a little
/// more), leaving it open.
async fn read_at_least(body: &mut SegmentBody, n: usize) -> Vec<u8> {
    let mut out = Vec::new();
    while out.len() < n {
        let item = body.next().await.expect("body ended early");
        out.extend_from_slice(&item.expect("body item"));
    }
    out
}

/// Reads whatever a body yields within `wait`.
async fn read_for(body: &mut SegmentBody, wait: Duration) -> Vec<u8> {
    let mut out = Vec::new();
    let _ = timeout(wait, async {
        while let Some(item) = body.next().await {
            out.extend_from_slice(&item.expect("body item"));
        }
    })
    .await;
    out
}

/// The sample-frame counters in `data`.
fn counters(data: &[u8]) -> Vec<u32> {
    assert_eq!(data.len() % FRAME, 0, "whole sample frames");
    data.chunks_exact(FRAME)
        .map(|c| u32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

/// Asserts `data` counts up by one throughout, and returns its first and
/// last counters.
fn assert_contiguous(data: &[u8], what: &str) -> (u32, u32) {
    let values = counters(data);
    assert!(!values.is_empty(), "{what}: no audio");
    for (i, pair) in values.windows(2).enumerate() {
        assert_eq!(
            pair[1],
            pair[0] + 1,
            "{what}: break after sample frame {i} ({} then {})",
            pair[0],
            pair[1]
        );
    }
    (values[0], *values.last().unwrap())
}

/// Splits a whole segment body into its header and data, checking both.
fn segment_data<'a>(body: &'a [u8], layout: &SegmentLayout) -> &'a [u8] {
    assert_eq!(body.len() as u64, layout.total_bytes(), "a whole segment");
    assert_eq!(&body[..4], b"RIFF");
    let declared = u32::from_le_bytes([body[40], body[41], body[42], body[43]]);
    assert_eq!(u64::from(declared), layout.data_bytes());
    &body[44..]
}

/// Three segments fetched one after another, each with a different pause
/// before the next fetch (none, one second, three seconds: the speaker's
/// reserve covers the gap), concatenate to one unbroken count, each segment
/// exactly its declared size.
#[tokio::test(start_paused = true)]
async fn segments_fetched_after_gaps_are_one_unbroken_count() {
    let rig = Rig::new(96_000);
    let mut all = Vec::new();

    let mut body = rig.first();
    let first = read_to_end(&mut body).await;
    assert_eq!(body.guard().ended_by(), EndedBy::Length);
    drop(body);
    all.extend_from_slice(segment_data(&first, &rig.layout));

    for (segment, gap_ms) in [(1, 0), (2, 1_000), (3, 3_000)] {
        sleep(Duration::from_millis(gap_ms)).await;
        let mut body = rig.attach(segment);
        let data = read_to_end(&mut body).await;
        all.extend_from_slice(segment_data(&data, &rig.layout));
        // The speaker monitor's delivered count runs on across segments,
        // headers excluded.
        let chain = Arc::clone(body.playout());
        assert_eq!(
            chain.stats.position(),
            u64::from(segment + 1) * rig.layout.data_bytes()
        );
        assert!(chain.produced() >= chain.stats.position());
    }
    assert_eq!(rig.registry.len(), 1, "one playout throughout");
    let (start, end) = assert_contiguous(&all, "four segments");
    assert_eq!(u64::from(end - start + 1) * 4, 4 * rig.layout.data_bytes());
}

/// A segment's end that falls inside a cadence frame splits it: the head
/// ends the segment, and the tail opens the next one.
#[tokio::test(start_paused = true)]
async fn a_frame_crossing_the_end_is_split_between_segments() {
    // 20 ms frames of 3840 bytes; 51 × 1920 bytes ends half way into one.
    let rig = Rig::with_frames(97_920, 20);
    assert_eq!(rig.layout.data_bytes(), 97_920);
    let mut all = Vec::new();
    let mut body = rig.first();
    all.extend_from_slice(segment_data(&read_to_end(&mut body).await, &rig.layout));
    drop(body);
    for segment in 1..=3 {
        let mut body = rig.attach(segment);
        all.extend_from_slice(segment_data(&read_to_end(&mut body).await, &rig.layout));
    }
    assert_contiguous(&all, "split frames");
}

/// Without the playout, a later segment starts from the live edge: the same
/// fetches through a new playout each time leave a gap in the count. This
/// is what the continuation exists to prevent.
#[tokio::test(start_paused = true)]
async fn a_fresh_playout_per_segment_would_skip_audio() {
    let rig = Rig::new(96_000);
    let mut first = rig.first();
    let a = read_to_end(&mut first).await;
    let a_last = *counters(segment_data(&a, &rig.layout)).last().unwrap();
    drop(first);
    sleep(Duration::from_secs(1)).await;
    let start = SegmentStart::new(1, None, &rig.layout).unwrap();
    rig.registry.get(rig.ip).unwrap().retire("test");
    let mut fresh = rig.start(start);
    let b = read_to_end(&mut fresh).await;
    let b_first = counters(segment_data(&b, &rig.layout))[0];
    assert!(b_first > a_last + 1, "{a_last} then {b_first}");
}

/// A speaker that fetches the next segment as soon as it is queued (a
/// Play:1 coordinator does, even with broadcast DIDL) gets only the header
/// while the audio does not exist yet, and closes it after about ten
/// seconds; that fetch takes nothing from the segment being served, and the
/// real fetch at the boundary continues the count.
#[tokio::test(start_paused = true)]
async fn an_early_probe_fetch_takes_no_audio() {
    let rig = Rig::new(1_920_000); // 10 s segments
    let mut body = rig.first();
    let mut seg0 = read_at_least(&mut body, 44 + 192_000).await;
    // The speaker goes on reading the segment it plays throughout.
    let reader = tokio::spawn(async move {
        let rest = read_to_end(&mut body).await;
        drop(body);
        rest
    });

    let mut probe = rig.attach(1);
    let probed = read_for(&mut probe, Duration::from_secs(3)).await;
    assert_eq!(probed.len(), 44, "the header only");
    drop(probe);

    seg0.extend(reader.await.unwrap());
    let mut next = rig.attach(1);
    let seg1 = read_to_end(&mut next).await;

    let mut all = segment_data(&seg0, &rig.layout).to_vec();
    all.extend_from_slice(segment_data(&seg1, &rig.layout));
    assert_contiguous(&all, "around a probe");
}

/// An early fetch still open when the segment ends takes over there, and
/// carries on the count.
#[tokio::test(start_paused = true)]
async fn an_early_fetch_open_at_the_end_takes_over() {
    let rig = Rig::new(96_000);
    let mut body = rig.first();
    let mut seg0 = read_at_least(&mut body, 44 + 19_200).await;
    let mut early = rig.attach(1);
    seg0.extend(read_to_end(&mut body).await);
    drop(body);
    let seg1 = read_to_end(&mut early).await;

    let mut all = segment_data(&seg0, &rig.layout).to_vec();
    all.extend_from_slice(segment_data(&seg1, &rig.layout));
    assert_contiguous(&all, "early takeover");
}

/// If the early fetch was only a probe after all, still open when the
/// speaker fetches the segment for real, the real fetch is sent the segment
/// from its first byte: the speaker played none of it.
#[tokio::test(start_paused = true)]
async fn the_real_fetch_after_a_lingering_probe_starts_the_segment_afresh() {
    let mut rig = Rig::new(96_000);
    rig.head_start_ms = 2_000;
    let mut body = rig.first();
    let mut seg0 = read_at_least(&mut body, 44 + 19_200).await;
    let mut probe = rig.attach(1);
    seg0.extend(read_to_end(&mut body).await);
    drop(body);
    // The probe is handed some of segment 1, which the speaker ignores.
    let probed = read_at_least(&mut probe, 44 + 1_920).await;
    assert!(probed.len() > 44);

    let mut real = rig.attach(1);
    assert!(probe.next().await.is_none(), "the probe is superseded");
    drop(probe);
    let seg1 = read_to_end(&mut real).await;

    let mut all = segment_data(&seg0, &rig.layout).to_vec();
    all.extend_from_slice(segment_data(&seg1, &rig.layout));
    assert_contiguous(&all, "replayed after a probe");
}

/// A second plain fetch of the segment being served (a Playbar makes one
/// right after it switches) is held with just the header and never touches
/// the connection the speaker plays from; a fetch with a range past the
/// segment's end is refused.
#[tokio::test(start_paused = true)]
async fn a_duplicate_fetch_leaves_the_served_segment_alone() {
    let rig = Rig::new(96_000);
    let mut body = rig.first();
    let seg0 = read_to_end(&mut body).await;
    drop(body);
    let mut seg1_body = rig.attach(1);
    let mut seg1 = read_at_least(&mut seg1_body, 44 + 9_600).await;
    let reader = tokio::spawn(async move { read_to_end(&mut seg1_body).await });

    let Route::Side(start) = rig.route(1, None) else {
        panic!("a duplicate is a side fetch");
    };
    let mut side = side_body(start, &rig.layout, &rig.format);
    let got = timeout(Duration::from_secs(2), side.next())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(got.len(), 44);
    assert!(
        timeout(Duration::from_secs(2), side.next()).await.is_err(),
        "then nothing"
    );
    drop(side);
    assert!(matches!(
        rig.route(1, Some(rig.layout.total_bytes())),
        Route::Unsatisfiable(_)
    ));

    seg1.extend(reader.await.unwrap());
    let mut all = segment_data(&seg0, &rig.layout).to_vec();
    all.extend_from_slice(segment_data(&seg1, &rig.layout));
    assert_contiguous(&all, "past a duplicate");
}

/// A speaker that fetches the segment it just finished again is served the
/// playout's next audio under it, so nothing is repeated.
#[tokio::test(start_paused = true)]
async fn a_reopened_segment_carries_on_the_count() {
    let rig = Rig::new(96_000);
    let mut body = rig.first();
    let seg0 = read_to_end(&mut body).await;
    drop(body);
    sleep(Duration::from_millis(500)).await;
    let mut again = rig.attach(0);
    let reopened = read_to_end(&mut again).await;
    drop(again);
    let mut next = rig.attach(1);
    let seg1 = read_to_end(&mut next).await;

    let mut all = segment_data(&seg0, &rig.layout).to_vec();
    all.extend_from_slice(segment_data(&reopened, &rig.layout));
    all.extend_from_slice(segment_data(&seg1, &rig.layout));
    assert_contiguous(&all, "reopened");
}

/// The user pressing Next in the Sonos app closes the segment part way and
/// fetches the next one: it starts at the first byte not yet sent.
#[tokio::test(start_paused = true)]
async fn a_skip_to_the_next_segment_starts_at_the_next_unsent_byte() {
    let rig = Rig::new(192_000);
    let mut body = rig.first();
    let seg0 = read_to_end(&mut body).await;
    drop(body);
    let mut seg1_body = rig.attach(1);
    let seg1 = read_at_least(&mut seg1_body, 44 + 48_000).await;
    drop(seg1_body);
    let mut seg2_body = rig.attach(2);
    let seg2 = read_to_end(&mut seg2_body).await;
    assert_eq!(seg2.len() as u64, rig.layout.total_bytes());

    let mut all = segment_data(&seg0, &rig.layout).to_vec();
    all.extend_from_slice(&seg1[44..]);
    all.extend_from_slice(&seg2[44..]);
    assert_contiguous(&all, "skipped ahead");
}

/// A speaker resuming after a pause fetches its segment again with a range
/// from where it stopped: it is answered with exactly the rest of that
/// segment, from the live edge, so the segment still ends at its declared
/// size, and the next segment carries on from there.
#[tokio::test(start_paused = true)]
async fn a_ranged_resume_gets_exactly_the_rest_of_its_segment() {
    let rig = Rig::new(192_000);
    let mut body = rig.first();
    let _ = read_to_end(&mut body).await;
    drop(body);
    let mut seg1_body = rig.attach(1);
    let seg1 = read_at_least(&mut seg1_body, 44 + 76_800).await;
    drop(seg1_body);
    sleep(Duration::from_secs(20)).await; // paused

    let x = 44 + 76_800;
    let resumed = match rig.route(1, Some(x)) {
        Route::New(NewReason::RangeResume, start) => {
            assert!(start.is_partial());
            assert_eq!(start.first_byte(), x);
            assert_eq!(start.preroll(&rig.layout), Duration::from_millis(400));
            start
        }
        other => panic!("expected a ranged resume, got {}", label(&other)),
    };
    let mut rest_body = rig.start(resumed);
    let rest = read_to_end(&mut rest_body).await;
    assert_eq!(rest.len() as u64, rig.layout.total_bytes() - x);
    assert_eq!(rest_body.guard().ended_by(), EndedBy::Length);
    drop(rest_body);
    assert!(seg1.len() as u64 >= x);

    let mut next = rig.attach(2);
    let seg2 = read_to_end(&mut next).await;
    let mut all = rest.clone();
    all.extend_from_slice(segment_data(&seg2, &rig.layout));
    assert_contiguous(&all, "after the resume");
}

/// A resume's plain fetch, then its ranged one while the plain one is still
/// open: the ranged one replaces it.
#[tokio::test(start_paused = true)]
async fn a_ranged_fetch_replaces_the_plain_one_before_it() {
    let rig = Rig::new(192_000);
    let mut body = rig.first();
    let _ = read_at_least(&mut body, 44 + 76_800).await;
    drop(body);
    let plain = match rig.route(0, None) {
        Route::New(NewReason::Resume, start) => rig.start(start),
        other => panic!("expected a resume, got {}", label(&other)),
    };
    let mut plain = plain;
    let _ = read_at_least(&mut plain, 44).await;
    match rig.route(0, Some(44 + 76_800)) {
        Route::New(NewReason::RangeResume, start) => {
            let mut ranged = rig.start(start);
            assert!(plain.next().await.is_none(), "the plain fetch ends");
            let rest = read_to_end(&mut ranged).await;
            assert_eq!(rest.len() as u64, rig.layout.total_bytes() - (44 + 76_800));
        }
        other => panic!("expected a ranged resume, got {}", label(&other)),
    }
}

/// A playout parked with no fetch for longer than [`PARK_MAX`] is dropped,
/// and the next fetch starts afresh.
#[tokio::test(start_paused = true)]
async fn a_playout_parked_too_long_is_dropped() {
    let rig = Rig::new(96_000);
    let mut body = rig.first();
    let _ = read_to_end(&mut body).await;
    drop(body);
    sleep(PARK_MAX - Duration::from_secs(5)).await;
    rig.registry.note_stopped(rig.ip);
    sleep(Duration::from_secs(10)).await;
    assert!(
        rig.registry.get(rig.ip).is_some(),
        "counted from STOPPED, not from the end"
    );
    sleep(PARK_MAX).await;
    assert!(rig.registry.get(rig.ip).is_none());
    assert!(matches!(
        rig.route(1, None),
        Route::New(NewReason::NoPlayout, _)
    ));
}

/// Sample frames the rejoin fade covers at 48 kHz (5 ms).
const FADE_FRAMES: usize = 240;

/// Reads the rest of segment 0 and the whole of segment 1 after a restart
/// `gap` after segment 0's end, readied with `prepare_restart`. Returns the
/// last counter of segment 0, segment 1's data and the playout.
async fn restart_after(rig: &Rig, gap: Duration) -> (u32, Vec<u8>, Arc<PlayoutChain>) {
    let mut body = rig.first();
    let seg0 = read_to_end(&mut body).await;
    drop(body);
    let last0 = *counters(segment_data(&seg0, &rig.layout)).last().unwrap();
    sleep(gap).await;
    let chain = rig.registry.get(rig.ip).expect("parked");
    assert!(chain.awaiting_after(0));
    let expected = if rig.drift_on {
        Rejoin::Exact
    } else {
        Rejoin::Trim
    };
    assert_eq!(chain.prepare_restart(1), Some(expected));
    let mut next = rig.attach(1);
    let seg1 = read_to_end(&mut next).await;
    (last0, segment_data(&seg1, &rig.layout).to_vec(), chain)
}

/// With nothing to pay back the latency a restart adds (drift correction
/// not steering), the speaker rejoins with only its head start of what
/// built up while it stopped and restarted: the oldest is dropped, which the
/// speaker's silence covers, and the rest fades in and then counts on
/// exactly. Without the trim the whole 2.5 s would be sent and kept as
/// latency for the rest of the cast.
#[tokio::test(start_paused = true)]
async fn a_restart_with_nothing_to_repay_it_rejoins_with_the_head_start() {
    let mut rig = Rig::new(384_000); // 2 s segments
    rig.head_start_ms = 500;
    let (last0, seg1, chain) = restart_after(&rig, Duration::from_millis(2_500)).await;

    let values = counters(&seg1);
    assert_eq!(values[0], 0, "faded in from silence");
    let (first, _) = assert_contiguous(&seg1[FADE_FRAMES * FRAME..], "after the fade");
    let dropped_ms = (first - FADE_FRAMES as u32 - (last0 + 1)) / PER_MS;
    assert!(
        (1_900..=2_100).contains(&dropped_ms),
        "about 2.5 s less the 500 ms head start dropped, got {dropped_ms} ms"
    );
    assert_eq!(chain.latency_debt(), None, "nothing left to repay");

    // The next segment, fetched by the speaker itself, carries on exactly.
    let mut body = rig.attach(2);
    let seg2 = read_to_end(&mut body).await;
    let mut all = seg1[FADE_FRAMES * FRAME..].to_vec();
    all.extend_from_slice(segment_data(&seg2, &rig.layout));
    assert_contiguous(&all, "into the segment after");
}

/// With drift correction steering the speaker, a restart that added no more
/// than two seconds keeps every sample and records the latency owed, for
/// the controller to pay back.
#[tokio::test(start_paused = true)]
async fn a_steered_restart_keeps_every_sample_and_owes_the_pause() {
    let mut rig = Rig::new(384_000);
    rig.head_start_ms = 500;
    rig.drift_on = true;
    let (last0, seg1, chain) = restart_after(&rig, Duration::from_millis(2_000)).await;

    let (first, _) = assert_contiguous(&seg1, "exact rejoin");
    assert_eq!(first, last0 + 1);
    let debt = chain.latency_debt().expect("owed");
    assert!(
        (1_400..=1_600).contains(&debt.debt_ms),
        "about 2 s less the head start owed, got {} ms",
        debt.debt_ms
    );
}

/// Even when steered, a restart that added more than the controller could
/// repay within hours is trimmed.
#[tokio::test(start_paused = true)]
async fn a_steered_restart_owing_too_much_is_trimmed_after_all() {
    let mut rig = Rig::new(384_000);
    rig.head_start_ms = 500;
    rig.drift_on = true;
    let (last0, seg1, chain) = restart_after(&rig, Duration::from_millis(4_000)).await;
    let (first, _) = assert_contiguous(&seg1[FADE_FRAMES * FRAME..], "after the fade");
    assert!(first - FADE_FRAMES as u32 > last0 + 1 + 3_000 * PER_MS);
    assert_eq!(chain.latency_debt(), None);
}

/// A restart is readied only while the playout waits for exactly the
/// segment after the one its speaker took whole.
#[tokio::test(start_paused = true)]
async fn a_restart_is_readied_only_while_the_next_segment_is_awaited() {
    let rig = Rig::new(96_000);
    let mut body = rig.first();
    let chain = Arc::clone(body.playout());
    let _ = read_at_least(&mut body, 44 + 1_920).await;
    assert_eq!(chain.prepare_restart(1), None, "still serving segment 0");
    let _ = read_to_end(&mut body).await;
    drop(body);
    assert_eq!(chain.prepare_restart(2), None, "not the next segment");
    assert_eq!(chain.prepare_restart(0), None);
    assert!(chain.prepare_restart(1).is_some());
    chain.cancel_restart();

    // Once the speaker fetched the next segment itself, there is nothing to
    // restart.
    let mut next = rig.attach(1);
    let _ = read_at_least(&mut next, 44).await;
    assert!(!chain.awaiting_after(0));
    assert_eq!(chain.prepare_restart(1), None);
}

/// A playout tells its events in order: the segment nearing its end, its
/// end, and the fetch that continued it.
#[tokio::test(start_paused = true)]
async fn a_playout_tells_its_boundaries() {
    #[derive(Default)]
    struct Recorder(parking_lot::Mutex<Vec<PlayoutEvent>>);
    impl PlayoutEvents for Recorder {
        fn playout_event(&self, _: &Arc<PlayoutChain>, event: PlayoutEvent) {
            self.0.lock().push(event);
        }
    }
    let recorder = Arc::new(Recorder::default());
    let mut rig = Rig::new(576_000); // 3 s
    rig.events = Some(Arc::clone(&recorder) as Arc<dyn PlayoutEvents>);
    let mut body = rig.first();
    let _ = read_at_least(&mut body, 44 + 96_000).await;
    assert_eq!(
        *recorder.0.lock(),
        vec![PlayoutEvent::Started { url_segment: 0 }]
    );
    let _ = read_to_end(&mut body).await;
    drop(body);
    let mut next = rig.attach(1);
    let _ = read_at_least(&mut next, 44 + 1_920).await;
    drop(next);
    let events = recorder.0.lock().clone();
    assert_eq!(
        events[1],
        PlayoutEvent::HandoffNear {
            seg: 0,
            url_segment: 0
        }
    );
    assert!(matches!(
        events[2],
        PlayoutEvent::SegmentEnded {
            seg: 0,
            url_segment: 0,
            ..
        }
    ));
    assert_eq!(
        events[3],
        PlayoutEvent::Continued {
            seg: 1,
            url_segment: 1,
            kind: AttachKind::Continuation
        }
    );
    assert_eq!(
        events[4],
        PlayoutEvent::ClosedMid {
            seg: 1,
            url_segment: 1
        }
    );
    assert_eq!(events.len(), 5, "{events:?}");
}
