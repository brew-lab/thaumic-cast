//! The household's route, against the fake household: UPnP switched off is
//! found on the local Control API, the route moves back when UPnP comes back
//! on, holds while a cast is live on port 1443, and is lost when
//! Authentication is on.

use crate::sonos::lan::protocol::code;
use crate::sonos::soap::SoapError;
use crate::sonos::Route;

use super::fake_sonos::FAKE_HOUSEHOLD_ID;
use super::harness::{within, TestSystem};

/// How many GENA subscriptions the household has been asked for so far.
fn subscribes(sys: &TestSystem) -> usize {
    sys.fake
        .calls()
        .iter()
        .filter(|call| call.action == "SUBSCRIBE")
        .count()
}

/// Proves: with UPnP off from the start, the household is found on port
/// 1443: the first connection asks the player discovery named for its
/// description, with no household yet; every command then carries the
/// household it gave; and no GENA subscription is ever asked for.
#[tokio::test]
async fn with_upnp_off_the_household_is_found_on_port_1443() {
    within("detection", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Patio", "Office"])
            .groups(&[&["Kitchen", "Patio"]])
            .route(Route::Lan)
            .build()
            .await;

        assert_eq!(sys.route(), Route::Lan);
        let groups = sys.services.sonos_state.groups.read().clone();
        assert_eq!(groups.len(), 2, "{groups:#?}");

        let expected = sys.lan.expected.lock().clone();
        let (first_ip, first) = &expected[0];
        assert_eq!(first_ip, &sys.ip("Kitchen"));
        assert_eq!(first.player_id, sys.uuid("Kitchen"));
        assert_eq!(first.household_id, None);
        assert!(expected[1..]
            .iter()
            .all(|(_, e)| e.household_id.as_deref() == Some(FAKE_HOUSEHOLD_ID)));

        let calls = sys.fake.lan_calls();
        assert_eq!(
            (calls[0].speaker_ip.as_str(), calls[0].command.as_str()),
            (sys.ip("Kitchen").as_str(), "getGroups")
        );
        assert!(calls
            .iter()
            .all(|c| c.household_id.as_deref() == Some(FAKE_HOUSEHOLD_ID)));
        // Reads, and the volume subscriptions they keep: nothing that plays.
        assert!(calls
            .iter()
            .all(|c| c.command == "getGroups" || c.command == "subscribe"));
        assert_eq!(subscribes(&sys), 0, "{}", sys.fake.format_log());
    })
    .await;
}

/// Proves: UPnP switched off on a household found on UPnP moves it to port
/// 1443 at the next refresh, and switched back on moves it back.
#[tokio::test]
async fn the_route_follows_the_upnp_switch() {
    within("switch", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .build()
            .await;
        assert_eq!(sys.route(), Route::Upnp);
        assert!(sys.fake.lan_calls().is_empty());

        sys.fake.set_upnp_enabled(false);
        sys.refresh_topology().await;
        assert_eq!(sys.route(), Route::Lan);
        assert_eq!(sys.services.sonos_state.groups.read().len(), 2);

        sys.fake.set_upnp_enabled(true);
        sys.refresh_topology().await;
        assert_eq!(sys.route(), Route::Upnp);
    })
    .await;
}

/// Proves: while a cast is live on port 1443 the household stays there when
/// UPnP comes back on, without even asking port 1400; once nothing is live
/// it moves back to UPnP and its coordinators are subscribed.
#[tokio::test]
async fn a_live_cast_on_port_1443_holds_the_route() {
    within("hold", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .route(Route::Lan)
            .build()
            .await;
        let hold = sys.services.route.hold();

        sys.fake.set_upnp_enabled(true);
        let seq = sys.fake.next_seq();
        sys.refresh_topology().await;
        assert_eq!(sys.route(), Route::Lan);
        assert!(
            sys.fake.calls_since(seq).is_empty(),
            "{}",
            sys.fake.format_log()
        );

        drop(hold);
        sys.refresh_topology().await;
        assert_eq!(sys.route(), Route::Upnp);
        for room in ["Kitchen", "Office"] {
            assert!(
                sys.fake
                    .calls()
                    .iter()
                    .any(|c| c.is(&sys.ip(room), "SUBSCRIBE")
                        && c.service == crate::sonos::SonosService::AVTransport),
                "{room} not subscribed:\n{}",
                sys.fake.format_log()
            );
        }
    })
    .await;
}

/// Proves: Authentication switched on leaves the household with no route,
/// and a refresh fails as UPnP switched off, the fix for both; once it is
/// off again the household is learnt afresh and found on port 1443.
#[tokio::test]
async fn authentication_on_leaves_no_route_until_it_is_off() {
    within("authentication", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen"])
            .route(Route::Lan)
            .build()
            .await;

        sys.fake.set_lan_authentication(true);
        let refused = sys.try_refresh_topology().await;
        assert!(refused.is_err());
        assert_eq!(sys.route(), Route::None);

        sys.fake.set_lan_authentication(false);
        sys.refresh_topology().await;
        assert_eq!(sys.route(), Route::Lan);
        let descriptions = sys
            .lan
            .expected
            .lock()
            .iter()
            .filter(|(_, e)| e.household_id.is_none())
            .count();
        assert_eq!(descriptions, 2, "the household is asked for again");
    })
    .await;
}

/// Proves: on port 1443 a call that route does not carry out yet is refused
/// there, never sent to port 1400 to be refused again.
#[tokio::test]
async fn on_port_1443_a_call_not_carried_out_is_refused_without_upnp() {
    within("unsupported", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen"])
            .route(Route::Lan)
            .build()
            .await;
        let seq = sys.fake.next_seq();

        match sys
            .services
            .sonos
            .join_group(&sys.ip("Kitchen"), "RINCON_OTHER")
            .await
        {
            Err(SoapError::Lan { code: c, .. }) => assert_eq!(c, code::UNSUPPORTED),
            other => panic!("unexpected {other:?}"),
        }
        assert!(sys.fake.calls_since(seq).is_empty());
    })
    .await;
}
