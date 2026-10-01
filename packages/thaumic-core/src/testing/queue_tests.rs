//! The speaker surface today's core relies on, exercised through the real
//! client: every call the Sonos traits make is answered, and an item queued
//! with `SetNextAVTransportURI` is taken up when the stream being played
//! ends.
//!
//! Real clock, like the other end-to-end tests. The segment hand-over is
//! driven against a small stand-in stream server rather than the real one: a
//! real PCM segment is at least a megabyte long and core queues the next one
//! only ten seconds into it, which is far too slow for a unit run. What is
//! proved here is the fake's side of that exchange.

use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::routing::get;
use axum::Router;
use bytes::Bytes;
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::events::SonosEvent;
use crate::sonos::services::SonosService;
use crate::sonos::traits::NextItem;
use crate::sonos::types::TransportState;
use crate::stream::{AudioCodec, AudioFormat};

use super::harness::{within, TestSystem};

/// Waits until `done` holds, looking every few milliseconds. The caller
/// bounds the wait with [`within`].
async fn until(done: impl Fn() -> bool) {
    while !done() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// Serves two streams on a loopback port: `/first.wav`, whose body ends when
/// `end_first` is notified, and `/second.wav`, whose body never ends.
/// Returns the base URL.
async fn serve_two_segments(end_first: Arc<Notify>) -> String {
    let first = move || {
        let end = Arc::clone(&end_first);
        async move {
            Body::from_stream(async_stream::stream! {
                yield Ok::<_, std::io::Error>(Bytes::from_static(b"RIFF"));
                end.notified().await;
            })
        }
    };
    let second = || async {
        Body::from_stream(async_stream::stream! {
            yield Ok::<_, std::io::Error>(Bytes::from_static(b"RIFF"));
            std::future::pending::<()>().await;
        })
    };
    let router = Router::new()
        .route("/first.wav", get(first))
        .route("/second.wav", get(second));
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind the segment server");
    let port = listener
        .local_addr()
        .expect("segment server address")
        .port();
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("segment server");
    });
    format!("http://127.0.0.1:{port}")
}

/// Proves: every method of the Sonos playback, topology and volume traits,
/// called through the client the services use, is answered by the fake
/// household without a fault, and each arrives as the SOAP action hardware
/// would see.
#[tokio::test]
async fn every_call_of_the_sonos_traits_is_answered() {
    within("every trait call", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .build()
            .await;
        let kitchen = sys.ip("Kitchen");
        let office = sys.ip("Office");
        let kitchen_uuid = sys.uuid("Kitchen");
        let sonos = &sys.services.sonos;
        let format = AudioFormat::default();
        let artwork = sys.artwork_url();
        let stream = sys.new_stream();
        let url = sys.stream_url(&stream);
        let from = sys.fake.next_seq();

        sonos
            .play_uri(&kitchen, &url, AudioCodec::Aac, &format, None, &artwork)
            .await
            .expect("play_uri");
        let next = NextItem {
            uri: &url,
            codec: AudioCodec::Aac,
            audio_format: &format,
            metadata: None,
            artwork_url: &artwork,
            declared_data_bytes: None,
        };
        sonos
            .set_next_uri(&kitchen, &next)
            .await
            .expect("set_next_uri");
        sonos.play(&kitchen).await.expect("play");
        assert_eq!(
            sonos
                .get_transport_info(&kitchen)
                .await
                .expect("get_transport_info"),
            TransportState::Playing
        );
        let position = sonos
            .get_position_info(&kitchen)
            .await
            .expect("get_position_info");
        assert_eq!(position.track_uri, sys.speaker_uri(&stream));

        sonos
            .join_group(&office, &kitchen_uuid)
            .await
            .expect("join_group");
        let snapshot = sonos
            .get_zone_group_state(&kitchen)
            .await
            .expect("get_zone_group_state");
        assert_eq!(snapshot.groups.len(), 1, "{:?}", snapshot.groups);
        assert_eq!(snapshot.groups[0].members.len(), 2);
        sonos.leave_group(&office).await.expect("leave_group");

        sonos
            .set_group_volume(&kitchen, 40)
            .await
            .expect("set_group_volume");
        assert_eq!(sonos.get_group_volume(&kitchen).await.expect("volume"), 40);
        sonos
            .set_group_mute(&kitchen, true)
            .await
            .expect("set_group_mute");
        assert!(sonos.get_group_mute(&kitchen).await.expect("group mute"));
        sonos
            .set_speaker_volume(&kitchen, 30)
            .await
            .expect("set_speaker_volume");
        assert_eq!(
            sonos.get_speaker_volume(&kitchen).await.expect("volume"),
            30
        );
        sonos
            .set_speaker_mute(&kitchen, true)
            .await
            .expect("set_speaker_mute");
        assert!(sonos.get_speaker_mute(&kitchen).await.expect("mute"));

        sonos.stop(&kitchen).await.expect("stop");
        sonos
            .switch_to_queue(&kitchen, &kitchen_uuid)
            .await
            .expect("switch_to_queue");

        let mut actions: Vec<String> = sys
            .fake
            .calls_since(from)
            .into_iter()
            .filter(|call| !call.is_gena())
            .map(|call| call.action)
            .collect();
        actions.sort();
        actions.dedup();
        assert_eq!(
            actions,
            [
                "BecomeCoordinatorOfStandaloneGroup",
                "GetGroupMute",
                "GetGroupVolume",
                "GetMute",
                "GetPositionInfo",
                "GetTransportInfo",
                "GetVolume",
                "GetZoneGroupState",
                "Play",
                "SetAVTransportURI",
                "SetGroupMute",
                "SetGroupVolume",
                "SetMute",
                "SetNextAVTransportURI",
                "SetVolume",
                "Stop",
            ]
        );
    })
    .await;
}

/// Proves: `set_next_uri` reaches the speaker as `SetNextAVTransportURI`
/// carrying the next segment's URI and DIDL metadata and leaves what plays
/// alone; the AVTransport NOTIFY then names the queued item, which the real
/// parser hands on as `next_uri`; when the body being played ends, the
/// speaker moves to the queued item, fetches it from its own address and
/// keeps playing with nothing queued; and a `SetAVTransportURI` empties the
/// queue.
#[tokio::test]
async fn a_queued_next_item_is_taken_up_when_the_current_stream_ends() {
    within("queued next item", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let kitchen = sys.ip("Kitchen");
        let speaker = Arc::clone(sys.fake.speaker_named("Kitchen"));
        let sonos = &sys.services.sonos;
        let format = AudioFormat::default();
        let artwork = sys.artwork_url();

        let end_first = Arc::new(Notify::new());
        let base = serve_two_segments(Arc::clone(&end_first)).await;
        let first = format!("{base}/first");
        let second = format!("{base}/second");

        sonos
            .play_uri(&kitchen, &first, AudioCodec::Pcm, &format, None, &artwork)
            .await
            .expect("play the first segment");
        let from = sys.fake.next_seq();
        let next = NextItem {
            uri: &second,
            codec: AudioCodec::Pcm,
            audio_format: &format,
            metadata: None,
            artwork_url: &artwork,
            declared_data_bytes: Some(1 << 20),
        };
        sonos
            .set_next_uri(&kitchen, &next)
            .await
            .expect("queue the second segment");

        let queued = sys
            .fake
            .calls_since(from)
            .into_iter()
            .find(|call| call.is(&kitchen, "SetNextAVTransportURI"))
            .expect("SetNextAVTransportURI is logged");
        assert_eq!(queued.service, SonosService::AVTransport);
        assert_eq!(queued.arg("NextURI"), Some(format!("{second}.wav").as_str()));
        assert!(
            queued
                .arg("NextURIMetaData")
                .is_some_and(|didl| didl.contains("DIDL-Lite")),
            "{queued:?}"
        );
        assert_eq!(speaker.current_uri(), format!("{first}.wav"));
        assert_eq!(speaker.next_uri(), format!("{second}.wav"));
        assert_eq!(speaker.fetches().len(), 1, "queueing fetches nothing");

        assert_eq!(
            sys.fake
                .notify_av_transport(&kitchen, TransportState::Playing, &speaker.current_uri())
                .await,
            200
        );
        let event = sys
            .events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::TransportState { speaker_ip, .. } if *speaker_ip == kitchen)
            })
            .await;
        let SonosEvent::TransportState { next_uri, .. } = event else {
            unreachable!("matched above");
        };
        assert_eq!(next_uri, Some(format!("{second}.wav")));

        end_first.notify_one();
        until(|| speaker.fetches().len() == 2).await;

        let fetches = speaker.fetches();
        assert_eq!(fetches[1].url, format!("{second}.wav"));
        assert_eq!(fetches[1].status, 200);
        assert_eq!(fetches[1].local_ip.to_string(), kitchen);
        assert_eq!(speaker.current_uri(), format!("{second}.wav"));
        assert_eq!(speaker.next_uri(), "", "the queue is used up");
        assert_eq!(speaker.transport_state(), TransportState::Playing);
        assert!(speaker.is_fetching());

        sonos
            .set_next_uri(&kitchen, &next)
            .await
            .expect("queue again");
        assert_eq!(speaker.next_uri(), format!("{second}.wav"));
        sonos
            .switch_to_queue(&kitchen, &sys.uuid("Kitchen"))
            .await
            .expect("switch to the queue");
        assert_eq!(speaker.next_uri(), "", "a new URI empties the queue");
    })
    .await;
}
