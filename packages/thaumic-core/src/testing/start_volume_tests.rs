//! The start level, end to end against the fake household: what is read and
//! set before a cast plays, and in what order.

use std::collections::HashMap;

use crate::services::start_volume::StartVolumeRequest;
use crate::sonos::services::SonosService;

use super::fake_sonos::{Call, Failure};
use super::harness::{within, TestSystem};

fn limit(level: u8) -> StartVolumeRequest {
    StartVolumeRequest {
        limit: Some(level),
        rooms: HashMap::new(),
    }
}

fn first(calls: &[Call], ip: &str, action: &str) -> Option<usize> {
    calls
        .iter()
        .find(|call| call.is(ip, action))
        .map(|call| call.seq)
}

fn set_volumes(calls: &[Call]) -> Vec<(String, String)> {
    calls
        .iter()
        .filter(|call| call.action == "SetVolume")
        .map(|call| {
            (
                call.speaker_name.clone(),
                call.arg("DesiredVolume").unwrap_or_default().to_string(),
            )
        })
        .collect()
}

/// Joins `member` to `coordinator`'s Sonos group, as the user would in the
/// Sonos app, and refreshes the topology so the services see it.
async fn group(sys: &TestSystem, coordinator: &str, member: &str) {
    sys.services
        .sonos
        .join_group(&sys.ip(member), &sys.uuid(coordinator))
        .await
        .expect("join_group");
    sys.refresh_topology().await;
}

/// Proves: a room above the limit is turned down to it, and the level is set
/// before the speaker is given the stream or told to play.
#[tokio::test]
async fn a_loud_room_is_turned_down_before_it_plays() {
    within("loud room", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let kitchen = sys.ip("Kitchen");
        sys.fake.speaker_named("Kitchen").set_volume(72);
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys
            .start_with_volume(&stream, &["Kitchen"], false, &limit(30))
            .await;
        assert!(results[0].success, "{results:?}");

        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 30);
        let calls = sys.fake.calls_since(seq);
        let set = first(&calls, &kitchen, "SetVolume").expect("SetVolume");
        let uri = first(&calls, &kitchen, "SetAVTransportURI").expect("SetAVTransportURI");
        let play = first(&calls, &kitchen, "Play").expect("Play");
        assert!(set < uri && set < play, "{}", sys.fake.format_log());
    })
    .await;
}

/// Proves: a room at or under the limit is never turned up.
#[tokio::test]
async fn a_quiet_room_is_left_alone() {
    within("quiet room", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        sys.fake.speaker_named("Kitchen").set_volume(10);
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        sys.start_with_volume(&stream, &["Kitchen"], false, &limit(30))
            .await;

        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 10);
        assert_eq!(set_volumes(&sys.fake.calls_since(seq)), []);
    })
    .await;
}

/// Proves: every room of a Sonos group is set on its own, so the quieter room
/// keeps its level, and the group volume is never used.
#[tokio::test]
async fn each_room_of_a_sonos_group_is_set_on_its_own() {
    within("sonos group", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Dining Room"])
            .build()
            .await;
        group(&sys, "Kitchen", "Dining Room").await;
        sys.fake.speaker_named("Kitchen").set_volume(72);
        sys.fake.speaker_named("Dining Room").set_volume(20);
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys
            .start_with_volume(&stream, &["Kitchen"], false, &limit(30))
            .await;
        assert!(results[0].success, "{results:?}");

        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 30);
        assert_eq!(sys.fake.speaker_named("Dining Room").volume(), 20);
        let calls = sys.fake.calls_since(seq);
        assert!(
            !calls.iter().any(|call| call.action == "SetGroupVolume"),
            "{}",
            sys.fake.format_log()
        );
        assert!(calls
            .iter()
            .any(|call| call.is(&sys.ip("Dining Room"), "GetVolume")));
    })
    .await;
}

/// Proves: a room whose level cannot be read starts at the limit.
#[tokio::test]
async fn a_room_that_cannot_be_read_starts_at_the_limit() {
    within("unreadable room", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let kitchen = sys.ip("Kitchen");
        sys.fake.speaker_named("Kitchen").set_volume(10);
        sys.fake.fail(&kitchen, "GetVolume", Failure::Fault(501));
        let stream = sys.new_stream();

        sys.start_with_volume(&stream, &["Kitchen"], false, &limit(30))
            .await;

        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 30);
    })
    .await;
}

/// Proves: a level set by hand applies to its own room only, above the limit
/// too; a grouped partner without one follows the limit.
#[tokio::test]
async fn a_hand_set_level_applies_to_its_room_even_above_the_limit() {
    within("hand-set level", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Dining Room"])
            .build()
            .await;
        group(&sys, "Kitchen", "Dining Room").await;
        sys.fake.speaker_named("Kitchen").set_volume(20);
        sys.fake.speaker_named("Dining Room").set_volume(60);
        let stream = sys.new_stream();
        let request = StartVolumeRequest {
            limit: Some(30),
            rooms: HashMap::from([(sys.uuid("Kitchen"), 45)]),
        };

        sys.start_with_volume(&stream, &["Kitchen"], false, &request)
            .await;

        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 45);
        assert_eq!(sys.fake.speaker_named("Dining Room").volume(), 30);
    })
    .await;
}

/// Proves: a grouped partner's own hand-set level reaches it through its
/// coordinator's target, and the coordinator follows the limit.
#[tokio::test]
async fn a_partner_s_hand_set_level_is_used_with_the_limit_off() {
    within("partner hand-set", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Dining Room"])
            .build()
            .await;
        group(&sys, "Kitchen", "Dining Room").await;
        sys.fake.speaker_named("Kitchen").set_volume(72);
        sys.fake.speaker_named("Dining Room").set_volume(60);
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();
        let request = StartVolumeRequest {
            limit: None,
            rooms: HashMap::from([(sys.uuid("Dining Room"), 15)]),
        };

        sys.start_with_volume(&stream, &["Kitchen"], false, &request)
            .await;

        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 72);
        assert_eq!(sys.fake.speaker_named("Dining Room").volume(), 15);
        let calls = sys.fake.calls_since(seq);
        assert!(
            !calls
                .iter()
                .any(|call| call.is(&sys.ip("Kitchen"), "GetVolume")),
            "with the limit off, a room with no hand-set level is not even read: {}",
            sys.fake.format_log()
        );
    })
    .await;
}

/// Proves: a fixed (line-level) output is never sent `SetVolume`.
#[tokio::test]
async fn a_fixed_output_is_never_set() {
    within("fixed output", async {
        let sys = TestSystem::builder().speakers(["Port"]).build().await;
        sys.fake.speaker_named("Port").set_output_fixed(true);
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys
            .start_with_volume(&stream, &["Port"], false, &limit(30))
            .await;
        assert!(results[0].success, "{results:?}");

        assert_eq!(set_volumes(&sys.fake.calls_since(seq)), []);
    })
    .await;
}

/// Proves: with the limit off and nothing set by hand, no volume is read or
/// set, exactly as before the start level existed.
#[tokio::test]
async fn with_the_limit_off_nothing_is_read_or_set() {
    within("limit off", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        sys.fake.speaker_named("Kitchen").set_volume(90);
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        sys.start_with_volume(&stream, &["Kitchen"], false, &StartVolumeRequest::default())
            .await;

        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 90);
        assert!(
            !sys.fake
                .calls_since(seq)
                .iter()
                .any(|call| call.service == SonosService::RenderingControl && !call.is_gena()),
            "{}",
            sys.fake.format_log()
        );
    })
    .await;
}

/// Proves: a repeated start of a stream already playing (a resume) leaves the
/// volume alone, even if the user turned the room up since.
#[tokio::test]
async fn a_resume_never_changes_the_volume() {
    within("resume", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        sys.fake.speaker_named("Kitchen").set_volume(72);
        let stream = sys.new_stream();
        sys.start_with_volume(&stream, &["Kitchen"], false, &limit(30))
            .await;
        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 30);

        sys.fake.speaker_named("Kitchen").set_volume(60);
        let seq = sys.fake.next_seq();
        sys.start_with_volume(&stream, &["Kitchen"], false, &limit(30))
            .await;

        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 60);
        assert_eq!(set_volumes(&sys.fake.calls_since(seq)), []);
    })
    .await;
}

/// Proves: with speakers synced, each target's rooms are set before any of
/// them is joined to the cast's group.
#[tokio::test]
async fn synced_speakers_are_set_before_they_are_joined() {
    within("synced start", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .build()
            .await;
        sys.fake.speaker_named("Kitchen").set_volume(72);
        sys.fake.speaker_named("Office").set_volume(80);
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys
            .start_with_volume(&stream, &["Kitchen", "Office"], true, &limit(30))
            .await;
        assert!(results.iter().all(|r| r.success), "{results:?}");

        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 30);
        assert_eq!(sys.fake.speaker_named("Office").volume(), 30);
        let calls = sys.fake.calls_since(seq);
        let last_set = calls
            .iter()
            .filter(|call| call.action == "SetVolume")
            .map(|call| call.seq)
            .max()
            .expect("SetVolume");
        let first_uri = calls
            .iter()
            .filter(|call| call.action == "SetAVTransportURI")
            .map(|call| call.seq)
            .min()
            .expect("SetAVTransportURI");
        assert!(last_set < first_uri, "{}", sys.fake.format_log());
    })
    .await;
}

/// Proves: a room added to a running cast (a second `START_PLAYBACK` naming
/// only it, as the extension's ADD_ROOMS sends) plays the same stream on its
/// own and starts at its level; the room already playing is left alone.
#[tokio::test]
async fn a_room_added_to_a_running_cast_starts_at_its_level() {
    within("add a room", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Study"])
            .build()
            .await;
        sys.fake.speaker_named("Kitchen").set_volume(72);
        sys.fake.speaker_named("Study").set_volume(80);
        let stream = sys.new_stream();
        sys.start_with_volume(&stream, &["Kitchen"], false, &limit(30))
            .await;
        sys.fake.speaker_named("Kitchen").set_volume(60);

        let request = StartVolumeRequest {
            limit: Some(30),
            rooms: HashMap::from([(sys.uuid("Study"), 25)]),
        };
        let results = sys
            .start_with_volume(&stream, &["Study"], false, &request)
            .await;

        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(sys.fake.speaker_named("Study").volume(), 25);
        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 60);
        let playing = sys
            .services
            .stream_coordinator
            .get_all_sessions()
            .into_iter()
            .filter(|session| session.stream_id == stream)
            .count();
        assert_eq!(playing, 2, "{}", sys.fake.format_log());
    })
    .await;
}
