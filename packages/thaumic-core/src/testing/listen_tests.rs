//! The listen route, end to end against the fake household: players on this
//! machine hear a cast without being booked as a speaker, and never disturb
//! one.
//!
//! The PCM cases began as a reproduction against the live route: there,
//! readers on this machine share one playout, so a second plain fetch got the
//! WAV header and then nothing, and a ranged fetch retired the first reader's
//! playout. Here the same three fetches go to the listen route and every one
//! of them keeps hearing the cast.
//!
//! Limit: the fakes and the listeners all run on 127/8, which is this
//! machine, so a refusal under `strict_stream_access` cannot be provoked
//! here; `decide_listen_access` has its own unit tests.

use std::net::{IpAddr, Ipv4Addr};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use tokio::task::JoinHandle;

use crate::sonos::services::SonosService;
use crate::stream::{AudioCodec, StreamState};

use super::harness::{within, TestSystem};

/// The byte every pushed frame is filled with. The cadence's silence is
/// zeros and no WAV header byte is this, so counting it counts the cast's
/// audio and nothing else.
const AUDIO_BYTE: u8 = 0x11;

/// Where the listeners connect from: this machine, and no speaker.
const LISTENER_IP: IpAddr = IpAddr::V4(Ipv4Addr::LOCALHOST);

/// Pushes 20 ms frames of [`AUDIO_BYTE`] into `stream` in real time, as the
/// extension would, until the task is aborted.
fn feed(stream: Arc<StreamState>) -> JoinHandle<()> {
    tokio::spawn(async move {
        let frame = Bytes::from(vec![AUDIO_BYTE; stream.audio_format.frame_bytes(20)]);
        let mut tick = tokio::time::interval(Duration::from_millis(20));
        loop {
            tick.tick().await;
            stream.push_frame(frame.clone());
        }
    })
}

/// One open listen fetch: its response head, and a count of the audio bytes
/// read from its body so far, which a task drains for as long as it lasts.
struct Listening {
    status: u16,
    content_type: String,
    accept_ranges: Option<String>,
    content_range: Option<String>,
    audio: Arc<AtomicUsize>,
    drain: JoinHandle<()>,
}

impl Listening {
    /// Audio bytes received so far.
    fn heard(&self) -> usize {
        self.audio.load(Ordering::Relaxed)
    }

    /// Waits until this listener has heard `more` audio bytes beyond what it
    /// had heard on entry, failing the test after a few seconds.
    async fn hears_more(&self, more: usize, what: &str) {
        let target = self.heard() + more;
        let wait = async {
            while self.heard() < target {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        if tokio::time::timeout(Duration::from_secs(5), wait)
            .await
            .is_err()
        {
            panic!(
                "{what}: heard {} audio bytes, wanted {target}",
                self.heard()
            );
        }
    }

    /// Hangs up.
    fn hang_up(self) {
        self.drain.abort();
    }
}

/// Opens `url` from [`LISTENER_IP`], with `range` as its `Range` header,
/// and drains its body in the background, counting the bytes `is_audio`
/// accepts.
async fn listen(url: &str, range: Option<&str>, is_audio: fn(u8) -> bool) -> Listening {
    let client = reqwest::Client::builder()
        .local_address(LISTENER_IP)
        .build()
        .expect("listener client");
    let mut request = client.get(url);
    if let Some(range) = range {
        request = request.header(reqwest::header::RANGE, range);
    }
    let mut response = request.send().await.expect("listen fetch");
    let header = |name: reqwest::header::HeaderName| {
        response
            .headers()
            .get(name)
            .and_then(|v| v.to_str().ok())
            .map(str::to_string)
    };
    let status = response.status().as_u16();
    let content_type = header(reqwest::header::CONTENT_TYPE).unwrap_or_default();
    let accept_ranges = header(reqwest::header::ACCEPT_RANGES);
    let content_range = header(reqwest::header::CONTENT_RANGE);
    let audio = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&audio);
    let drain = tokio::spawn(async move {
        while let Ok(Some(chunk)) = response.chunk().await {
            let n = chunk.iter().filter(|b| is_audio(**b)).count();
            counter.fetch_add(n, Ordering::Relaxed);
        }
    });
    Listening {
        status,
        content_type,
        accept_ranges,
        content_range,
        audio,
        drain,
    }
}

/// A PCM byte that is the cast's audio rather than silence or header.
fn pcm_audio(byte: u8) -> bool {
    byte == AUDIO_BYTE
}

/// The listen URL of `stream_id`.
fn listen_url(sys: &TestSystem, stream_id: &str, file: &str) -> String {
    // The live URL is `.../stream/{id}/live`.
    let live = sys.stream_url(stream_id);
    let base = live.strip_suffix("/live").expect("a live URL");
    format!("{base}/{file}")
}

/// SOAP calls (not GENA traffic) any speaker received at or after `seq`.
fn soap_since(sys: &TestSystem, seq: usize) -> Vec<String> {
    sys.fake
        .calls_since(seq)
        .into_iter()
        .filter(|call| !call.is_gena())
        .map(|call| format!("{} {:?} {}", call.speaker_ip, call.service, call.action))
        .collect()
}

/// About a quarter of a second of 48 kHz 16-bit stereo.
const SOME_AUDIO: usize = 48_000;

/// Proves: with a PCM cast playing on a speaker, two plain listeners and a
/// ranged one on this machine all hear the cast at once, and keep hearing it
/// after the ranged one joins; the ranged one is answered 200 from the live
/// edge, not 206; the speaker keeps its one fetch, its playout and its epoch;
/// no listener gets an epoch or a playout of its own; and no speaker receives
/// any SOAP call.
#[tokio::test]
async fn listeners_on_this_machine_all_hear_a_pcm_cast_and_leave_the_speaker_alone() {
    within("pcm listeners", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen"])
            .codec(AudioCodec::Pcm)
            .build()
            .await;
        let kitchen = sys.ip("Kitchen");
        let kitchen_ip: IpAddr = kitchen.parse().expect("speaker address");
        let stream = sys.new_stream();
        let state = sys.coordinator().get_stream(&stream).expect("the stream");
        let feeder = feed(Arc::clone(&state));

        let results = sys.start(&stream, &["Kitchen"], false).await;
        assert!(results[0].success, "{results:?}");
        let speaker = sys.fake.speaker_named("Kitchen");
        let chain = state
            .playout
            .get(kitchen_ip)
            .expect("the speaker's playout")
            .id();
        let epoch = |state: &StreamState| state.timing.current_epoch_for(kitchen_ip).map(|e| e.id);
        let wait_for_epoch = async {
            while epoch(&state).is_none() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        };
        tokio::time::timeout(Duration::from_secs(5), wait_for_epoch)
            .await
            .expect("the speaker's epoch starts");
        let speaker_epoch = epoch(&state);
        let seq = sys.fake.next_seq();

        let first = listen(&listen_url(&sys, &stream, "listen.wav"), None, pcm_audio).await;
        let second = listen(&listen_url(&sys, &stream, "listen.wav"), None, pcm_audio).await;
        for listener in [&first, &second] {
            assert_eq!(listener.status, 200);
            assert_eq!(listener.content_type, "audio/wav");
            assert_eq!(listener.accept_ranges.as_deref(), Some("none"));
        }
        first.hears_more(SOME_AUDIO, "first listener").await;
        second
            .hears_more(SOME_AUDIO, "second listener, beside the first")
            .await;

        // What a player sends when it seeks or reconnects: on the live route
        // this retired the playout and silenced the first reader.
        let ranged = listen(
            &listen_url(&sys, &stream, "listen.wav"),
            Some("bytes=1000000-"),
            pcm_audio,
        )
        .await;
        assert_eq!(ranged.status, 200, "a range is served from the live edge");
        assert_eq!(ranged.content_range, None);
        ranged.hears_more(SOME_AUDIO, "ranged listener").await;
        first
            .hears_more(SOME_AUDIO, "first listener, after the range")
            .await;
        second
            .hears_more(SOME_AUDIO, "second listener, after the range")
            .await;

        assert_eq!(speaker.fetches().len(), 1, "the speaker fetched once");
        assert!(speaker.is_fetching(), "the speaker's connection is open");
        assert_eq!(
            state.playout.get(kitchen_ip).map(|c| c.id()),
            Some(chain),
            "the speaker's playout was not retired"
        );
        assert_eq!(state.playout.len(), 1, "no listener has a playout");
        assert!(state.playout.get(LISTENER_IP).is_none());
        assert_eq!(epoch(&state), speaker_epoch, "the speaker's epoch stands");
        assert!(
            state.timing.current_epoch_for(LISTENER_IP).is_none(),
            "no listener starts an epoch"
        );
        assert_eq!(
            state.unlisted_reader_count(),
            0,
            "this machine is not budgeted"
        );
        assert!(
            soap_since(&sys, seq).is_empty(),
            "{:?}",
            soap_since(&sys, seq)
        );

        // One listener going does not take another with it.
        first.hang_up();
        second
            .hears_more(SOME_AUDIO, "second listener, after the first left")
            .await;
        ranged.hang_up();
        second.hang_up();
        feeder.abort();
    })
    .await;
}

/// Proves: listeners already hearing a PCM cast change nothing about a
/// speaker starting on it: `SetAVTransportURI` then `Play`, one fetch of the
/// live URL, answered 200 and held open, and a playout of its own; and the
/// listeners keep hearing the cast through it.
#[tokio::test]
async fn a_speaker_starting_beside_listeners_starts_as_it_always_has() {
    within("speaker beside listeners", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen"])
            .codec(AudioCodec::Pcm)
            .build()
            .await;
        let kitchen = sys.ip("Kitchen");
        let kitchen_ip: IpAddr = kitchen.parse().expect("speaker address");
        let stream = sys.new_stream();
        let state = sys.coordinator().get_stream(&stream).expect("the stream");
        let feeder = feed(Arc::clone(&state));

        let first = listen(&listen_url(&sys, &stream, "listen"), None, pcm_audio).await;
        let second = listen(&listen_url(&sys, &stream, "listen.wav"), None, pcm_audio).await;
        first.hears_more(SOME_AUDIO, "first listener").await;
        second.hears_more(SOME_AUDIO, "second listener").await;
        assert!(sys.sessions().is_empty(), "a listener is no session");

        let results = sys.start(&stream, &["Kitchen"], false).await;
        assert!(results[0].success, "{results:?}");
        let actions: Vec<String> = sys
            .fake
            .calls_for(&kitchen)
            .into_iter()
            .filter(|call| call.service == SonosService::AVTransport && !call.is_gena())
            .map(|call| call.action)
            .collect();
        assert_eq!(actions, ["SetAVTransportURI", "Play"]);
        let speaker = sys.fake.speaker_named("Kitchen");
        let fetches = speaker.fetches();
        assert_eq!(fetches.len(), 1);
        assert_eq!(fetches[0].url, sys.speaker_uri(&stream));
        assert_eq!(fetches[0].status, 200);
        assert!(speaker.is_fetching());
        assert!(state.playout.get(kitchen_ip).is_some());
        assert_eq!(state.playout.len(), 1);

        first
            .hears_more(SOME_AUDIO, "first listener, after the start")
            .await;
        second
            .hears_more(SOME_AUDIO, "second listener, after the start")
            .await;
        first.hang_up();
        second.hang_up();
        feeder.abort();
    })
    .await;
}

/// Proves: an AAC cast is served on the listen route with the codec's own
/// type, beside a speaker playing it, and two listeners both hear it.
#[tokio::test]
async fn listeners_hear_an_aac_cast() {
    within("aac listeners", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let stream = sys.new_stream();
        let state = sys.coordinator().get_stream(&stream).expect("the stream");
        let feeder = feed(Arc::clone(&state));
        assert!(sys.start(&stream, &["Kitchen"], false).await[0].success);
        let seq = sys.fake.next_seq();

        let first = listen(&listen_url(&sys, &stream, "listen"), None, |_| true).await;
        let second = listen(
            &listen_url(&sys, &stream, "listen"),
            Some("bytes=5000-"),
            |_| true,
        )
        .await;
        for listener in [&first, &second] {
            assert_eq!(listener.status, 200);
            assert_eq!(listener.content_type, "audio/aac");
        }
        first.hears_more(SOME_AUDIO, "first AAC listener").await;
        second.hears_more(SOME_AUDIO, "second AAC listener").await;
        assert!(sys.fake.speaker_named("Kitchen").is_fetching());
        assert_eq!(sys.fake.speaker_named("Kitchen").fetches().len(), 1);
        assert!(state.timing.current_epoch_for(LISTENER_IP).is_none());
        assert!(
            soap_since(&sys, seq).is_empty(),
            "{:?}",
            soap_since(&sys, seq)
        );
        first.hang_up();
        second.hang_up();
        feeder.abort();
    })
    .await;
}

/// Proves: the listen route answers 404 for a stream that does not exist,
/// as the live route does.
#[tokio::test]
async fn an_unknown_stream_is_not_found_on_the_listen_route() {
    within("unknown listen", async {
        let sys = TestSystem::builder().build().await;
        let stream = sys.new_stream();
        let url = listen_url(&sys, &stream, "listen").replace(&stream, "no-such-stream");
        let status = reqwest::get(&url).await.expect("fetch").status().as_u16();
        assert_eq!(status, 404);
    })
    .await;
}
