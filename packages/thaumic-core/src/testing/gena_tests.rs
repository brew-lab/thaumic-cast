//! GENA subscribe, renew, rebuild and NOTIFY handling, end to end: the real
//! GENA client subscribes to the fakes, and the fakes push NOTIFYs to the real
//! router, through the real parsers and event processor.
//!
//! Real clock throughout. The renewal check would be the natural paused-clock
//! test, but the subscription store keeps expiry as a `std::time::Instant`,
//! which a paused tokio clock does not move; instead the fake grants a
//! lifetime shorter than the renewal buffer, so the first renewal check finds
//! the subscription due.

use crate::events::{SonosEvent, SpeakerRemovalReason, StreamEvent};
use crate::sonos::services::SonosService;
use crate::sonos::types::TransportState;

use super::fake_sonos::Call;
use super::harness::{within, TestSystem};

/// Proves: seeding the topology subscribes ZoneGroupTopology on the first
/// speaker and AVTransport plus GroupRenderingControl on every coordinator,
/// each SUBSCRIBE naming the real listener's callback URL.
#[tokio::test]
async fn reconciling_the_topology_subscribes_with_the_callback_url() {
    within("subscribe", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .build()
            .await;
        let (kitchen, office) = (sys.ip("Kitchen"), sys.ip("Office"));
        let callback = format!("<{}>", sys.services.network.gena_callback_url());

        let subscribes: Vec<Call> = sys
            .fake
            .calls()
            .into_iter()
            .filter(|call| call.action == "SUBSCRIBE")
            .collect();
        assert!(
            subscribes
                .iter()
                .all(|call| call.arg("CALLBACK") == Some(callback.as_str())),
            "{subscribes:?}"
        );
        let has = |ip: &str, service: SonosService| {
            subscribes
                .iter()
                .any(|call| call.speaker_ip == ip && call.service == service)
        };
        assert!(has(&kitchen, SonosService::ZoneGroupTopology));
        for ip in [&kitchen, &office] {
            assert!(has(ip, SonosService::AVTransport), "{ip} AVTransport");
            assert!(
                has(ip, SonosService::GroupRenderingControl),
                "{ip} GroupRenderingControl"
            );
            assert!(sys
                .services
                .discovery_service
                .gena_manager()
                .is_subscribed(ip, SonosService::AVTransport));
        }
        assert_eq!(sys.fake.subscriptions().len(), 5);
    })
    .await;
}

/// Proves: an AVTransport NOTIFY that still names our stream updates the
/// cached transport state without touching the session, and one that names
/// a foreign source raises `SourceChanged`, removes the session with
/// `SourceChanged` as the reason, and ends the stream.
#[tokio::test]
async fn a_foreign_track_uri_ends_the_session_as_a_source_change() {
    within("source change", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();
        assert!(sys.start(&stream, &["Kitchen"], false).await[0].success);

        // Still ours: the speaker reports the URI it was given.
        let ours = sys.fake.speaker_named("Kitchen").current_uri();
        assert_eq!(
            sys.fake
                .notify_av_transport(&kitchen, TransportState::Playing, &ours)
                .await,
            200
        );
        sys.events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::TransportState { speaker_ip, state, .. }
                    if *speaker_ip == kitchen && *state == TransportState::Playing)
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
        assert!(sys.session(&stream, "Kitchen").is_some());
        assert!(!sys
            .events
            .sonos_events()
            .iter()
            .any(|event| matches!(event, SonosEvent::SourceChanged { .. })));

        // Someone picked Spotify on the speaker.
        let foreign = "x-sonos-spotify:spotify%3atrack%3a4uLU6hMCjMI75M1A2tKUQC?sid=12&flags=8224";
        assert_eq!(
            sys.fake
                .notify_av_transport(&kitchen, TransportState::Playing, foreign)
                .await,
            200
        );
        let changed = sys
            .events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::SourceChanged { speaker_ip, .. } if *speaker_ip == kitchen)
            })
            .await;
        match changed {
            SonosEvent::SourceChanged {
                current_uri,
                expected_uri,
                ..
            } => {
                assert_eq!(current_uri, foreign);
                assert_eq!(expected_uri, Some(sys.speaker_uri(&stream)));
            }
            other => panic!("unexpected {other:?}"),
        }
        sys.events
            .wait_for_stream(|event| {
                matches!(event, StreamEvent::PlaybackStopped { stream_id, speaker_ip, reason, .. }
                    if *stream_id == stream
                        && *speaker_ip == kitchen
                        && *reason == Some(SpeakerRemovalReason::SourceChanged))
            })
            .await;
        sys.events
            .wait_for_stream(|event| {
                matches!(event, StreamEvent::Ended { stream_id, .. } if *stream_id == stream)
            })
            .await;
        assert!(sys.sessions().is_empty());
        assert!(sys.coordinator().get_stream(&stream).is_none());
    })
    .await;
}

/// Proves: the renewal task renews a subscription that is inside the renewal
/// buffer with a SUBSCRIBE carrying the SID alone — no CALLBACK — as
/// hardware expects.
#[tokio::test]
async fn a_subscription_inside_the_renewal_buffer_is_renewed_by_sid() {
    within("renewal", async {
        // Granted 60s: inside the 300s buffer, so the first check renews it.
        let sys = TestSystem::builder()
            .speakers(["Kitchen"])
            .gena_timeout_secs(60)
            .build()
            .await;
        let kitchen = sys.ip("Kitchen");
        let sid = sys
            .fake
            .subscription(&kitchen, SonosService::AVTransport)
            .expect("AVTransport subscription")
            .sid;
        let from = sys.fake.next_seq();

        sys.services.discovery_service.start_renewal_task();

        let renew = sys
            .fake
            .wait_for_call(from, |call| {
                call.action == "RENEW"
                    && call.speaker_ip == kitchen
                    && call.service == SonosService::AVTransport
            })
            .await;
        assert_eq!(renew.arg("SID"), Some(sid.as_str()));
        assert_eq!(renew.arg("CALLBACK"), None, "a renewal carries no callback");
        assert_eq!(renew.arg("TIMEOUT"), Some("Second-3600"));
        assert!(
            sys.fake
                .subscription(&kitchen, SonosService::AVTransport)
                .is_some(),
            "the fake still holds it"
        );
    })
    .await;
}

/// Proves: after the advertised address changes, the next topology refresh
/// unsubscribes every subscription built against the old callback URL and
/// subscribes afresh with the new one, UNSUBSCRIBE before SUBSCRIBE.
#[tokio::test]
async fn an_address_change_rebuilds_subscriptions_against_the_new_callback() {
    within("callback rebuild", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let kitchen = sys.ip("Kitchen");
        let old_callback = sys.services.network.gena_callback_url();
        let old_sids: Vec<String> = sys
            .fake
            .subscriptions()
            .into_iter()
            .map(|sub| sub.sid)
            .collect();
        assert_eq!(old_sids.len(), 3);
        let from = sys.fake.next_seq();

        sys.services.network.set_local_ip("127.0.0.9".to_string());
        let new_callback = sys.services.network.gena_callback_url();
        assert_ne!(new_callback, old_callback);
        sys.refresh_topology().await;

        let calls = sys.fake.calls_since(from);
        for service in [
            SonosService::ZoneGroupTopology,
            SonosService::AVTransport,
            SonosService::GroupRenderingControl,
        ] {
            let unsubscribe = calls
                .iter()
                .find(|call| {
                    call.action == "UNSUBSCRIBE"
                        && call.service == service
                        && call
                            .arg("SID")
                            .is_some_and(|sid| old_sids.contains(&sid.to_string()))
                })
                .unwrap_or_else(|| {
                    panic!(
                        "UNSUBSCRIBE {} of a stale SID\n{}",
                        service.name(),
                        sys.fake.format_log()
                    )
                });
            let subscribe = calls
                .iter()
                .find(|call| {
                    call.action == "SUBSCRIBE"
                        && call.service == service
                        && call.arg("CALLBACK") == Some(format!("<{new_callback}>").as_str())
                })
                .unwrap_or_else(|| {
                    panic!(
                        "SUBSCRIBE {} with the new callback\n{}",
                        service.name(),
                        sys.fake.format_log()
                    )
                });
            assert!(
                unsubscribe.seq < subscribe.seq,
                "{}: the stale subscription is dropped before its replacement is made",
                service.name()
            );
        }

        let subscriptions = sys.fake.subscriptions();
        assert_eq!(subscriptions.len(), 3);
        assert!(subscriptions
            .iter()
            .all(|sub| sub.callback_url == new_callback && !old_sids.contains(&sub.sid)));
        assert!(sys
            .services
            .discovery_service
            .gena_manager()
            .is_subscribed(&kitchen, SonosService::AVTransport));
    })
    .await;
}

/// Proves: the fake's other NOTIFY bodies parse through the real parsers —
/// a GroupRenderingControl NOTIFY updates the cached group volume and mute,
/// and a ZoneGroupTopology NOTIFY yields `ZoneGroupsUpdated` with the
/// household's groups.
#[tokio::test]
async fn volume_and_topology_notifies_reach_state_and_clients() {
    within("notifies", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .build()
            .await;
        let kitchen = sys.ip("Kitchen");

        assert_eq!(
            sys.fake.notify_group_rendering(&kitchen, 33, true).await,
            200
        );
        sys.events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::GroupMute { speaker_ip, muted, .. }
                    if *speaker_ip == kitchen && *muted)
            })
            .await;
        assert_eq!(
            sys.services
                .sonos_state
                .group_volumes
                .get(&kitchen)
                .map(|v| *v),
            Some(33)
        );
        assert_eq!(
            sys.services
                .sonos_state
                .group_mutes
                .get(&kitchen)
                .map(|m| *m),
            Some(true)
        );

        assert_eq!(sys.fake.notify_zone_group_topology().await, 200);
        let updated = sys
            .events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::ZoneGroupsUpdated { groups, .. } if groups.len() == 2)
            })
            .await;
        match updated {
            SonosEvent::ZoneGroupsUpdated { groups, .. } => {
                let names: Vec<String> = groups.iter().map(|g| g.name.clone()).collect();
                assert_eq!(names, ["Kitchen", "Office"]);
                assert_eq!(groups[0].coordinator_ip, kitchen);
                assert_eq!(groups[0].coordinator_uuid, sys.uuid("Kitchen"));
            }
            other => panic!("unexpected {other:?}"),
        }
    })
    .await;
}
