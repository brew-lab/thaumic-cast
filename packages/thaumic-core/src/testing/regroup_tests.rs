//! Casting to rooms as one Sonos group, end to end against the fake
//! household: which room leads, what moves, in what order, and what is left
//! alone. Every test also checks that no speaker was told to join a group
//! while others still followed it.

use std::collections::HashMap;
use std::time::Duration;

use crate::events::SonosEvent;
use crate::protocol_constants::SPEAKERS_UPNP_DISABLED;
use crate::services::start_volume::StartVolumeRequest;
use crate::services::GroupRole;
use crate::sonos::services::SonosService;
use crate::sonos::types::TransportState;

use super::fake_sonos::{Call, Failure};
use super::harness::{within, TestSystem};

const MUSIC: &str = "x-sonos-spotify:spotify%3atrack%3a1";

fn limit(level: u8) -> StartVolumeRequest {
    StartVolumeRequest {
        limit: Some(level),
        rooms: HashMap::new(),
    }
}

/// The SOAP actions that change something (GENA and reads such as
/// `GetVolume` left out) the speaker in room `name` received.
fn actions(sys: &TestSystem, calls: &[Call], name: &str) -> Vec<String> {
    let ip = sys.ip(name);
    calls
        .iter()
        .filter(|call| call.speaker_ip == ip && !call.is_gena())
        .filter(|call| !call.action.starts_with("Get"))
        .map(|call| match call.arg("CurrentURI") {
            Some(uri) if uri.starts_with("x-rincon:") => "Join".to_string(),
            _ => call.action.clone(),
        })
        .collect()
}

/// Proves: casting to exactly one Sonos group plays on its coordinator and
/// moves nothing: one stream URI, no leave and no join.
#[tokio::test]
async fn an_exact_group_plays_on_its_coordinator_and_moves_nothing() {
    within("exact group", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office"])
            .groups(&[&["Kitchen", "Patio"]])
            .build()
            .await;
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys.start_rooms(&stream, &["Patio", "Kitchen"], None).await;

        assert_eq!(
            sys.outcome(&results),
            [("Kitchen".to_string(), true), ("Patio".to_string(), true)]
        );
        let calls = sys.fake.calls_since(seq);
        assert_eq!(
            actions(&sys, &calls, "Kitchen"),
            ["SetAVTransportURI", "Play"]
        );
        assert!(
            actions(&sys, &calls, "Patio").is_empty(),
            "{}",
            sys.fake.format_log()
        );
        assert!(calls
            .iter()
            .all(|call| call.action != "BecomeCoordinatorOfStandaloneGroup"));
        assert!(sys.fake.joins().is_empty());
        assert_eq!(
            sys.session(&stream, "Patio").map(|s| s.role),
            Some(GroupRole::Slave)
        );
        assert_eq!(sys.fake.grouping().len(), 2);
    })
    .await;
}

/// Proves: a whole group plus a standalone room keeps the group's
/// coordinator and joins only the standalone room, without a leave.
#[tokio::test]
async fn a_whole_group_plus_a_standalone_room_joins_only_that_room() {
    within("group plus room", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office"])
            .groups(&[&["Kitchen", "Patio"]])
            .build()
            .await;
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys
            .start_rooms(&stream, &["Office", "Kitchen", "Patio"], None)
            .await;

        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(results[0].speaker_ip, sys.ip("Kitchen"));
        let calls = sys.fake.calls_since(seq);
        assert_eq!(actions(&sys, &calls, "Office"), ["Join", "Play"]);
        assert!(actions(&sys, &calls, "Patio").is_empty());
        assert_eq!(sys.fake.coordinator_name_of("Office"), "Kitchen");
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: a member pulled out of a playing group leaves it, gets its start
/// level, then joins, in that order; the group it left plays on with no
/// restart, and the room records the group it left.
#[tokio::test]
async fn a_member_pulled_from_a_group_leaves_then_is_set_then_joins() {
    within("member pull", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office"])
            .groups(&[&["Kitchen", "Patio"]])
            .build()
            .await;
        sys.fake.play_music("Kitchen", MUSIC);
        sys.fake.speaker_named("Patio").set_volume(72);
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys
            .start_rooms(&stream, &["Office", "Patio"], Some(&limit(30)))
            .await;

        assert!(results.iter().all(|r| r.success), "{results:?}");
        let calls = sys.fake.calls_since(seq);
        assert_eq!(
            actions(&sys, &calls, "Patio"),
            [
                "BecomeCoordinatorOfStandaloneGroup",
                "SetVolume",
                "Join",
                "Play"
            ],
            "{}",
            sys.fake.format_log()
        );
        assert_eq!(sys.fake.speaker_named("Patio").volume(), 30);
        let kitchen = sys.fake.speaker_named("Kitchen");
        assert_eq!(kitchen.current_uri(), MUSIC);
        assert_eq!(kitchen.transport_state(), TransportState::Playing);
        assert!(actions(&sys, &calls, "Kitchen").is_empty());
        assert!(sys.fake.restarts().is_empty());

        let old = sys
            .session(&stream, "Patio")
            .and_then(|s| s.old_group)
            .expect("Patio records the group it left");
        assert_eq!(old.coordinator_uuid, sys.uuid("Kitchen"));
        assert_eq!(old.partners, [sys.uuid("Kitchen")]);
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: a coordinator pulled out of a playing group leaves it first: its
/// partner is promoted and its track restarts, and the room records the
/// partner it left.
#[tokio::test]
async fn a_coordinator_pulled_from_a_group_hands_it_on() {
    within("coordinator pull", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office", "Den"])
            .groups(&[&["Kitchen", "Patio"], &["Office", "Den"]])
            .build()
            .await;
        sys.fake.play_music("Kitchen", MUSIC);
        let stream = sys.new_stream();

        let results = sys.start_rooms(&stream, &["Kitchen", "Office"], None).await;

        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(results[0].speaker_ip, sys.ip("Kitchen"));
        let restarts = sys.fake.restarts();
        assert_eq!(restarts.len(), 1, "{restarts:?}");
        assert_eq!(restarts[0].promoted, "Patio");
        assert_eq!(sys.fake.speaker_named("Patio").current_uri(), MUSIC);
        assert_eq!(sys.fake.coordinator_name_of("Den"), "Den");
        assert_eq!(sys.fake.coordinator_name_of("Office"), "Kitchen");
        let old = sys
            .session(&stream, "Kitchen")
            .and_then(|s| s.old_group)
            .expect("Kitchen records the group it left");
        assert_eq!(old.partners, [sys.uuid("Patio")]);
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: the largest group made only of chosen rooms leads, over a
/// standalone room chosen first.
#[tokio::test]
async fn the_largest_group_of_chosen_rooms_leads() {
    within("coordinator choice", async {
        let sys = TestSystem::builder()
            .speakers(["Office", "Kitchen", "Patio", "Dining Room"])
            .groups(&[&["Kitchen", "Patio", "Dining Room"]])
            .build()
            .await;
        let stream = sys.new_stream();

        let results = sys
            .start_rooms(
                &stream,
                &["Office", "Dining Room", "Patio", "Kitchen"],
                None,
            )
            .await;

        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(results[0].speaker_ip, sys.ip("Kitchen"));
        assert_eq!(sys.fake.joins().len(), 1);
        assert_eq!(sys.fake.grouping().len(), 1);
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: every room gets its own start level before it joins:
/// min(current, limit), a hand-set level, a fixed output left alone, and the
/// limit for a room whose level cannot be read.
#[tokio::test]
async fn each_room_gets_its_start_level_before_it_joins() {
    within("start levels", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office", "Port", "Den"])
            .soap_timeout(Duration::from_millis(300))
            .build()
            .await;
        sys.fake.speaker_named("Kitchen").set_volume(72);
        sys.fake.speaker_named("Patio").set_volume(10);
        sys.fake.speaker_named("Office").set_volume(50);
        sys.fake.speaker_named("Port").set_output_fixed(true);
        sys.fake.fail(&sys.ip("Den"), "GetVolume", Failure::Hang);
        let request = StartVolumeRequest {
            limit: Some(30),
            rooms: HashMap::from([(sys.uuid("Office"), 45)]),
        };
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys
            .start_rooms(
                &stream,
                &["Kitchen", "Patio", "Office", "Port", "Den"],
                Some(&request),
            )
            .await;

        assert!(results.iter().all(|r| r.success), "{results:?}");
        let volume = |name: &str| sys.fake.speaker_named(name).volume();
        assert_eq!(volume("Kitchen"), 30);
        assert_eq!(volume("Patio"), 10);
        assert_eq!(volume("Office"), 45);
        assert_eq!(volume("Port"), 100);
        assert_eq!(volume("Den"), 30);

        let calls = sys.fake.calls_since(seq);
        for name in ["Office", "Den"] {
            let mine = actions(&sys, &calls, name);
            let set = mine.iter().position(|a| a == "SetVolume");
            let join = mine.iter().position(|a| a == "Join");
            assert!(set.is_some() && set < join, "{name}: {mine:?}");
        }
        assert!(!actions(&sys, &calls, "Port").contains(&"SetVolume".to_string()));
        assert!(calls.iter().all(|call| call.action != "SetGroupVolume"));
    })
    .await;
}

/// Proves: a home theatre is one room: it joins as one, and no call ever
/// reaches its satellite.
#[tokio::test]
async fn a_home_theatre_joins_as_one_room() {
    within("home theatre", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Living Room", "Living Room Sub"])
            .home_theatre("Living Room", &["Living Room Sub"])
            .build()
            .await;
        sys.fake.speaker_named("Living Room Sub").set_volume(80);
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys
            .start_rooms(&stream, &["Kitchen", "Living Room"], Some(&limit(30)))
            .await;

        assert_eq!(
            sys.outcome(&results),
            [
                ("Kitchen".to_string(), true),
                ("Living Room".to_string(), true)
            ]
        );
        let calls = sys.fake.calls_since(seq);
        assert!(
            actions(&sys, &calls, "Living Room Sub").is_empty(),
            "{}",
            sys.fake.format_log()
        );
        assert_eq!(sys.fake.speaker_named("Living Room Sub").volume(), 80);
        assert_eq!(sys.fake.coordinator_name_of("Living Room"), "Kitchen");
    })
    .await;
}

/// Proves: when the coordinator cannot play, no other room is touched and
/// every room is reported as failed.
#[tokio::test]
async fn a_coordinator_that_cannot_play_touches_no_other_room() {
    within("coordinator fails", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office"])
            .groups(&[&["Patio", "Office"]])
            .build()
            .await;
        sys.fake
            .fail(&sys.ip("Kitchen"), "SetAVTransportURI", Failure::Fault(800));
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;

        assert_eq!(
            sys.outcome(&results),
            [("Kitchen".to_string(), false), ("Patio".to_string(), false)]
        );
        assert_eq!(
            results[1].error.as_deref(),
            Some("Coordinator failed to start")
        );
        let calls = sys.fake.calls_since(seq);
        assert!(actions(&sys, &calls, "Patio").is_empty());
        assert!(actions(&sys, &calls, "Office").is_empty());
        assert!(sys.sessions().is_empty());
    })
    .await;
}

/// Proves: a room that cannot leave its group is left untouched and
/// reported, and the others play.
#[tokio::test]
async fn a_room_that_cannot_leave_its_group_is_left_as_it_was() {
    within("leave fails", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office", "Den"])
            .groups(&[&["Patio", "Den"]])
            .build()
            .await;
        sys.fake.fail(
            &sys.ip("Patio"),
            "BecomeCoordinatorOfStandaloneGroup",
            Failure::Fault(800),
        );
        let stream = sys.new_stream();

        let results = sys
            .start_rooms(&stream, &["Kitchen", "Patio", "Office"], Some(&limit(30)))
            .await;

        assert_eq!(
            sys.outcome(&results),
            [
                ("Kitchen".to_string(), true),
                ("Patio".to_string(), false),
                ("Office".to_string(), true),
            ]
        );
        assert_eq!(sys.fake.coordinator_name_of("Den"), "Patio");
        assert_eq!(sys.fake.coordinator_name_of("Office"), "Kitchen");
        assert!(sys.session(&stream, "Patio").is_none());
        assert!(!sys
            .fake
            .calls_for(&sys.ip("Patio"))
            .iter()
            .any(|call| call.action == "SetVolume"));
    })
    .await;
}

/// Proves: a room whose join is refused is reported on its own and the rest
/// of the group plays on.
#[tokio::test]
async fn a_refused_join_is_reported_and_the_rest_play() {
    within("join fails", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office"])
            .build()
            .await;
        sys.fake.refuse_join("Patio", "Kitchen");
        let stream = sys.new_stream();

        let results = sys
            .start_rooms(&stream, &["Kitchen", "Patio", "Office"], None)
            .await;

        assert_eq!(
            sys.outcome(&results),
            [
                ("Kitchen".to_string(), true),
                ("Patio".to_string(), false),
                ("Office".to_string(), true),
            ]
        );
        assert!(sys.session(&stream, "Patio").is_none());
        assert_eq!(sys.fake.coordinator_name_of("Office"), "Kitchen");
    })
    .await;
}

/// Proves: two casts to rooms started at once take turns on the regroup
/// lock: each plans from the grouping the other left, and the household
/// ends in two clean groups.
#[tokio::test]
async fn two_regroups_at_once_take_turns() {
    within("serialised", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office", "Den"])
            .groups(&[&["Kitchen", "Office"], &["Patio", "Den"]])
            .build()
            .await;
        let first = sys.new_stream();
        let second = sys.new_stream();
        let seq = sys.fake.next_seq();

        let (a, b) = tokio::join!(
            sys.start_rooms(&first, &["Kitchen", "Patio"], None),
            sys.start_rooms(&second, &["Office", "Den"], None),
        );

        assert!(a.iter().chain(b.iter()).all(|r| r.success), "{a:?} {b:?}");
        assert_eq!(
            sys.fake.grouping(),
            [
                vec!["Den".to_string(), "Office".to_string()],
                vec!["Kitchen".to_string(), "Patio".to_string()],
            ]
        );
        sys.fake.assert_no_grouped_coordinator_joined();

        // One fresh read per regroup, and every join of the first to run
        // lands before the second reads the grouping.
        let calls = sys.fake.calls_since(seq);
        let reads: Vec<usize> = calls
            .iter()
            .filter(|call| call.action == "GetZoneGroupState")
            .map(|call| call.seq)
            .collect();
        assert_eq!(reads.len(), 2, "{}", sys.fake.format_log());
        let joins: Vec<(usize, String)> = calls
            .iter()
            .filter_map(|call| {
                let uri = call.arg("CurrentURI")?;
                uri.strip_prefix("x-rincon:")
                    .map(|uuid| (call.seq, uuid.to_string()))
            })
            .collect();
        let before: Vec<&String> = joins
            .iter()
            .filter(|(s, _)| *s < reads[1])
            .map(|(_, u)| u)
            .collect();
        let after: Vec<&String> = joins
            .iter()
            .filter(|(s, _)| *s > reads[1])
            .map(|(_, u)| u)
            .collect();
        assert_eq!(
            (before.len(), after.len()),
            (1, 1),
            "{}",
            sys.fake.format_log()
        );
        assert_ne!(before[0], after[0]);
    })
    .await;
}

// ── Putting rooms back ─────────────────────────────────────────────────────

/// The rooms that were told to join a group (with `x-rincon:`) at or after
/// `seq`, as `(room, group's coordinator room)`.
fn rejoins_since(sys: &TestSystem, seq: usize) -> Vec<(String, String)> {
    sys.fake
        .calls_since(seq)
        .iter()
        .filter_map(|call| {
            let uuid = call.arg("CurrentURI")?.strip_prefix("x-rincon:")?;
            let target = sys
                .fake
                .speakers()
                .iter()
                .find(|s| s.uuid == uuid)
                .map_or(uuid.to_string(), |s| s.name.clone());
            Some((call.speaker_name.clone(), target))
        })
        .collect()
}

/// Whether the room `name` was sent `action` at or after `seq`.
fn sent(sys: &TestSystem, seq: usize, name: &str, action: &str) -> bool {
    let ip = sys.ip(name);
    sys.fake
        .calls_since(seq)
        .iter()
        .any(|call| call.is(&ip, action))
}

fn names(groups: &[&[&str]]) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = groups
        .iter()
        .map(|g| {
            let mut g: Vec<String> = g.iter().map(|n| (*n).to_string()).collect();
            g.sort();
            g
        })
        .collect();
    out.sort();
    out
}

/// Proves: on Stop a member goes back to its old coordinator and a room that
/// led a group goes back to its partner's current (promoted) coordinator,
/// each with `SetAVTransportURI` alone and no Play; a rejoined room plays the
/// group's music on its own.
#[tokio::test]
async fn stop_puts_each_room_back_with_no_play() {
    within("stop restores", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office", "Den"])
            .groups(&[&["Kitchen", "Patio"], &["Office", "Den"]])
            .build()
            .await;
        sys.fake.play_music("Kitchen", MUSIC);
        sys.fake.play_music("Office", MUSIC);
        let stream = sys.new_stream();
        let results = sys.start_rooms(&stream, &["Patio", "Office"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(results[0].speaker_ip, sys.ip("Patio"));
        assert_eq!(sys.fake.coordinator_name_of("Den"), "Den");

        let seq = sys.fake.next_seq();
        sys.coordinator().remove_stream_async(&stream).await;

        let mut back = rejoins_since(&sys, seq);
        back.sort();
        assert_eq!(
            back,
            [
                ("Office".to_string(), "Den".to_string()),
                ("Patio".to_string(), "Kitchen".to_string())
            ],
            "{}",
            sys.fake.format_log()
        );
        assert!(!sent(&sys, seq, "Office", "Play"));
        let last_patio_play = sys
            .fake
            .calls_since(seq)
            .iter()
            .filter(|c| c.is(&sys.ip("Patio"), "Play"))
            .count();
        assert_eq!(last_patio_play, 0, "{}", sys.fake.format_log());
        assert_eq!(
            sys.fake.grouping(),
            names(&[&["Kitchen", "Patio"], &["Den", "Office"]])
        );
        assert_eq!(
            sys.fake.speaker_named("Patio").transport_state(),
            TransportState::Playing
        );
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: casting to exactly one Sonos group and stopping leaves that group
/// as it was: its rooms are never made to leave.
#[tokio::test]
async fn stopping_an_exact_group_leaves_it_grouped() {
    within("exact group stop", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio"])
            .groups(&[&["Kitchen", "Patio"]])
            .build()
            .await;
        let stream = sys.new_stream();
        sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;

        let seq = sys.fake.next_seq();
        sys.coordinator().remove_stream_async(&stream).await;

        assert!(!sent(
            &sys,
            seq,
            "Patio",
            "BecomeCoordinatorOfStandaloneGroup"
        ));
        assert!(rejoins_since(&sys, seq).is_empty());
        assert_eq!(sys.fake.grouping(), names(&[&["Kitchen", "Patio"]]));
    })
    .await;
}

/// Proves: a room someone regrouped before Stop gets no leave and no
/// restore, and one someone made standalone is not put back either.
#[tokio::test]
async fn stop_leaves_rooms_someone_else_regrouped_alone() {
    within("guard", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office", "Den", "Hall"])
            .groups(&[&["Kitchen", "Patio"], &["Den", "Hall"]])
            .build()
            .await;
        let stream = sys.new_stream();
        let results = sys
            .start_rooms(&stream, &["Office", "Patio", "Hall"], None)
            .await;
        assert!(results.iter().all(|r| r.success), "{results:?}");

        // In the Sonos app: Patio joins Den, and Hall is ungrouped.
        sys.fake.regroup_externally("Patio", "Den");
        sys.fake.make_standalone_externally("Hall");

        let seq = sys.fake.next_seq();
        sys.coordinator().remove_stream_async(&stream).await;

        for room in ["Patio", "Hall"] {
            assert!(
                !sent(&sys, seq, room, "BecomeCoordinatorOfStandaloneGroup"),
                "{room}: {}",
                sys.fake.format_log()
            );
        }
        assert!(
            rejoins_since(&sys, seq).is_empty(),
            "{}",
            sys.fake.format_log()
        );
        assert_eq!(sys.fake.coordinator_name_of("Patio"), "Den");
        assert_eq!(sys.fake.coordinator_name_of("Hall"), "Hall");
        assert!(sys.sessions().is_empty());
    })
    .await;
}

/// Proves: a room whose old partners have all gone is left standing alone.
#[tokio::test]
async fn a_room_whose_old_group_is_gone_stays_alone() {
    within("partners gone", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office"])
            .groups(&[&["Kitchen", "Patio"]])
            .build()
            .await;
        let stream = sys.new_stream();
        sys.start_rooms(&stream, &["Office", "Patio"], None).await;
        sys.fake.vanish("Kitchen");

        let seq = sys.fake.next_seq();
        sys.coordinator().remove_stream_async(&stream).await;

        assert!(
            rejoins_since(&sys, seq).is_empty(),
            "{}",
            sys.fake.format_log()
        );
        assert_eq!(sys.fake.coordinator_name_of("Patio"), "Patio");
    })
    .await;
}

/// Proves: two whole groups merged for a cast come back as the same two
/// groups: the leading group never moved, and the other is rebuilt around
/// its old coordinator, each room sent once.
#[tokio::test]
async fn two_merged_groups_come_back_as_they_were() {
    within("merged groups", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office", "Den"])
            .groups(&[&["Kitchen", "Patio"], &["Office", "Den"]])
            .build()
            .await;
        let stream = sys.new_stream();
        let results = sys
            .start_rooms(&stream, &["Kitchen", "Patio", "Office", "Den"], None)
            .await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(sys.fake.grouping().len(), 1);

        let seq = sys.fake.next_seq();
        sys.coordinator().remove_stream_async(&stream).await;

        assert_eq!(
            rejoins_since(&sys, seq),
            [("Den".to_string(), "Office".to_string())],
            "{}",
            sys.fake.format_log()
        );
        assert!(!sent(
            &sys,
            seq,
            "Patio",
            "BecomeCoordinatorOfStandaloneGroup"
        ));
        assert_eq!(
            sys.fake.grouping(),
            names(&[&["Kitchen", "Patio"], &["Den", "Office"]])
        );
        assert_eq!(sys.fake.coordinator_name_of("Den"), "Office");
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: removing one room from a cast makes it leave and puts it back,
/// while the rest of the cast plays on.
#[tokio::test]
async fn removing_a_room_puts_it_back_and_the_cast_plays_on() {
    within("remove slave", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office"])
            .groups(&[&["Kitchen", "Patio"]])
            .build()
            .await;
        let stream = sys.new_stream();
        sys.start_rooms(&stream, &["Office", "Patio"], None).await;

        let seq = sys.fake.next_seq();
        let stopped = sys
            .coordinator()
            .stop_playback_speaker(&stream, &sys.ip("Patio"), None)
            .await;

        assert_eq!(stopped, [sys.ip("Patio")]);
        assert!(sent(
            &sys,
            seq,
            "Patio",
            "BecomeCoordinatorOfStandaloneGroup"
        ));
        assert_eq!(
            rejoins_since(&sys, seq),
            [("Patio".to_string(), "Kitchen".to_string())]
        );
        assert!(!sent(&sys, seq, "Patio", "Play"));
        assert!(sys.session(&stream, "Office").is_some());
        assert!(!sent(&sys, seq, "Office", "Stop"));
    })
    .await;
}

/// Proves: removing the cast's coordinator hands the stream to a slave that
/// leaves first and then plays, the other slave re-joins it, and the old
/// coordinator goes back to its old partner's group.
#[tokio::test]
async fn removing_the_coordinator_hands_on_the_cast_and_puts_it_back() {
    within("remove coordinator", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den", "Hall", "Office", "Attic"])
            .groups(&[
                &["Kitchen", "Patio"],
                &["Den", "Hall"],
                &["Office", "Attic"],
            ])
            .build()
            .await;
        let stream = sys.new_stream();
        let results = sys
            .start_rooms(&stream, &["Kitchen", "Den", "Office"], None)
            .await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(results[0].speaker_ip, sys.ip("Kitchen"));

        let seq = sys.fake.next_seq();
        let stopped = sys
            .coordinator()
            .stop_playback_speaker(&stream, &sys.ip("Kitchen"), None)
            .await;
        assert_eq!(stopped, [sys.ip("Kitchen")]);

        let promoted = sys
            .sessions()
            .into_iter()
            .find(|s| s.role == GroupRole::Coordinator)
            .expect("a promoted coordinator");
        let promoted_name = sys.fake.speaker_at(&promoted.speaker_ip).name.clone();
        let other = if promoted_name == "Den" {
            "Office"
        } else {
            "Den"
        };
        let calls = sys.fake.calls_since(seq);
        let theirs = actions(&sys, &calls, &promoted_name);
        let leave = theirs
            .iter()
            .position(|a| a == "BecomeCoordinatorOfStandaloneGroup");
        let play_uri = theirs.iter().position(|a| a == "SetAVTransportURI");
        assert!(leave.is_some() && leave < play_uri, "{theirs:?}");
        assert_eq!(sys.fake.coordinator_name_of(other), promoted_name);
        assert_eq!(sys.fake.coordinator_name_of("Kitchen"), "Patio");
        assert!(!sent(&sys, seq, "Kitchen", "Play"));
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: a coordinator that left its group and then could not play is put
/// back, and no other room was touched.
#[tokio::test]
async fn a_coordinator_that_left_and_failed_is_put_back() {
    within("coordinator fails after leaving", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office", "Den"])
            .groups(&[&["Kitchen", "Patio"], &["Office", "Den"]])
            .build()
            .await;
        sys.fake.play_music("Kitchen", MUSIC);
        sys.fake
            .fail(&sys.ip("Kitchen"), "Play", Failure::Fault(800));
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys.start_rooms(&stream, &["Kitchen", "Office"], None).await;

        assert!(results.iter().all(|r| !r.success), "{results:?}");
        assert_eq!(sys.fake.coordinator_name_of("Kitchen"), "Patio");
        let calls = sys.fake.calls_since(seq);
        assert!(actions(&sys, &calls, "Office").is_empty());
        assert!(actions(&sys, &calls, "Den").is_empty());
        assert!(sys.sessions().is_empty());
    })
    .await;
}

/// Proves: a room that left its group but could not join the cast is put
/// back into that group at once.
#[tokio::test]
async fn a_room_that_left_but_could_not_join_is_put_back() {
    within("join fails after leaving", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den"])
            .groups(&[&["Den", "Patio"]])
            .build()
            .await;
        sys.fake.refuse_join("Patio", "Kitchen");
        let stream = sys.new_stream();

        let results = sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;

        assert_eq!(
            sys.outcome(&results),
            [("Kitchen".to_string(), true), ("Patio".to_string(), false)]
        );
        assert_eq!(sys.fake.coordinator_name_of("Patio"), "Den");
        assert!(sys.session(&stream, "Patio").is_none());
    })
    .await;
}

/// Proves: when the cast's coordinator is taken by another source, nothing
/// is put back: the household took the room.
#[tokio::test]
async fn a_source_change_puts_nothing_back() {
    within("source change", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den"])
            .groups(&[&["Den", "Patio"]])
            .build()
            .await;
        let stream = sys.new_stream();
        sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;

        let seq = sys.fake.next_seq();
        let kitchen = sys.ip("Kitchen");
        assert_eq!(
            sys.fake
                .notify_av_transport(&kitchen, TransportState::Playing, MUSIC)
                .await,
            200
        );
        sys.events
            .wait_for_stream(|event| {
                matches!(
                    event,
                    crate::events::StreamEvent::PlaybackStopped {
                        reason: Some(crate::events::SpeakerRemovalReason::SourceChanged),
                        ..
                    }
                )
            })
            .await;

        assert!(
            rejoins_since(&sys, seq).is_empty(),
            "{}",
            sys.fake.format_log()
        );
        assert!(!sent(
            &sys,
            seq,
            "Patio",
            "BecomeCoordinatorOfStandaloneGroup"
        ));
    })
    .await;
}

/// Proves: when the cast's coordinator is taken by another source, the rooms
/// following it play that source with it, so their sessions end too, and a
/// Stop pressed afterwards sends no room anything: the new group is left
/// alone.
#[tokio::test]
async fn a_stop_after_a_source_change_leaves_the_new_group_alone() {
    within("stop after source change", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den"])
            .groups(&[&["Den", "Patio"]])
            .build()
            .await;
        let stream = sys.new_stream();
        let results = sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");

        let seq = sys.fake.next_seq();
        let patio = sys.ip("Patio");
        sys.fake
            .notify_av_transport(&sys.ip("Kitchen"), TransportState::Playing, MUSIC)
            .await;
        sys.events
            .wait_for_stream(|event| {
                matches!(
                    event,
                    crate::events::StreamEvent::PlaybackStopped {
                        speaker_ip,
                        reason: Some(crate::events::SpeakerRemovalReason::SourceChanged),
                        ..
                    } if *speaker_ip == patio
                )
            })
            .await;
        assert!(sys.sessions().is_empty(), "{:?}", sys.sessions());

        sys.coordinator().remove_stream_async(&stream).await;

        for room in ["Kitchen", "Patio", "Den"] {
            assert!(
                actions(&sys, &sys.fake.calls_since(seq), room).is_empty(),
                "{room}: {}",
                sys.fake.format_log()
            );
        }
        assert_eq!(sys.fake.coordinator_name_of("Patio"), "Kitchen");
    })
    .await;
}

/// Proves: a NOTIFY that lands while a cast is still joining rooms ends no
/// session: every room the cast joined is still in it afterwards.
#[tokio::test]
async fn a_notify_mid_regroup_ends_no_session() {
    within("notify mid-regroup", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den"])
            .groups(&[&["Den", "Patio"]])
            .build()
            .await;
        sys.fake.fail(
            &sys.ip("Patio"),
            "SetAVTransportURI",
            Failure::Delay(Duration::from_millis(400)),
        );
        let stream = sys.new_stream();
        let kitchen = sys.ip("Kitchen");
        let seq = sys.fake.next_seq();

        let (results, ()) = tokio::join!(
            sys.start_rooms(&stream, &["Kitchen", "Patio"], None),
            async {
                sys.fake
                    .wait_for_call(seq, |call| call.is(&sys.ip("Patio"), "SetAVTransportURI"))
                    .await;
                sys.fake.notify_zone_group_topology().await;
                sys.fake
                    .notify_av_transport(
                        &kitchen,
                        TransportState::Playing,
                        &sys.speaker_uri(&stream),
                    )
                    .await;
            }
        );

        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert!(sys.events.playback_stopped().is_empty());
        assert!(sys.session(&stream, "Kitchen").is_some());
        assert!(sys.session(&stream, "Patio").is_some());
    })
    .await;
}

/// Proves: a Stop that lands while a cast is still joining rooms waits for
/// it, then stops and puts back every room it joined, so none is stranded
/// out of its old group.
#[tokio::test]
async fn a_stop_during_a_cast_puts_back_the_rooms_it_joined() {
    within("stop during cast", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den"])
            .groups(&[&["Den", "Patio"]])
            .build()
            .await;
        sys.fake.fail(
            &sys.ip("Patio"),
            "SetAVTransportURI",
            Failure::Delay(Duration::from_millis(300)),
        );
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        tokio::join!(
            sys.start_rooms(&stream, &["Kitchen", "Patio"], None),
            async {
                sys.fake
                    .wait_for_call(seq, |call| call.is(&sys.ip("Kitchen"), "Play"))
                    .await;
                sys.coordinator().remove_stream_async(&stream).await;
            }
        );

        assert!(sys.sessions().is_empty(), "{:?}", sys.sessions());
        assert_eq!(
            sys.fake.coordinator_name_of("Patio"),
            "Den",
            "{}",
            sys.fake.format_log()
        );
        assert!(sent(&sys, seq, "Kitchen", "Stop"));
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: a cast queued behind a Stop of its own stream finds the stream
/// gone and touches no speaker.
#[tokio::test]
async fn a_cast_queued_behind_its_stop_touches_nothing() {
    within("cast after stop", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio"])
            .build()
            .await;
        let stream = sys.new_stream();
        sys.start_rooms(&stream, &["Kitchen"], None).await;
        let seq = sys.fake.next_seq();

        let ((), results) = tokio::join!(
            sys.coordinator().remove_stream_async(&stream),
            sys.start_rooms(&stream, &["Patio"], None),
        );

        assert!(results.iter().all(|r| !r.success), "{results:?}");
        assert!(actions(&sys, &sys.fake.calls_since(seq), "Patio").is_empty());
        assert!(sys.sessions().is_empty());
    })
    .await;
}

/// Proves: when no speaker reports the grouping, a cast moves nothing and
/// every room is reported, rather than planning from a stale cache.
#[tokio::test]
async fn a_cast_with_no_fresh_grouping_moves_nothing() {
    within("no fresh grouping", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den"])
            .groups(&[&["Den", "Patio"]])
            .build()
            .await;
        for name in ["Kitchen", "Patio", "Den"] {
            sys.fake
                .fail(&sys.ip(name), "GetZoneGroupState", Failure::Fault(501));
        }
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;

        assert!(results.iter().all(|r| !r.success), "{results:?}");
        assert_eq!(
            results[0].error.as_deref(),
            Some("Could not read the Sonos grouping")
        );
        for room in ["Kitchen", "Patio", "Den"] {
            assert!(actions(&sys, &sys.fake.calls_since(seq), room).is_empty());
        }
        assert!(sys.sessions().is_empty());
    })
    .await;
}

/// Proves: with Sonos UPnP switched off a cast moves nothing and every room
/// says why, in the one word clients turn into the setting's name; switched
/// back on, the same cast plays.
#[tokio::test]
async fn a_cast_with_upnp_off_moves_nothing_and_says_why() {
    within("upnp off cast", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den"])
            .groups(&[&["Den", "Patio"]])
            .build()
            .await;
        sys.fake.set_upnp_enabled(false);
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let results = sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;

        assert_eq!(results.len(), 2, "{results:?}");
        for result in &results {
            assert!(!result.success, "{results:?}");
            assert_eq!(result.error.as_deref(), Some(SPEAKERS_UPNP_DISABLED));
        }
        let calls = sys.fake.calls_since(seq);
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.action == "GetZoneGroupState")
                .count(),
            1,
            "one refusal speaks for the household"
        );
        for room in ["Kitchen", "Patio", "Den"] {
            assert!(actions(&sys, &calls, room).is_empty());
        }
        assert!(sys.sessions().is_empty());

        sys.fake.set_upnp_enabled(true);
        let results = sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
    })
    .await;
}

/// Proves: a room that cannot leave on Stop stays where it is, and the
/// coordinator it still follows is not put back, so no room is ever told to
/// join while another follows it.
#[tokio::test]
async fn a_room_stuck_on_stop_keeps_its_coordinator_from_going_back() {
    within("stuck slave on stop", async {
        let sys = TestSystem::builder()
            .speakers(["Office", "Attic", "Kitchen", "Patio"])
            .groups(&[&["Office", "Attic"], &["Kitchen", "Patio"]])
            .build()
            .await;
        let stream = sys.new_stream();
        let results = sys.start_rooms(&stream, &["Office", "Kitchen"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(results[0].speaker_ip, sys.ip("Office"));
        sys.fake.fail(
            &sys.ip("Kitchen"),
            "BecomeCoordinatorOfStandaloneGroup",
            Failure::Fault(800),
        );

        let seq = sys.fake.next_seq();
        sys.coordinator().remove_stream_async(&stream).await;

        assert!(
            rejoins_since(&sys, seq).is_empty(),
            "{}",
            sys.fake.format_log()
        );
        assert_eq!(sys.fake.coordinator_name_of("Kitchen"), "Office");
        assert!(sys.sessions().is_empty());
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: when the promoted room cannot play on Remove of the coordinator,
/// the fallback still stops the cast and puts every room back, the old
/// coordinator included.
#[tokio::test]
async fn a_failed_promotion_still_puts_every_room_back() {
    within("promotion play fails", async {
        let sys = TestSystem::builder()
            .speakers(["Office", "Attic", "Kitchen", "Patio", "Den", "Hall"])
            .groups(&[
                &["Office", "Attic"],
                &["Kitchen", "Patio"],
                &["Den", "Hall"],
            ])
            .build()
            .await;
        let stream = sys.new_stream();
        let results = sys
            .start_rooms(&stream, &["Office", "Kitchen", "Den"], None)
            .await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(results[0].speaker_ip, sys.ip("Office"));
        for name in ["Kitchen", "Den"] {
            sys.fake.fail(&sys.ip(name), "Play", Failure::Fault(800));
        }

        sys.coordinator()
            .stop_playback_speaker(&stream, &sys.ip("Office"), None)
            .await;

        assert!(sys.sessions().is_empty(), "{:?}", sys.sessions());
        assert_eq!(
            sys.fake.grouping(),
            names(&[
                &["Attic", "Office"],
                &["Kitchen", "Patio"],
                &["Den", "Hall"]
            ]),
            "{}",
            sys.fake.format_log()
        );
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: a room that leaves but cannot join the promoted coordinator on
/// Remove is not stranded: its session ends and it goes back to its old
/// group.
#[tokio::test]
async fn a_room_that_cannot_rejoin_after_a_promotion_goes_back() {
    within("re-point join fails", async {
        let sys = TestSystem::builder()
            .speakers(["Office", "Kitchen", "Patio", "Den", "Hall"])
            .groups(&[&["Kitchen", "Patio"], &["Den", "Hall"]])
            .build()
            .await;
        let stream = sys.new_stream();
        let results = sys
            .start_rooms(&stream, &["Office", "Kitchen", "Den"], None)
            .await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        sys.fake.refuse_join("Kitchen", "Den");
        sys.fake.refuse_join("Den", "Kitchen");

        sys.coordinator()
            .stop_playback_speaker(&stream, &sys.ip("Office"), None)
            .await;

        let promoted = sys
            .sessions()
            .into_iter()
            .find(|s| s.role == GroupRole::Coordinator)
            .expect("a promoted coordinator");
        let promoted = sys.fake.speaker_at(&promoted.speaker_ip).name.clone();
        let (stranded, partner) = if promoted == "Kitchen" {
            ("Den", "Hall")
        } else {
            ("Kitchen", "Patio")
        };
        assert!(sys.session(&stream, stranded).is_none());
        assert_eq!(
            sys.fake.coordinator_name_of(stranded),
            partner,
            "{}",
            sys.fake.format_log()
        );
        assert!(sys
            .events
            .playback_stopped()
            .iter()
            .any(|(_, ip, _)| *ip == sys.ip(stranded)));
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: a room another cast takes over is never put back by either cast:
/// the first cast's Stop sends it nothing, and the second recorded no old
/// group for it, so its own Stop or a failed start puts it nowhere.
#[tokio::test]
async fn a_room_taken_over_is_put_back_by_neither_cast() {
    within("takeover", async {
        let sys = TestSystem::builder()
            .speakers(["Office", "Kitchen", "Patio"])
            .groups(&[&["Kitchen", "Patio"]])
            .build()
            .await;
        let first = sys.new_stream();
        let second = sys.new_stream();
        let results = sys.start_rooms(&first, &["Office", "Patio"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");

        let results = sys.start_rooms(&second, &["Patio"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert!(sys.session(&first, "Patio").is_none());
        assert!(sys
            .session(&second, "Patio")
            .is_some_and(|s| s.old_group.is_none()));

        let seq = sys.fake.next_seq();
        sys.coordinator().remove_stream_async(&first).await;
        assert!(
            actions(&sys, &sys.fake.calls_since(seq), "Patio").is_empty(),
            "{}",
            sys.fake.format_log()
        );

        let seq = sys.fake.next_seq();
        sys.coordinator().remove_stream_async(&second).await;
        assert!(
            rejoins_since(&sys, seq).is_empty(),
            "{}",
            sys.fake.format_log()
        );
        assert_eq!(sys.fake.coordinator_name_of("Patio"), "Patio");
    })
    .await;
}

/// Proves: a start that took a room from another cast and then failed does
/// not put the room back into that other cast's group.
#[tokio::test]
async fn a_failed_takeover_puts_nothing_back() {
    within("failed takeover", async {
        let sys = TestSystem::builder()
            .speakers(["Office", "Kitchen", "Patio"])
            .groups(&[&["Kitchen", "Patio"]])
            .build()
            .await;
        let first = sys.new_stream();
        let second = sys.new_stream();
        sys.start_rooms(&first, &["Office", "Patio"], None).await;
        sys.fake.fail(&sys.ip("Patio"), "Play", Failure::Fault(800));

        let seq = sys.fake.next_seq();
        let results = sys.start_rooms(&second, &["Patio"], None).await;

        assert!(results.iter().all(|r| !r.success), "{results:?}");
        assert!(
            rejoins_since(&sys, seq).is_empty(),
            "{}",
            sys.fake.format_log()
        );
        assert_ne!(sys.fake.coordinator_name_of("Patio"), "Office");
    })
    .await;
}

/// Proves: at shutdown, putting rooms back is cut off after a few seconds in
/// all, so a speaker that never answers cannot hold the app open.
#[tokio::test]
async fn clear_all_bounds_putting_rooms_back() {
    within("bounded restore", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office"])
            .groups(&[&["Kitchen", "Patio"]])
            .build()
            .await;
        let stream = sys.new_stream();
        sys.start_rooms(&stream, &["Office", "Patio"], None).await;
        sys.fake
            .fail(&sys.ip("Patio"), "SetAVTransportURI", Failure::Hang);

        let started = std::time::Instant::now();
        assert_eq!(sys.coordinator().clear_all().await, 1);

        assert!(
            started.elapsed() < Duration::from_secs(6),
            "took {:?}",
            started.elapsed()
        );
        assert!(sys.sessions().is_empty());
    })
    .await;
}

/// Proves: Stop all casts queued behind a cast start that takes longer than
/// its time budget still stops every room and puts each back: the budget
/// starts once it holds the regroup lock, not while it waits for it.
#[tokio::test]
async fn stop_all_behind_a_slow_cast_still_puts_every_room_back() {
    within("stop all behind a slow cast", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den"])
            .groups(&[&["Den", "Patio"]])
            .build()
            .await;
        let kitchen = sys.ip("Kitchen");
        sys.fake.fail(
            &kitchen,
            "Play",
            Failure::Delay(Duration::from_millis(4500)),
        );
        let stream = sys.new_stream();
        let seq = sys.fake.next_seq();

        let (results, cleared) = tokio::join!(
            sys.start_rooms(&stream, &["Kitchen", "Patio"], None),
            async {
                sys.fake
                    .wait_for_call(seq, |call| call.is(&kitchen, "Play"))
                    .await;
                sys.services.clear_all_streams().await
            }
        );

        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(cleared, 1);
        assert!(sys.sessions().is_empty(), "{:?}", sys.sessions());
        assert!(
            sent(&sys, seq, "Kitchen", "Stop"),
            "{}",
            sys.fake.format_log()
        );
        assert_eq!(
            sys.fake.grouping(),
            names(&[&["Kitchen"], &["Den", "Patio"]]),
            "{}",
            sys.fake.format_log()
        );
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: the queue NOTIFY of the cast's old coordinator, landing while a
/// Remove still hands the cast on, is the companion's own doing and no
/// source change: no session ends with that reason, the cast plays on in
/// the other rooms and the old coordinator goes back to its old group.
#[tokio::test]
async fn a_queue_notify_during_a_promotion_ends_no_session() {
    within("notify mid-promotion", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den", "Hall", "Office", "Attic"])
            .groups(&[
                &["Kitchen", "Patio"],
                &["Den", "Hall"],
                &["Office", "Attic"],
            ])
            .build()
            .await;
        let stream = sys.new_stream();
        let results = sys
            .start_rooms(&stream, &["Kitchen", "Den", "Office"], None)
            .await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(results[0].speaker_ip, sys.ip("Kitchen"));
        let kitchen = sys.ip("Kitchen");
        sys.fake.fail(
            &kitchen,
            "SetAVTransportURI",
            Failure::Delay(Duration::from_millis(400)),
        );
        let queue = format!("x-rincon-queue:{}#0", sys.uuid("Kitchen"));
        let seq = sys.fake.next_seq();

        let (stopped, ()) = tokio::join!(
            sys.coordinator()
                .stop_playback_speaker(&stream, &kitchen, None),
            async {
                sys.fake
                    .wait_for_call(seq, |call| {
                        call.sets_uri_starting_with(&kitchen, "x-rincon-queue:")
                    })
                    .await;
                assert_eq!(
                    sys.fake
                        .notify_av_transport(&kitchen, TransportState::Stopped, &queue)
                        .await,
                    200
                );
            }
        );

        assert_eq!(stopped, std::slice::from_ref(&kitchen));
        let source_changed: Vec<_> = sys
            .events
            .playback_stopped()
            .into_iter()
            .filter(|(_, _, reason)| {
                *reason == Some(crate::events::SpeakerRemovalReason::SourceChanged)
            })
            .collect();
        assert!(source_changed.is_empty(), "{source_changed:?}");
        assert!(sys.coordinator().get_stream(&stream).is_some());
        assert!(sys.session(&stream, "Kitchen").is_none());
        let promoted = sys
            .sessions()
            .into_iter()
            .find(|s| s.role == GroupRole::Coordinator)
            .expect("a promoted coordinator");
        let promoted_name = sys.fake.speaker_at(&promoted.speaker_ip).name.clone();
        for room in ["Office", "Den"] {
            assert!(sys.session(&stream, room).is_some(), "{room}");
            assert_eq!(sys.fake.coordinator_name_of(room), promoted_name, "{room}");
        }
        assert_eq!(
            sys.fake.coordinator_name_of("Kitchen"),
            "Patio",
            "{}",
            sys.fake.format_log()
        );
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: on Stop, the queue NOTIFY of the coordinator the stop itself
/// switched is no source change: no room's session ends with that reason,
/// and every room still goes back.
#[tokio::test]
async fn the_stops_own_queue_notify_is_no_source_change() {
    within("notify mid-stop", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den"])
            .groups(&[&["Den", "Patio"]])
            .build()
            .await;
        let stream = sys.new_stream();
        let results = sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        let kitchen = sys.ip("Kitchen");
        sys.fake.fail(
            &kitchen,
            "SetAVTransportURI",
            Failure::Delay(Duration::from_millis(400)),
        );
        let queue = format!("x-rincon-queue:{}#0", sys.uuid("Kitchen"));
        let seq = sys.fake.next_seq();

        tokio::join!(sys.coordinator().remove_stream_async(&stream), async {
            sys.fake
                .wait_for_call(seq, |call| {
                    call.sets_uri_starting_with(&kitchen, "x-rincon-queue:")
                })
                .await;
            assert_eq!(
                sys.fake
                    .notify_av_transport(&kitchen, TransportState::Stopped, &queue)
                    .await,
                200
            );
        });

        let source_changed: Vec<_> = sys
            .events
            .playback_stopped()
            .into_iter()
            .filter(|(_, _, reason)| {
                *reason == Some(crate::events::SpeakerRemovalReason::SourceChanged)
            })
            .collect();
        assert!(source_changed.is_empty(), "{source_changed:?}");
        assert!(sys.sessions().is_empty(), "{:?}", sys.sessions());
        assert_eq!(sys.fake.coordinator_name_of("Patio"), "Den");
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

// ── Adding rooms to a running cast ─────────────────────────────────────────

/// Proves: a room added to a running cast gets its start level and joins the
/// cast's group, and the coordinator is not touched.
#[tokio::test]
async fn an_added_room_joins_the_running_cast() {
    within("add room", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office", "Den"])
            .build()
            .await;
        let stream = sys.new_stream();
        sys.start_rooms(&stream, &["Kitchen", "Office"], None).await;
        sys.fake.speaker_named("Den").set_volume(72);

        let seq = sys.fake.next_seq();
        let results = sys.start_rooms(&stream, &["Den"], Some(&limit(30))).await;

        assert_eq!(sys.outcome(&results), [("Den".to_string(), true)]);
        assert_eq!(sys.fake.speaker_named("Den").volume(), 30);
        assert_eq!(sys.fake.coordinator_name_of("Den"), "Kitchen");
        let calls = sys.fake.calls_since(seq);
        assert!(
            actions(&sys, &calls, "Kitchen").is_empty(),
            "{}",
            sys.fake.format_log()
        );
        assert!(actions(&sys, &calls, "Office").is_empty());
        let den = actions(&sys, &calls, "Den");
        let set = den.iter().position(|a| a == "SetVolume");
        let join = den.iter().position(|a| a == "Join");
        assert!(set.is_some() && set < join, "{den:?}");
        assert_eq!(
            sys.session(&stream, "Den").map(|s| s.role),
            Some(GroupRole::Slave)
        );
    })
    .await;
}

/// Proves: an added room that leads a playing group of other rooms hands it
/// on (their music restarts), joins the cast, and goes back to that group
/// when it is removed.
#[tokio::test]
async fn an_added_room_that_led_a_group_hands_it_on_and_goes_back() {
    within("add coordinator of a group", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office", "Den"])
            .groups(&[&["Office", "Den"]])
            .build()
            .await;
        sys.fake.play_music("Office", MUSIC);
        let stream = sys.new_stream();
        sys.start_rooms(&stream, &["Kitchen"], None).await;

        let results = sys.start_rooms(&stream, &["Office"], None).await;

        assert_eq!(sys.outcome(&results), [("Office".to_string(), true)]);
        let restarts = sys.fake.restarts();
        assert_eq!(restarts.len(), 1, "{restarts:?}");
        assert_eq!(restarts[0].promoted, "Den");
        assert_eq!(sys.fake.coordinator_name_of("Office"), "Kitchen");
        sys.fake.assert_no_grouped_coordinator_joined();

        let seq = sys.fake.next_seq();
        sys.coordinator()
            .stop_playback_speaker(&stream, &sys.ip("Office"), None)
            .await;
        assert_eq!(
            rejoins_since(&sys, seq),
            [("Office".to_string(), "Den".to_string())]
        );
        assert_eq!(sys.fake.coordinator_name_of("Office"), "Den");
        assert!(sys.session(&stream, "Kitchen").is_some());
    })
    .await;
}

/// Proves: a repeated START_PLAYBACK for the cast's own rooms (a resume)
/// touches no volume and regroups nothing.
#[tokio::test]
async fn a_resume_touches_no_volume_and_moves_nothing() {
    within("resume", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office"])
            .groups(&[&["Kitchen", "Patio"]])
            .build()
            .await;
        let stream = sys.new_stream();
        sys.start_rooms(&stream, &["Office", "Patio"], Some(&limit(30)))
            .await;

        let seq = sys.fake.next_seq();
        let results = sys.start_rooms(&stream, &["Office", "Patio"], None).await;

        assert!(results.iter().all(|r| r.success), "{results:?}");
        let calls = sys.fake.calls_since(seq);
        assert!(
            calls.iter().all(|call| !matches!(
                call.action.as_str(),
                "SetVolume"
                    | "GetVolume"
                    | "BecomeCoordinatorOfStandaloneGroup"
                    | "SetAVTransportURI"
            )),
            "{}",
            sys.fake.format_log()
        );
        assert!(rejoins_since(&sys, seq).is_empty());
    })
    .await;
}

/// Proves: a resume does not pull back a room someone regrouped out of the
/// cast: the room is left where it is and its session ends.
#[tokio::test]
async fn a_resume_does_not_pull_back_a_regrouped_room() {
    within("resume after regroup", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Den"])
            .build()
            .await;
        let stream = sys.new_stream();
        sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;
        sys.fake.regroup_externally("Patio", "Den");

        let seq = sys.fake.next_seq();
        let results = sys.start_rooms(&stream, &["Kitchen", "Patio"], None).await;

        assert_eq!(
            sys.outcome(&results),
            [("Kitchen".to_string(), true), ("Patio".to_string(), false)]
        );
        assert!(!sent(
            &sys,
            seq,
            "Patio",
            "BecomeCoordinatorOfStandaloneGroup"
        ));
        assert!(rejoins_since(&sys, seq).is_empty());
        assert_eq!(sys.fake.coordinator_name_of("Patio"), "Den");
        assert!(sys.session(&stream, "Patio").is_none());
    })
    .await;
}

// ── Older extensions ───────────────────────────────────────────────────────

/// Proves: an older extension's synced start, which names group
/// coordinators, casts every room of those groups as one Sonos group: a
/// coordinator that still has members is never told to join, and Stop
/// leaves the household as it was.
#[tokio::test]
async fn an_older_synced_start_regroups_whole_groups_and_restores_them() {
    within("legacy sync", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office", "Den"])
            .groups(&[&["Office", "Den"]])
            .build()
            .await;
        let stream = sys.new_stream();

        let results = sys.start(&stream, &["Kitchen", "Office"], true).await;

        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert_eq!(results[0].speaker_ip, sys.ip("Office"));
        assert_eq!(sys.fake.coordinator_name_of("Den"), "Office");
        assert_eq!(sys.fake.coordinator_name_of("Kitchen"), "Office");
        sys.fake.assert_no_grouped_coordinator_joined();

        sys.coordinator().remove_stream_async(&stream).await;
        assert_eq!(
            sys.fake.grouping(),
            names(&[&["Den", "Office"], &["Kitchen"]])
        );
    })
    .await;
}

/// Proves: an older extension hears only of the speakers it named, and
/// removing the coordinator it named takes the room that was grouped with it
/// along: that room stays in its group and stops with it, and the rest of the
/// cast plays on.
#[tokio::test]
async fn an_older_extension_hears_of_its_own_speakers_only() {
    within("legacy rows", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office", "Den"])
            .groups(&[&["Office", "Den"]])
            .build()
            .await;
        let stream = sys.new_stream();

        let results = sys.start(&stream, &["Kitchen", "Office"], true).await;

        assert_eq!(
            sys.outcome(&results),
            [("Office".to_string(), true), ("Kitchen".to_string(), true)]
        );

        let seq = sys.fake.next_seq();
        sys.coordinator()
            .stop_playback_speaker(&stream, &sys.ip("Office"), None)
            .await;

        assert!(sys.session(&stream, "Den").is_none());
        assert!(sys.session(&stream, "Office").is_none());
        assert_eq!(
            sys.session(&stream, "Kitchen").map(|s| s.role),
            Some(GroupRole::Coordinator)
        );
        assert_eq!(sys.fake.coordinator_name_of("Den"), "Office");
        assert!(!sent(
            &sys,
            seq,
            "Den",
            "BecomeCoordinatorOfStandaloneGroup"
        ));
        assert!(!sent(&sys, seq, "Den", "SetAVTransportURI"));
        sys.fake.assert_no_grouped_coordinator_joined();
    })
    .await;
}

/// Proves: an older extension's unsynced start still plays an independent
/// stream on each speaker and regroups nothing.
#[tokio::test]
async fn an_older_unsynced_start_plays_independent_streams() {
    within("legacy independent", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .build()
            .await;
        let stream = sys.new_stream();

        let results = sys.start(&stream, &["Kitchen", "Office"], false).await;

        assert!(results.iter().all(|r| r.success), "{results:?}");
        assert!(sys.fake.joins().is_empty());
        assert!(sys
            .sessions()
            .iter()
            .all(|s| s.role == GroupRole::Coordinator));
    })
    .await;
}

/// Proves: a room added to a running cast (it led its own group until it
/// joined) has its own level followed through RenderingControl, and every
/// reading of it is sent to clients marked `own`, so a client keeps it as the
/// room's level when the topology then shows the room no longer leading a
/// group. A group's level (GroupRenderingControl) is never marked.
#[tokio::test]
async fn an_added_room_reports_its_own_level_without_a_notify() {
    // A grouped, playing room already below the start cap joins a cast: its
    // level never changes, so its speaker sends no RenderingControl event
    // after the first, and that first one is lost when it beats the
    // subscribe reply. The companion reads the level itself as the room
    // joins.
    within("added room level without a notify", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office", "Bathroom"])
            .groups(&[&["Bathroom", "Office"]])
            .build()
            .await;
        let office = sys.ip("Office");
        sys.fake.speaker_named("Office").set_volume(23);

        let stream = sys.new_stream();
        let results = sys.start_rooms(&stream, &["Kitchen"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        let results = sys.start_rooms(&stream, &["Office"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");

        let volume = sys
            .events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::GroupVolume { speaker_ip, volume, own: true, .. }
                    if *speaker_ip == office && *volume == 23)
            })
            .await;
        let json = serde_json::to_value(&volume).expect("serialize");
        assert_eq!(json["own"], serde_json::json!(true), "{json}");
        sys.events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::GroupMute { speaker_ip, own: true, .. }
                    if *speaker_ip == office)
            })
            .await;
        assert_eq!(
            sys.services
                .sonos_state
                .group_volumes
                .get(&office)
                .map(|v| *v),
            Some(23)
        );
    })
    .await;
}

#[tokio::test]
async fn an_added_room_sends_its_own_level_marked_as_its_own() {
    within("added room level", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .build()
            .await;
        let (kitchen, office) = (sys.ip("Kitchen"), sys.ip("Office"));

        // Office stands alone: its level is its group's, and not its own.
        assert_eq!(
            sys.fake.notify_group_rendering(&office, 60, false).await,
            200
        );
        let group = sys
            .events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::GroupVolume { speaker_ip, volume, .. }
                    if *speaker_ip == office && *volume == 60)
            })
            .await;
        let json = serde_json::to_value(&group).expect("serialize");
        assert!(
            json.get("own").is_none(),
            "a group's level is not marked: {json}"
        );

        let stream = sys.new_stream();
        let results = sys.start_rooms(&stream, &["Kitchen"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        // Add a room: Office joins the cast's group.
        let results = sys.start_rooms(&stream, &["Office"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");

        for ip in [&kitchen, &office] {
            assert!(
                sys.fake
                    .subscription(ip, SonosService::RenderingControl)
                    .is_some(),
                "{ip} has its own level followed"
            );
        }

        assert_eq!(
            sys.fake.notify_rendering_control(&office, 14, true).await,
            200
        );
        let volume = sys
            .events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::GroupVolume { speaker_ip, volume, .. }
                    if *speaker_ip == office && *volume == 14)
            })
            .await;
        let mute = sys
            .events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::GroupMute { speaker_ip, muted, .. }
                    if *speaker_ip == office && *muted)
            })
            .await;
        for event in [volume, mute] {
            let json = serde_json::to_value(&event).expect("serialize");
            assert_eq!(json["own"], serde_json::json!(true), "{json}");
        }
        assert_eq!(
            sys.services
                .sonos_state
                .group_volumes
                .get(&office)
                .map(|v| *v),
            Some(14)
        );
    })
    .await;
}

/// Proves: a cast to one room has that room's own level read and sent to
/// clients marked `own`, with no event from the speaker, and followed after:
/// a room that leaves its Sonos group to play alone (it has no level of its
/// own on record, its group's was its coordinator's) and a room standing
/// alone whose first event was lost would otherwise show none for as long as
/// it plays.
#[tokio::test]
async fn a_cast_to_one_room_reports_its_own_level_without_a_notify() {
    within("one room level without a notify", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office", "Bathroom"])
            .groups(&[&["Bathroom", "Office"]])
            .build()
            .await;
        sys.fake.speaker_named("Office").set_volume(23);
        sys.fake.speaker_named("Kitchen").set_volume(17);

        for (room, level) in [("Office", 23), ("Kitchen", 17)] {
            let ip = sys.ip(room);
            assert!(sys.services.sonos_state.group_volumes.get(&ip).is_none());
            let stream = sys.new_stream();
            let results = sys.start_rooms(&stream, &[room], None).await;
            assert!(results.iter().all(|r| r.success), "{results:?}");

            sys.events
                .wait_for_sonos(|event| {
                    matches!(event, SonosEvent::GroupVolume { speaker_ip, volume, own: true, .. }
                        if *speaker_ip == ip && *volume == level)
                })
                .await;
            sys.events
                .wait_for_sonos(|event| {
                    matches!(event, SonosEvent::GroupMute { speaker_ip, own: true, .. }
                        if *speaker_ip == ip)
                })
                .await;
            assert!(
                sys.fake
                    .subscription(&ip, SonosService::RenderingControl)
                    .is_some(),
                "{room} has its own level followed"
            );
        }
    })
    .await;
}

/// Proves: a room whose source changes leaves the cast's sync session even
/// when no room follows it (a cast to one room, or a room that followed the
/// cast): its own level stops being followed and its group's is followed
/// again, so the next cast that takes it reads its level afresh.
#[tokio::test]
async fn a_room_switched_to_other_music_leaves_the_sync_session() {
    within("source change leaves sync", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office", "Den"])
            .build()
            .await;
        let solo = sys.new_stream();
        let pair = sys.new_stream();
        assert!(sys.start_rooms(&solo, &["Kitchen"], None).await[0].success);
        let results = sys.start_rooms(&pair, &["Office", "Den"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");
        let follower = sys
            .sessions()
            .into_iter()
            .find(|s| s.stream_id == pair && s.role == GroupRole::Slave)
            .expect("a room following the pair's coordinator")
            .speaker_ip;

        for ip in [sys.ip("Kitchen"), follower] {
            assert!(sys
                .fake
                .subscription(&ip, SonosService::RenderingControl)
                .is_some());
            sys.coordinator().handle_source_changed(&ip);
            for _ in 0..100 {
                if sys
                    .fake
                    .subscription(&ip, SonosService::RenderingControl)
                    .is_none()
                    && sys
                        .fake
                        .subscription(&ip, SonosService::GroupRenderingControl)
                        .is_some()
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
            assert!(
                sys.fake
                    .subscription(&ip, SonosService::RenderingControl)
                    .is_none(),
                "{ip} no longer has its own level followed\n{}",
                sys.fake.format_log()
            );
            assert!(sys
                .fake
                .subscription(&ip, SonosService::GroupRenderingControl)
                .is_some());
        }
    })
    .await;
}

/// Proves: a room whose level cannot be read the moment it joins (a speaker
/// still settling into its new group can fault one request) is asked again,
/// so its level still reaches clients with no event from it.
#[tokio::test]
async fn a_joining_room_whose_level_read_fails_once_is_asked_again() {
    within("own level read retried", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .build()
            .await;
        let office = sys.ip("Office");
        sys.fake.speaker_named("Office").set_volume(21);
        sys.fake.fail(&office, "GetVolume", Failure::FaultOnce(701));

        let stream = sys.new_stream();
        let results = sys.start_rooms(&stream, &["Kitchen", "Office"], None).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");

        sys.events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::GroupVolume { speaker_ip, volume, own: true, .. }
                    if *speaker_ip == office && *volume == 21)
            })
            .await;
    })
    .await;
}
