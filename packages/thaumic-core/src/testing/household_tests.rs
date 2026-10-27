//! The fake household's grouping model, checked against the crate's real
//! parsers and Sonos client: pre-grouped rooms, home-theatre satellites,
//! a coordinator leaving its group, joins, and regrouping from outside.
//!
//! Reading the groups runs on both routes. Joins, leaves and topology events
//! are on UPnP only until port 1443 carries them.

use crate::events::SonosEvent;
use crate::sonos::types::TransportState;
use crate::sonos::Route;

use super::harness::{both_routes, within, TestSystem};

const MUSIC: &str = "x-sonos-spotify:spotify%3atrack%3a1";

both_routes! {
/// Proves: a household built pre-grouped, with a home theatre, reads back
/// through the real parser of its route as those groups. On UPnP the
/// satellites are marked invisible inside their primary's group; `getGroups`
/// lists a room, not its satellites.
async fn a_pre_grouped_household_reads_back_as_its_groups(route) {
    within("pre-grouped", async {
        let sys = TestSystem::builder()
            .speakers([
                "Kitchen",
                "Patio",
                "Living Room",
                "Living Room Sub",
                "Office",
            ])
            .groups(&[&["Kitchen", "Patio"]])
            .home_theatre("Living Room", &["Living Room Sub"])
            .route(route)
            .build()
            .await;
        assert_eq!(sys.route(), route);

        let groups = sys.services.sonos_state.groups.read().clone();
        assert_eq!(groups.len(), 3, "{groups:#?}");
        let kitchen = groups
            .iter()
            .find(|g| g.coordinator_uuid == sys.uuid("Kitchen"))
            .expect("the Kitchen group");
        let names: Vec<&str> = kitchen
            .members
            .iter()
            .map(|m| m.zone_name.as_str())
            .collect();
        assert_eq!(names, ["Kitchen", "Patio"]);

        let living = groups
            .iter()
            .find(|g| g.coordinator_uuid == sys.uuid("Living Room"))
            .expect("the Living Room group");
        assert_eq!(living.coordinator_ip, sys.ip("Living Room"));
        if route == Route::Upnp {
            assert_eq!(living.members.len(), 2);
            let sub = living
                .members
                .iter()
                .find(|m| m.uuid == sys.uuid("Living Room Sub"))
                .expect("the satellite");
            assert!(sub.invisible);
            assert_eq!(sub.zone_name, "Living Room");
        } else {
            assert_eq!(living.members.len(), 1);
        }
        assert_eq!(
            sys.fake.grouping(),
            [
                vec!["Kitchen".to_string(), "Patio".to_string()],
                vec!["Living Room".to_string()],
                vec!["Office".to_string()],
            ]
        );
    })
    .await;
}
}

/// Proves: when a playing group's coordinator leaves, its first member is
/// promoted with the group's track and transport, the rest follow it, and
/// the track is recorded as restarted; a member leaving promotes nobody.
#[tokio::test]
async fn a_coordinator_leaving_promotes_its_first_member() {
    within("promotion", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Dining Room"])
            .groups(&[&["Kitchen", "Patio", "Dining Room"]])
            .build()
            .await;
        sys.fake.play_music("Kitchen", MUSIC);

        sys.services
            .sonos
            .leave_group(&sys.ip("Kitchen"))
            .await
            .expect("leave");

        let patio = sys.fake.speaker_named("Patio");
        assert_eq!(patio.coordinator_uuid(), sys.uuid("Patio"));
        assert_eq!(patio.current_uri(), MUSIC);
        assert_eq!(patio.transport_state(), TransportState::Playing);
        assert_eq!(sys.fake.coordinator_name_of("Dining Room"), "Patio");
        assert_eq!(sys.fake.coordinator_name_of("Kitchen"), "Kitchen");
        let restarts = sys.fake.restarts();
        assert_eq!(restarts.len(), 1, "{restarts:?}");
        assert_eq!(restarts[0].promoted, "Patio");
        assert_eq!(restarts[0].left, "Kitchen");
        assert_eq!(restarts[0].uri, MUSIC);

        sys.services
            .sonos
            .leave_group(&sys.ip("Dining Room"))
            .await
            .expect("leave");
        assert_eq!(sys.fake.restarts().len(), 1);
        assert_eq!(
            sys.fake.speaker_named("Patio").transport_state(),
            TransportState::Playing
        );
    })
    .await;
}

/// Proves: a join takes on the group's transport at once with no Play, and
/// each join records how many speakers followed the joining one.
#[tokio::test]
async fn a_join_plays_with_the_group_and_records_its_followers() {
    within("join", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office", "Den"])
            .groups(&[&["Office", "Den"]])
            .build()
            .await;
        sys.fake.play_music("Kitchen", MUSIC);

        sys.services
            .sonos
            .join_group(&sys.ip("Patio"), &sys.uuid("Kitchen"))
            .await
            .expect("join");
        assert_eq!(
            sys.fake.speaker_named("Patio").transport_state(),
            TransportState::Playing
        );

        sys.fake.assert_no_grouped_coordinator_joined();

        // The case the regroup never sends: a coordinator with a member.
        sys.services
            .sonos
            .join_group(&sys.ip("Office"), &sys.uuid("Kitchen"))
            .await
            .expect("join");
        let joins = sys.fake.joins();
        assert_eq!(joins.len(), 2, "{joins:?}");
        assert!(joins
            .iter()
            .all(|join| join.coordinator_uuid == sys.uuid("Kitchen")));
        assert_eq!(
            (joins[0].speaker_name.as_str(), joins[0].followers),
            ("Patio", 0)
        );
        assert_eq!(
            (joins[1].speaker_name.as_str(), joins[1].followers),
            ("Office", 1)
        );
    })
    .await;
}

/// Proves: a regroup made from outside reaches the services through a
/// ZoneGroupTopology NOTIFY.
#[tokio::test]
async fn a_regroup_from_outside_reaches_the_services() {
    within("external regroup", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio"])
            .build()
            .await;

        sys.fake.regroup_externally("Patio", "Kitchen");
        assert_eq!(sys.fake.notify_zone_group_topology().await, 200);
        sys.events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::ZoneGroupsUpdated { groups, .. } if groups.len() == 1)
            })
            .await;

        sys.fake.make_standalone_externally("Patio");
        assert_eq!(sys.fake.grouping().len(), 2);
    })
    .await;
}
