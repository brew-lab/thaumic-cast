//! Continuation over port 1443 against the fake household: the next PCM
//! segment is listed in the queue behind the current one, so the speaker
//! moves on to it by itself with no gap, and a next segment it cannot play
//! reads as the current one stopped, for the restart path.
//!
//! As in `queue_tests`, the segments are served by a small stand-in server
//! whose first body ends when the test says so: a real segment is at least a
//! megabyte. The stand-in also serves the real queues, by asking the
//! services' own [`CloudQueues`].

use std::collections::HashMap;
use std::net::Ipv4Addr;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Body;
use axum::extract::{Path, Query};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use axum::routing::get;
use axum::{Json, Router};
use bytes::Bytes;
use tokio::net::TcpListener;
use tokio::sync::Notify;

use crate::events::SonosEvent;
use crate::sonos::lan::queue::{CloudQueues, QueueAnswer};
use crate::sonos::traits::NextItem;
use crate::sonos::types::TransportState;
use crate::sonos::Route;
use crate::stream::{AudioCodec, AudioFormat};

use super::harness::{within, TestSystem};

/// Waits until `done` holds, looking every few milliseconds. The caller
/// bounds the wait with [`within`].
async fn until(done: impl Fn() -> bool) {
    while !done() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// A body that sends a WAV-ish start, then ends when `end` is notified, or
/// never.
fn segment_body(end: Option<Arc<Notify>>) -> Body {
    Body::from_stream(async_stream::stream! {
        yield Ok::<_, std::io::Error>(Bytes::from_static(b"RIFF"));
        match end {
            Some(end) => end.notified().await,
            None => std::future::pending::<()>().await,
        }
    })
}

/// Serves stream `s1`: `live.wav` and `live/1.wav` end when their notify
/// fires, `live/2.wav` never ends, and `live/1.wav` answers `second_status`
/// instead when that is not 200. Serves the queues in `queues` under `/cq`.
/// Returns the stream's base URL.
async fn serve_segments(
    queues: Arc<CloudQueues>,
    end: [Arc<Notify>; 2],
    second_status: StatusCode,
) -> String {
    let [end0, end1] = end;
    let first = move || {
        let end = Arc::clone(&end0);
        async move { segment_body(Some(end)) }
    };
    let second = move || {
        let end = Arc::clone(&end1);
        async move {
            if second_status == StatusCode::OK {
                segment_body(Some(end)).into_response()
            } else {
                second_status.into_response()
            }
        }
    };
    let third = || async { segment_body(None) };
    let queue = move |Path((stream, gen, endpoint)): Path<(String, String, String)>,
                      Query(query): Query<HashMap<String, String>>| {
        let queues = Arc::clone(&queues);
        async move {
            match queues.answer(&stream, &gen, "GET", &endpoint, &query) {
                QueueAnswer::Json(body) => Json(body).into_response(),
                QueueAnswer::NoContent => StatusCode::NO_CONTENT.into_response(),
                QueueAnswer::NotFound => StatusCode::NOT_FOUND.into_response(),
            }
        }
    };
    let router: Router = Router::new()
        .route("/stream/s1/live.wav", get(first))
        .route("/stream/s1/live/1.wav", get(second))
        .route("/stream/s1/live/2.wav", get(third))
        .route("/cq/{stream}/{gen}/v2.3/{endpoint}", get(queue));
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .expect("bind the segment server");
    let port = listener.local_addr().expect("server address").port();
    tokio::spawn(async move {
        axum::serve(listener, router).await.expect("segment server");
    });
    format!("http://127.0.0.1:{port}/stream/s1/live")
}

/// Casts segment 0 of the stand-in stream on Kitchen over port 1443, and
/// returns the system, Kitchen's address and the stream's base URL.
async fn cast_segments(
    second_status: StatusCode,
) -> (TestSystem, String, String, [Arc<Notify>; 2]) {
    let sys = TestSystem::builder()
        .speakers(["Kitchen"])
        .route(Route::Lan)
        .build()
        .await;
    let end = [Arc::new(Notify::new()), Arc::new(Notify::new())];
    let base = serve_segments(
        Arc::clone(&sys.services.cloud_queues),
        end.clone(),
        second_status,
    )
    .await;
    let kitchen = sys.ip("Kitchen");
    sys.services
        .sonos
        .play_uri(
            &kitchen,
            &base,
            AudioCodec::Pcm,
            &AudioFormat::default(),
            None,
            "",
        )
        .await
        .expect("cast segment 0");
    (sys, kitchen, base, end)
}

/// Proves: on port 1443 the next segment is listed from the load, so queuing
/// it sends nothing; when the current body ends the speaker fetches and
/// plays it by itself, and it reads, and is reported, as the current
/// segment; and when that one ends too, the queue asked again lists the one
/// after it.
#[tokio::test]
async fn on_port_1443_each_next_segment_plays_with_no_gap_from_the_queue() {
    within("lan continuation", async {
        let (sys, kitchen, base, end) = cast_segments(StatusCode::OK).await;
        let speaker = sys.fake.speaker_named("Kitchen");
        assert_eq!(speaker.fetches().len(), 1);

        let sent = sys.fake.lan_calls().len();
        let next = format!("{base}/1");
        sys.services
            .sonos
            .set_next_uri(
                &kitchen,
                &NextItem {
                    uri: &next,
                    codec: AudioCodec::Pcm,
                    audio_format: &AudioFormat::default(),
                    metadata: None,
                    artwork_url: "",
                    declared_data_bytes: None,
                },
            )
            .await
            .expect("the next segment is already listed");
        assert_eq!(sys.fake.lan_calls().len(), sent);

        end[0].notify_one();
        until(|| speaker.fetches().len() == 2).await;
        let second = format!("{base}/1.wav");
        assert_eq!(speaker.fetches()[1].url, second);
        assert_eq!(speaker.fetches()[1].status, 200);
        assert_eq!(speaker.transport_state(), TransportState::Playing);
        assert!(!sys
            .fake
            .queue_reads()
            .iter()
            .any(|r| r.url.contains("reason=queueCompleted")));

        let sonos = sys.services.sonos.as_ref();
        assert_eq!(
            sonos.get_position_info(&kitchen).await.unwrap().track_uri,
            second
        );
        assert_eq!(
            sonos.get_transport_info(&kitchen).await.unwrap(),
            TransportState::Playing
        );
        sys.events
            .wait_for_sonos(|e| {
                matches!(e, SonosEvent::TransportState { speaker_ip, state: TransportState::Playing,
                    current_uri: Some(uri), .. } if *speaker_ip == kitchen && *uri == second)
            })
            .await;

        end[1].notify_one();
        until(|| speaker.fetches().len() == 3).await;
        assert_eq!(speaker.fetches()[2].url, format!("{base}/2.wav"));
        assert!(sys
            .fake
            .queue_reads()
            .iter()
            .any(|r| r.url.contains("reason=queueCompleted")));
        assert_eq!(speaker.transport_state(), TransportState::Playing);
    })
    .await;
}

/// Proves: on port 1443 a next segment the speaker cannot fetch leaves it
/// PAUSED on that segment, never played, which reads as STOPPED on the
/// segment before: what the restart path needs to load the next one.
#[tokio::test]
async fn on_port_1443_a_next_segment_that_cannot_play_reads_as_the_last_one_stopped() {
    within("lan continuation failure", async {
        let (sys, kitchen, base, end) = cast_segments(StatusCode::SERVICE_UNAVAILABLE).await;
        let speaker = sys.fake.speaker_named("Kitchen");

        end[0].notify_one();
        until(|| speaker.transport_state() == TransportState::Paused).await;
        assert_eq!(speaker.fetches()[1].status, 503);

        let sonos = sys.services.sonos.as_ref();
        assert_eq!(
            sonos.get_transport_info(&kitchen).await.unwrap(),
            TransportState::Stopped
        );
        assert_eq!(
            sonos.get_position_info(&kitchen).await.unwrap().track_uri,
            format!("{base}.wav")
        );
    })
    .await;
}
