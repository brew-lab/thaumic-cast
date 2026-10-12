//! A second cast taking a room from a running one, end to end against the
//! fake household: the first cast plays on in the rooms it keeps, whether the
//! room taken led it or followed it. Each scenario runs many times over, as
//! the bug it guards came and went with timing.

use crate::events::{SonosEvent, SpeakerRemovalReason, StreamEvent};
use crate::services::GroupRole;
use crate::sonos::services::SonosService;
use crate::sonos::types::TransportState;

use super::harness::{within, TestSystem};

/// How many times each scenario runs.
const ROUNDS: usize = 12;

/// The rooms `stream_id` holds a session on, by name, with the one leading
/// it first.
fn cast_rooms(sys: &TestSystem, stream_id: &str) -> Vec<String> {
    let mut sessions: Vec<_> = sys
        .sessions()
        .into_iter()
        .filter(|s| s.stream_id == stream_id)
        .collect();
    sessions.sort_by_key(|s| s.role != GroupRole::Coordinator);
    sessions
        .iter()
        .map(|s| sys.fake.speaker_at(&s.speaker_ip).name.clone())
        .collect()
}

/// The `PlaybackStopped` events for `stream_id`, as `(room, reason)`.
fn stops(sys: &TestSystem, stream_id: &str) -> Vec<(String, Option<SpeakerRemovalReason>)> {
    sys.events
        .playback_stopped()
        .into_iter()
        .filter(|(id, _, _)| id == stream_id)
        .map(|(_, ip, reason)| (sys.fake.speaker_at(&ip).name.clone(), reason))
        .collect()
}

/// Checks that `stream_id` plays on exactly `rooms` in the household: one of
/// them fetches it and the rest follow that one, and the companion holds a
/// session on each, the speaker fetching it as the coordinator.
fn assert_plays_on(sys: &TestSystem, stream_id: &str, rooms: &[&str]) {
    let log = sys.fake.format_log();
    assert!(
        sys.coordinator().get_stream(stream_id).is_some(),
        "{stream_id} ended\n{log}"
    );
    let mut held = cast_rooms(sys, stream_id);
    let leader = held.first().cloned().expect("a session");
    held.sort();
    let mut want: Vec<String> = rooms.iter().map(|r| (*r).to_string()).collect();
    want.sort();
    assert_eq!(held, want, "{log}");
    let lead = sys.fake.speaker_named(&leader);
    assert!(
        lead.current_uri().contains(stream_id),
        "{leader} plays {}\n{log}",
        lead.current_uri()
    );
    assert_eq!(lead.transport_state(), TransportState::Playing, "{log}");
    for room in rooms.iter().filter(|r| **r != leader) {
        assert_eq!(sys.fake.coordinator_name_of(room), leader, "{room}\n{log}");
    }
}

/// Proves: when a second cast takes the room leading a running cast, the
/// running cast is handed on to one of the rooms it keeps, which plays it
/// with the rest following, and it hears of the taken room alone, as taken.
/// A NOTIFY from the room it was handed to, naming the stream, ends nothing.
#[tokio::test]
async fn a_cast_whose_coordinator_is_taken_plays_on_in_its_other_rooms() {
    within("coordinator taken", async {
        for round in 0..ROUNDS {
            let sys = TestSystem::builder()
                .speakers(["Kitchen", "Patio", "Den", "Office"])
                .build()
                .await;
            let first = sys.new_stream();
            let second = sys.new_stream();
            let results = sys
                .start_rooms(&first, &["Kitchen", "Patio", "Den"], None)
                .await;
            assert!(results.iter().all(|r| r.success), "{results:?}");
            assert_eq!(results[0].speaker_ip, sys.ip("Kitchen"));

            // The second cast takes Kitchen alone, or with a free room.
            let taking: &[&str] = if round % 2 == 0 {
                &["Kitchen"]
            } else {
                &["Office", "Kitchen"]
            };
            let results = sys.start_rooms(&second, taking, None).await;
            assert!(results.iter().all(|r| r.success), "{results:?}");

            assert_plays_on(&sys, &first, &["Patio", "Den"]);
            assert_plays_on(&sys, &second, taking);
            assert_eq!(
                stops(&sys, &first),
                [(
                    "Kitchen".to_string(),
                    Some(SpeakerRemovalReason::SpeakerTakenOver)
                )],
                "round {round}"
            );
            assert!(!sys.events.stream_events().iter().any(|e| matches!(
                e, StreamEvent::Ended { stream_id, .. } if *stream_id == first
            )));
            sys.fake.assert_no_grouped_coordinator_joined();

            // The room the first cast was handed to leads its group now, and
            // reports the stream it fetches: that is no source change.
            sys.refresh_topology().await;
            let leader = cast_rooms(&sys, &first)[0].clone();
            let ip = sys.ip(&leader);
            assert!(sys
                .fake
                .subscription(&ip, SonosService::AVTransport)
                .is_some());
            let uri = sys.fake.speaker_named(&leader).current_uri();
            assert_eq!(
                sys.fake
                    .notify_av_transport(&ip, TransportState::Playing, &uri)
                    .await,
                200
            );
            sys.events
                .wait_for_sonos(|event| {
                    matches!(event, SonosEvent::TransportState { speaker_ip, .. }
                        if *speaker_ip == ip)
                })
                .await;
            assert!(!sys
                .events
                .sonos_events()
                .iter()
                .any(|e| matches!(e, SonosEvent::SourceChanged { .. })));
            assert_plays_on(&sys, &first, &["Patio", "Den"]);
        }
    })
    .await;
}

/// Proves: when a second cast takes a room following a running cast, the
/// room leaves the running cast's group (it is never sent a Stop, which is
/// its group's), the running cast plays on untouched in its other rooms, and
/// it hears of the taken room alone, as taken.
#[tokio::test]
async fn a_cast_whose_member_is_taken_plays_on_untouched() {
    within("member taken", async {
        for round in 0..ROUNDS {
            let sys = TestSystem::builder()
                .speakers(["Kitchen", "Patio", "Den", "Office"])
                .build()
                .await;
            let first = sys.new_stream();
            let second = sys.new_stream();
            let results = sys
                .start_rooms(&first, &["Kitchen", "Patio", "Den"], None)
                .await;
            assert!(results.iter().all(|r| r.success), "{results:?}");
            assert_eq!(results[0].speaker_ip, sys.ip("Kitchen"));
            let kitchen = sys.ip("Kitchen");
            let seq = sys.fake.next_seq();

            // The second cast takes Patio alone (it leads that cast), or
            // with a free room it joins.
            let taking: &[&str] = if round % 2 == 0 {
                &["Patio"]
            } else {
                &["Office", "Patio"]
            };
            let results = sys.start_rooms(&second, taking, None).await;
            assert!(results.iter().all(|r| r.success), "{results:?}");

            assert_plays_on(&sys, &first, &["Kitchen", "Den"]);
            assert_plays_on(&sys, &second, taking);
            assert_eq!(
                stops(&sys, &first),
                [(
                    "Patio".to_string(),
                    Some(SpeakerRemovalReason::SpeakerTakenOver)
                )],
                "round {round}"
            );
            let patio = sys.ip("Patio");
            let calls = sys.fake.calls_since(seq);
            assert!(
                !calls
                    .iter()
                    .any(|c| c.is(&patio, "Stop") || c.is(&kitchen, "Stop")),
                "{}",
                sys.fake.format_log()
            );
            assert!(
                calls
                    .iter()
                    .any(|c| c.is(&patio, "BecomeCoordinatorOfStandaloneGroup")),
                "{}",
                sys.fake.format_log()
            );
            sys.fake.assert_no_grouped_coordinator_joined();
        }
    })
    .await;
}

/// Proves: a second cast that takes a running cast's coordinator and one of
/// its members takes both, moved once, and the running cast plays on in the
/// room it keeps; a cast all of whose rooms are taken ends.
#[tokio::test]
async fn a_cast_keeps_what_a_second_cast_does_not_take() {
    within("coordinator and member taken", async {
        for round in 0..ROUNDS {
            let sys = TestSystem::builder()
                .speakers(["Kitchen", "Patio", "Den"])
                .build()
                .await;
            let first = sys.new_stream();
            let second = sys.new_stream();
            let results = sys
                .start_rooms(&first, &["Kitchen", "Patio", "Den"], None)
                .await;
            assert!(results.iter().all(|r| r.success), "{results:?}");
            assert_eq!(results[0].speaker_ip, sys.ip("Kitchen"));

            let taking: &[&str] = if round % 2 == 0 {
                &["Kitchen", "Patio"]
            } else {
                &["Patio", "Kitchen"]
            };
            let results = sys.start_rooms(&second, taking, None).await;
            assert!(results.iter().all(|r| r.success), "{results:?}");

            assert_plays_on(&sys, &first, &["Den"]);
            assert_plays_on(&sys, &second, taking);
            let mut stopped = stops(&sys, &first);
            stopped.sort_by(|a, b| a.0.cmp(&b.0));
            let taken = Some(SpeakerRemovalReason::SpeakerTakenOver);
            assert_eq!(
                stopped,
                [("Kitchen".to_string(), taken), ("Patio".to_string(), taken)],
                "round {round}\n{}",
                sys.fake.format_log()
            );
            sys.fake.assert_no_grouped_coordinator_joined();

            // Den too: nothing is left of the first cast.
            let results = sys.start_rooms(&second, &["Den"], None).await;
            assert!(results.iter().all(|r| r.success), "{results:?}");
            assert!(cast_rooms(&sys, &first).is_empty());
            assert_plays_on(&sys, &second, &["Kitchen", "Patio", "Den"]);
            sys.fake.assert_no_grouped_coordinator_joined();
        }
    })
    .await;
}
