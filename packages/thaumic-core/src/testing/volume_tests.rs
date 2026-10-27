//! Volume and mute against the fake household on each route: each room's
//! own level, each group's level, the start level, and the levels the
//! speakers report reaching the services.

use std::collections::HashMap;
use std::time::Duration;

use crate::events::SonosEvent;
use crate::services::start_volume::StartVolumeRequest;
use crate::sonos::Route;

use super::fake_sonos::Failure;
use super::harness::{both_routes, within, TestSystem};

fn limit(level: u8) -> StartVolumeRequest {
    StartVolumeRequest {
        limit: Some(level),
        rooms: HashMap::new(),
    }
}

/// The action a room's level is read with on `route`, for injecting a
/// failure into it.
fn read_volume_action(route: Route) -> &'static str {
    match route {
        Route::Lan => "playerVolume:1 getVolume",
        _ => "GetVolume",
    }
}

/// Fails the test if a call went to the route the household is not on.
fn assert_only_on(sys: &TestSystem, route: Route, soap_from: usize) {
    match route {
        Route::Lan => assert!(
            sys.fake.calls_since(soap_from).is_empty(),
            "{}",
            sys.fake.format_log()
        ),
        _ => assert!(sys.fake.lan_calls().is_empty()),
    }
}

both_routes! {
/// Proves: a room's own level and mute and a group's level and mute are
/// read and set through the household's route, on the room or the group's
/// coordinator, and nothing goes to the other route.
async fn each_room_and_each_group_is_set_through_its_route(route) {
    within("volume", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Dining Room", "Office"])
            .groups(&[&["Kitchen", "Dining Room"]])
            .route(route)
            .build()
            .await;
        let sonos = sys.services.sonos.as_ref();
        let kitchen = sys.ip("Kitchen");
        let dining = sys.ip("Dining Room");
        let office = sys.ip("Office");
        let kitchen_before = sys.fake.speaker_named("Kitchen").volume();
        let seq = sys.fake.next_seq();

        sonos.set_speaker_volume(&dining, 33).await.expect("room level");
        assert_eq!(sys.fake.speaker_named("Dining Room").volume(), 33);
        assert_eq!(sonos.get_speaker_volume(&dining).await.unwrap(), 33);
        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), kitchen_before);

        sonos.set_speaker_mute(&office, true).await.expect("room mute");
        assert!(sys.fake.speaker_named("Office").muted());
        assert!(sonos.get_speaker_mute(&office).await.unwrap());
        assert!(!sonos.get_speaker_output_fixed(&office).await.unwrap());

        sonos.set_group_volume(&kitchen, 40).await.expect("group level");
        assert_eq!(sys.fake.speaker_named("Kitchen").group_volume(), 40);
        assert_eq!(sonos.get_group_volume(&kitchen).await.unwrap(), 40);
        sonos.set_group_mute(&kitchen, true).await.expect("group mute");
        assert!(sonos.get_group_mute(&kitchen).await.unwrap());

        assert_only_on(&sys, route, seq);
    })
    .await;
}
}

both_routes! {
/// Proves: before a cast, each room is turned down to the limit on its own
/// through the household's route, a quiet room is left alone, and a fixed
/// output is never set.
async fn the_start_level_is_set_room_by_room_through_its_route(route) {
    within("start level", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Dining Room", "Port"])
            .groups(&[&["Kitchen", "Dining Room"]])
            .route(route)
            .build()
            .await;
        sys.fake.speaker_named("Kitchen").set_volume(72);
        sys.fake.speaker_named("Dining Room").set_volume(20);
        sys.fake.speaker_named("Port").set_output_fixed(true);
        let seq = sys.fake.next_seq();
        let stream = sys.new_stream();
        let ips: Vec<String> = ["Kitchen", "Port"].iter().map(|n| sys.ip(n)).collect();

        sys.coordinator()
            .apply_start_volume(sys.services.sonos.as_ref(), &stream, &ips, &limit(30))
            .await;

        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 30);
        assert_eq!(sys.fake.speaker_named("Dining Room").volume(), 20);
        assert_eq!(sys.fake.speaker_named("Port").volume(), 100);
        assert_only_on(&sys, route, seq);
        if route == Route::Lan {
            // One set, on the loud room's own level.
            let sets: Vec<(String, serde_json::Value)> = sys
                .fake
                .lan_calls()
                .into_iter()
                .filter(|c| c.command == "setVolume")
                .map(|c| (c.namespace, c.body))
                .collect();
            assert_eq!(
                sets,
                [("playerVolume:1".to_string(), serde_json::json!({ "volume": 30 }))]
            );
        }
    })
    .await;
}
}

both_routes! {
/// Proves: a room whose level cannot be read starts at the limit.
async fn a_room_that_cannot_be_read_starts_at_the_limit(route) {
    within("unreadable room", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen"])
            .route(route)
            .build()
            .await;
        sys.fake.speaker_named("Kitchen").set_volume(10);
        sys.fake
            .fail(&sys.ip("Kitchen"), read_volume_action(route), Failure::Fault(501));
        let stream = sys.new_stream();

        sys.coordinator()
            .apply_start_volume(
                sys.services.sonos.as_ref(),
                &stream,
                &[sys.ip("Kitchen")],
                &limit(30),
            )
            .await;

        assert_eq!(sys.fake.speaker_named("Kitchen").volume(), 30);
    })
    .await;
}
}

/// Proves: on port 1443 a group's level the speakers push reaches the
/// services as GENA's would, and a room's own level, which counts only for
/// a room in a sync session, does not.
#[tokio::test]
async fn on_port_1443_pushed_levels_reach_the_services_from_the_source_that_counts() {
    within("pushed levels", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Dining Room"])
            .groups(&[&["Kitchen", "Dining Room"]])
            .route(Route::Lan)
            .build()
            .await;
        let kitchen = sys.ip("Kitchen");

        sys.fake.change_volume_in_app("Dining Room", 12);
        sys.fake.change_group_volume_in_app("Kitchen", 44);
        sys.events
            .wait_for_sonos(|e| {
                matches!(e, SonosEvent::GroupVolume { speaker_ip, volume: 44, own: false, .. }
                    if *speaker_ip == kitchen)
            })
            .await;
        // Processed in order: the level reached the cache, and the room's
        // own one before it went nowhere.
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert_eq!(
            sys.services
                .sonos_state
                .group_volumes
                .get(&kitchen)
                .map(|v| *v),
            Some(44)
        );
        assert!(!sys.events.sonos_events().iter().any(|e| matches!(
            e,
            SonosEvent::GroupVolume { own: true, .. } | SonosEvent::GroupMute { own: true, .. }
        )));
        // Every room's own level and every group's level was subscribed.
        let subscribes: Vec<(String, Option<String>)> = sys
            .fake
            .lan_calls()
            .into_iter()
            .filter(|c| c.command == "subscribe")
            .map(|c| (c.namespace, c.target))
            .collect();
        // Each room's own level, the group's level, and the household's
        // groups.
        assert_eq!(subscribes.len(), 4, "{subscribes:?}");
        assert!(subscribes.contains(&("groups:1".to_string(), None)));
        assert!(subscribes.contains(&(
            "groupVolume:1".to_string(),
            Some(format!("{}:1", sys.uuid("Kitchen")))
        )));
    })
    .await;
}
