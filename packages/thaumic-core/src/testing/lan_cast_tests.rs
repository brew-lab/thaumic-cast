//! Casts over port 1443 against the fake household: a PCM cast plays from a
//! cloud queue Thaumic serves, reads as UPnP would, stops cleanly, is ended
//! by a takeover, and survives a dropped socket.

use std::time::Duration;

use crate::events::{SonosEvent, SpeakerRemovalReason, StreamEvent};
use crate::sonos::types::TransportState;
use crate::sonos::Route;
use crate::stream::AudioCodec;

use super::harness::{both_routes, within, TestSystem};

/// Waits until `done` holds, looking every few milliseconds. The caller
/// bounds the wait with [`within`].
async fn until(done: impl Fn() -> bool) {
    while !done() {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// `(namespace, command)` of every Lan command the room at `ip` received.
fn lan_commands(sys: &TestSystem, ip: &str) -> Vec<(String, String)> {
    sys.fake
        .lan_calls()
        .into_iter()
        .filter(|c| c.speaker_ip == ip)
        .map(|c| (c.namespace, c.command))
        .collect()
}

async fn pcm_system(route: Route, rooms: &[&str]) -> TestSystem {
    TestSystem::builder()
        .speakers(rooms.iter().copied())
        .codec(AudioCodec::Pcm)
        .route(route)
        .build()
        .await
}

both_routes! {
/// Proves: a PCM cast starts on either route with the speaker fetching the
/// stream's own `live.wav` from its address, the services expect that URI,
/// and removing the stream stops the fetch and ends every session.
async fn a_pcm_cast_starts_and_stops_on_either_route(route) {
    within("cast", async {
        let sys = pcm_system(route, &["Kitchen"]).await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();

        let results = sys.start(&stream, &["Kitchen"], false).await;
        assert!(results[0].success, "{results:?}");

        let uri = sys.speaker_uri(&stream);
        let speaker = sys.fake.speaker_named("Kitchen");
        let fetches = speaker.fetches();
        assert_eq!(fetches.len(), 1, "{fetches:?}");
        assert_eq!(fetches[0].url, uri);
        assert_eq!(fetches[0].status, 200);
        assert!(speaker.is_fetching());
        assert_eq!(speaker.current_uri(), uri);
        assert_eq!(
            sys.coordinator().get_expected_stream(&kitchen).as_deref(),
            Some(uri.as_str())
        );

        sys.coordinator().remove_stream_async(&stream).await;
        until(|| !speaker.is_fetching()).await;
        assert_ne!(speaker.transport_state(), TransportState::Playing);
        assert!(sys.sessions().is_empty());
        assert!(sys
            .events
            .playback_stopped()
            .iter()
            .all(|(_, _, reason)| *reason != Some(SpeakerRemovalReason::SourceChanged)));
    })
    .await;
}
}

/// Proves: on port 1443 a cast creates a session on the room's group,
/// follows it, and loads a queue that the speaker reads from its own address
/// (context, then the window for the item) before it fetches the item; no
/// UPnP action is tried; the household's route is held while it plays; and
/// nobody but the speaker may read the queue.
#[tokio::test]
async fn on_port_1443_a_cast_plays_a_queue_only_its_speaker_reads() {
    within("lan cast", async {
        let sys = pcm_system(Route::Lan, &["Kitchen"]).await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys.start(&stream, &["Kitchen"], false).await;
        assert!(results[0].success, "{results:?}");

        let commands = lan_commands(&sys, &kitchen);
        let at = |namespace: &str, command: &str| {
            commands
                .iter()
                .position(|(n, c)| n == namespace && c == command)
                .unwrap_or_else(|| panic!("no {namespace} {command}: {commands:?}"))
        };
        assert!(
            at("playbackSession:1", "createSession") < at("playbackSession:1", "loadCloudQueue")
        );
        assert!(at("playback:1", "subscribe") < at("playbackSession:1", "loadCloudQueue"));
        assert!(at("playbackSession:1", "subscribe") < at("playbackSession:1", "loadCloudQueue"));
        assert!(sys.fake.lan_session("Kitchen").is_some());
        assert!(
            sys.fake.calls_since(seq).is_empty(),
            "{}",
            sys.fake.format_log()
        );

        let reads = sys.fake.queue_reads();
        assert_eq!(reads.len(), 2, "{reads:?}");
        assert!(reads
            .iter()
            .all(|r| r.speaker_ip == kitchen && r.status == 200));
        assert!(reads[0].url.ends_with("/v2.3/context"), "{reads:?}");
        assert!(
            reads[1]
                .url
                .contains("/v2.3/itemWindow?reason=load&itemId="),
            "{reads:?}"
        );
        assert!(
            reads[0].url.contains(&format!("/cq/{stream}/")),
            "{reads:?}"
        );

        assert!(sys.services.route.is_held());

        // This machine is no speaker of the stream: its queue is not found.
        let foreign = reqwest::get(&reads[1].url)
            .await
            .expect("ask for the queue");
        assert_eq!(foreign.status(), 404);
    })
    .await;
}

/// Proves: on port 1443 the cast's state and position read as UPnP gives
/// them (the segment's URL and whole seconds), its state reaches the
/// services as a GENA transport event would, and a resume moments after the
/// start loads nothing again.
#[tokio::test]
async fn on_port_1443_a_cast_reads_as_upnp_would() {
    within("lan status", async {
        let sys = pcm_system(Route::Lan, &["Kitchen"]).await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();
        assert!(sys.start(&stream, &["Kitchen"], false).await[0].success);
        let uri = sys.speaker_uri(&stream);

        let sonos = sys.services.sonos.as_ref();
        assert_eq!(
            sonos.get_transport_info(&kitchen).await.unwrap(),
            TransportState::Playing
        );
        let position = sonos.get_position_info(&kitchen).await.unwrap();
        assert_eq!(position.track_uri, uri);
        assert_eq!(position.rel_time_ms, 5_000);

        sys.events
            .wait_for_sonos(|e| {
                matches!(e, SonosEvent::TransportState { speaker_ip, state: TransportState::Playing,
                    current_uri: Some(current), .. } if *speaker_ip == kitchen && *current == uri)
            })
            .await;
        assert_eq!(
            sys.services
                .sonos_state
                .transport_states
                .get(&kitchen)
                .map(|s| *s),
            Some(TransportState::Playing)
        );

        let loads = || {
            lan_commands(&sys, &kitchen)
                .iter()
                .filter(|(_, c)| c == "loadCloudQueue")
                .count()
        };
        assert_eq!(loads(), 1);
        sonos.play(&kitchen).await.expect("resume");
        assert_eq!(loads(), 1);
    })
    .await;
}

/// Proves: on port 1443 removing the stream ends the queue, pauses the group
/// and leaves the session, the speaker's own eviction notice for that leave
/// is not taken for a takeover, and the route is no longer held.
#[tokio::test]
async fn on_port_1443_a_stop_pauses_and_leaves_the_session() {
    within("lan stop", async {
        let sys = pcm_system(Route::Lan, &["Kitchen"]).await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();
        assert!(sys.start(&stream, &["Kitchen"], false).await[0].success);

        sys.coordinator().remove_stream_async(&stream).await;

        let commands = lan_commands(&sys, &kitchen);
        let pause = commands
            .iter()
            .position(|(n, c)| n == "playback:1" && c == "pause");
        let leave = commands
            .iter()
            .position(|(n, c)| n == "playbackSession:1" && c == "leaveSession");
        assert!(pause.is_some() && pause < leave, "{commands:?}");
        assert_eq!(sys.fake.lan_session("Kitchen"), None);
        assert!(!sys.services.route.is_held());

        // The eviction our leave causes arrives, and changes nothing.
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(!sys.events.stream_events().iter().any(|e| matches!(
            e,
            StreamEvent::PlaybackStopped {
                reason: Some(SpeakerRemovalReason::SourceChanged),
                ..
            }
        )));
    })
    .await;
}

/// Proves: on port 1443 another app taking the group over ends the cast as
/// a source change, and nothing pauses the group after it.
#[tokio::test]
async fn on_port_1443_a_takeover_ends_the_cast_as_a_source_change() {
    within("lan takeover", async {
        let sys = pcm_system(Route::Lan, &["Kitchen"]).await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();
        assert!(sys.start(&stream, &["Kitchen"], false).await[0].success);

        sys.fake.take_over_on_lan("Kitchen");
        sys.events
            .wait_for_stream(|e| {
                matches!(e, StreamEvent::PlaybackStopped { speaker_ip,
                    reason: Some(SpeakerRemovalReason::SourceChanged), .. } if *speaker_ip == kitchen)
            })
            .await;
        until(|| !sys.services.route.is_held()).await;
        assert!(sys.session(&stream, "Kitchen").is_none());
        assert!(!lan_commands(&sys, &kitchen)
            .iter()
            .any(|(_, c)| c == "pause" || c == "leaveSession"));
    })
    .await;
}

/// Proves: on port 1443 a socket the speaker drops is opened again and the
/// cast's session joined again, and the cast carries on.
#[tokio::test]
async fn on_port_1443_a_dropped_socket_rejoins_the_cast() {
    within("lan drop", async {
        let sys = pcm_system(Route::Lan, &["Kitchen"]).await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();
        assert!(sys.start(&stream, &["Kitchen"], false).await[0].success);
        let session = sys.fake.lan_session("Kitchen");

        sys.fake.drop_lan_sockets("Kitchen");
        until(|| {
            lan_commands(&sys, &kitchen)
                .iter()
                .any(|(_, c)| c == "joinSession")
        })
        .await;
        // Followed again on the new socket.
        until(|| {
            lan_commands(&sys, &kitchen)
                .iter()
                .filter(|(n, c)| n == "playbackSession:1" && c == "subscribe")
                .count()
                == 2
        })
        .await;
        assert_eq!(sys.fake.lan_session("Kitchen"), session);
        assert!(sys.session(&stream, "Kitchen").is_some());
        assert!(sys.services.route.is_held());
        assert!(sys.fake.speaker_named("Kitchen").is_fetching());
    })
    .await;
}

both_routes! {
/// Proves: on either route a loud room is turned down to the start limit on
/// its own level before the cast is loaded on it.
async fn a_loud_room_is_turned_down_before_the_cast_plays(route) {
    within("start level", async {
        let sys = pcm_system(route, &["Kitchen"]).await;
        let kitchen = sys.ip("Kitchen");
        sys.fake.speaker_named("Kitchen").set_volume(72);
        let seq = sys.fake.next_seq();
        let stream = sys.new_stream();
        let limit = crate::services::start_volume::StartVolumeRequest {
            limit: Some(30),
            rooms: std::collections::HashMap::new(),
        };

        let results = sys
            .start_with_volume(&stream, &["Kitchen"], false, &limit)
            .await;
        assert!(results[0].success, "{results:?}");
        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 30);

        if route == Route::Lan {
            let commands = lan_commands(&sys, &kitchen);
            let set = commands
                .iter()
                .position(|(n, c)| n == "playerVolume:1" && c == "setVolume");
            let load = commands.iter().position(|(_, c)| c == "loadCloudQueue");
            assert!(set.is_some() && set < load, "{commands:?}");
        } else {
            let calls = sys.fake.calls_since(seq);
            let first = |action: &str| calls.iter().position(|c| c.is(&kitchen, action));
            assert!(first("SetVolume").is_some() && first("SetVolume") < first("Play"));
        }
    })
    .await;
}
}

/// The household's grouping, as room names.
fn grouping(sys: &TestSystem) -> Vec<Vec<String>> {
    sys.fake.grouping()
}

fn rooms(groups: &[&[&str]]) -> Vec<Vec<String>> {
    groups
        .iter()
        .map(|g| g.iter().map(|n| (*n).to_string()).collect())
        .collect()
}

both_routes! {
/// Proves: on either route a cast to two rooms plays them as one Sonos
/// group, only its coordinator fetching, and the rooms are put back as they
/// were when it stops.
async fn a_cast_to_two_rooms_plays_as_one_group_and_puts_them_back(route) {
    within("rooms", async {
        let sys = pcm_system(route, &["Kitchen", "Patio"]).await;
        let stream = sys.new_stream();

        let results = sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(grouping(&sys), rooms(&[&["Kitchen", "Patio"]]));
        assert!(sys.fake.speaker_named("Kitchen").is_fetching());
        assert!(!sys.fake.speaker_named("Patio").is_fetching());
        assert!(sys.session(&stream, "Patio").is_some());

        sys.coordinator().remove_stream_async(&stream).await;
        assert_eq!(grouping(&sys), rooms(&[&["Kitchen"], &["Patio"]]));
        assert!(sys.sessions().is_empty());
    })
    .await;
}
}

both_routes! {
/// Proves: on either route a room the household will not let join is left
/// out of the cast, the rest plays, and nothing is left grouped that was not.
/// On port 1443 the refusal is never said: only reading the groups back
/// shows the join did not happen.
async fn a_room_that_will_not_join_is_left_out_and_the_rest_plays(route) {
    within("refused join", async {
        let sys = pcm_system(route, &["Kitchen", "Patio"]).await;
        sys.fake.refuse_join("Patio", "Kitchen");
        let stream = sys.new_stream();

        let results = sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;
        assert_eq!(
            sys.outcome(&results),
            [("Kitchen".to_string(), true), ("Patio".to_string(), false)]
        );
        assert!(sys.fake.speaker_named("Kitchen").is_fetching());
        assert_eq!(grouping(&sys), rooms(&[&["Kitchen"], &["Patio"]]));
        assert!(sys.session(&stream, "Patio").is_none());
    })
    .await;
}
}

/// Proves: on port 1443 a coordinator the household takes out of its group
/// mid-cast ends the cast in every room as a takeover, and the session the
/// promoted room inherited is left there, so nothing plays out of view.
#[tokio::test]
async fn on_port_1443_a_coordinator_moved_by_the_household_ends_the_cast() {
    within("coordinator moved", async {
        let sys = pcm_system(Route::Lan, &["Kitchen", "Patio"]).await;
        let (kitchen, patio) = (sys.ip("Kitchen"), sys.ip("Patio"));
        let stream = sys.new_stream();
        let results = sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");

        sys.fake.coordinator_leaves_in_app("Kitchen");
        for ip in [&kitchen, &patio] {
            sys.events
                .wait_for_stream(|e| {
                    matches!(e, StreamEvent::PlaybackStopped { speaker_ip,
                        reason: Some(SpeakerRemovalReason::SourceChanged), .. } if speaker_ip == ip)
                })
                .await;
        }
        until(|| sys.fake.lan_session("Patio").is_none()).await;
        assert!(lan_commands(&sys, &patio)
            .iter()
            .any(|(n, c)| n == "playbackSession:1" && c == "leaveSession"));
        until(|| !sys.services.route.is_held()).await;
    })
    .await;
}

both_routes! {
/// Proves: on either route an AAC cast has the speaker fetch the stream's
/// own `live` URL from its address, the way an `x-rincon-mp3radio` cast is
/// fetched, and removing the stream stops it.
async fn an_aac_cast_is_fetched_as_a_radio_stream_on_either_route(route) {
    within("aac", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen"])
            .codec(AudioCodec::Aac)
            .route(route)
            .build()
            .await;
        let stream = sys.new_stream();

        let results = sys.start(&stream, &["Kitchen"], false).await;
        assert!(results[0].success, "{results:?}");
        let speaker = sys.fake.speaker_named("Kitchen");
        let fetches = speaker.fetches();
        assert_eq!(fetches.len(), 1, "{fetches:?}");
        assert_eq!(fetches[0].url, sys.stream_url(&stream));
        assert_eq!(fetches[0].status, 200);
        assert!(speaker.is_fetching());

        sys.coordinator().remove_stream_async(&stream).await;
        until(|| !speaker.is_fetching()).await;
        assert!(sys.sessions().is_empty());
    })
    .await;
}
}

/// Proves: on port 1443 an AAC cast is loaded as a stream URL, not a queue,
/// and reads as UPnP gives it: the radio URI, whatever item id the speaker
/// made up for it.
#[tokio::test]
async fn on_port_1443_an_aac_cast_is_a_stream_url_that_reads_as_its_radio_uri() {
    within("lan aac", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen"])
            .codec(AudioCodec::Aac)
            .route(Route::Lan)
            .build()
            .await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();
        assert!(sys.start(&stream, &["Kitchen"], false).await[0].success);

        let commands = lan_commands(&sys, &kitchen);
        assert!(
            commands.iter().any(|(_, c)| c == "loadStreamUrl"),
            "{commands:?}"
        );
        assert!(
            !commands.iter().any(|(_, c)| c == "loadCloudQueue"),
            "{commands:?}"
        );
        assert!(sys.fake.queue_reads().is_empty());

        let position = sys
            .services
            .sonos
            .get_position_info(&kitchen)
            .await
            .unwrap();
        assert_eq!(position.track_uri, sys.speaker_uri(&stream));
        assert_eq!(
            sys.coordinator().get_expected_stream(&kitchen).as_deref(),
            Some(sys.speaker_uri(&stream).as_str())
        );
    })
    .await;
}

/// Proves: on port 1443 a FLAC cast is refused with the word clients turn
/// into "cast PCM or AAC, or switch UPnP on", before anything is created on
/// the speaker, and the route is not held.
#[tokio::test]
async fn on_port_1443_a_flac_cast_is_refused_with_its_reason() {
    within("lan flac", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen"])
            .codec(AudioCodec::Flac)
            .route(Route::Lan)
            .build()
            .await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys.start(&stream, &["Kitchen"], false).await;
        assert!(!results[0].success);
        assert_eq!(
            results[0].error.as_deref(),
            Some(crate::protocol_constants::FLAC_NEEDS_UPNP)
        );
        assert!(!lan_commands(&sys, &kitchen)
            .iter()
            .any(|(_, c)| c == "createSession"));
        assert!(sys.fake.calls_since(seq).is_empty());
        assert!(!sys.services.route.is_held());
        assert!(!sys.fake.speaker_named("Kitchen").is_fetching());
    })
    .await;
}
