//! Playback start, takeover, grouping and promotion, end to end against the
//! fake household.
//!
//! These run on the real clock: every step is an HTTP round trip over
//! loopback and nothing here waits on a timer, so a paused clock would only
//! risk firing the SOAP timeout while a request is in flight.

use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::events::{SonosEvent, SpeakerRemovalReason, StreamEvent};
use crate::services::GroupRole;
use crate::sonos::services::SonosService;
use crate::stream::AudioCodec;

use super::fake_sonos::Failure;
use super::harness::{within, TestSystem};

/// AVTransport actions the speaker at `ip` received at or after `seq`.
fn av_actions_since(sys: &TestSystem, ip: &str, seq: usize) -> Vec<String> {
    sys.fake
        .calls_since(seq)
        .into_iter()
        .filter(|call| {
            call.speaker_ip == ip && call.service == SonosService::AVTransport && !call.is_gena()
        })
        .map(|call| call.action)
        .collect()
}

fn av_actions(sys: &TestSystem, ip: &str) -> Vec<String> {
    av_actions_since(sys, ip, 0)
}

/// Proves: a single start is `SetAVTransportURI` then `Play`, in that order,
/// carrying the stream URI and DIDL metadata; the speaker then fetches the
/// stream URL from its own address; a coordinator session is recorded and
/// `PlaybackStarted` is emitted.
#[tokio::test]
async fn a_single_start_sets_the_uri_plays_and_is_fetched() {
    within("single start", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();

        let results = sys.start(&stream, &["Kitchen"], false).await;
        assert!(results[0].success, "{results:?}");

        assert_eq!(av_actions(&sys, &kitchen), ["SetAVTransportURI", "Play"]);
        let set_uri = sys
            .fake
            .calls_for(&kitchen)
            .into_iter()
            .find(|call| call.action == "SetAVTransportURI")
            .expect("SetAVTransportURI");
        assert_eq!(
            set_uri.arg("CurrentURI"),
            Some(sys.speaker_uri(&stream).as_str())
        );
        assert!(
            set_uri
                .arg("CurrentURIMetaData")
                .is_some_and(|didl| didl.contains("<dc:title>Thaumic Cast</dc:title>")),
            "DIDL-Lite metadata travels with the URI"
        );

        let speaker = sys.fake.speaker_named("Kitchen");
        let fetches = speaker.fetches();
        assert_eq!(fetches.len(), 1, "one fetch of the stream URL");
        assert_eq!(fetches[0].url, sys.stream_url(&stream));
        assert_eq!(fetches[0].local_ip.to_string(), kitchen);
        assert_eq!(fetches[0].status, 200);
        assert!(speaker.is_fetching(), "the connection stays open");

        let session = sys.session(&stream, "Kitchen").expect("a session");
        assert_eq!(session.role, GroupRole::Coordinator);
        assert_eq!(session.coordinator_uuid, Some(sys.uuid("Kitchen")));
        assert_eq!(session.stream_url, sys.stream_url(&stream));

        sys.events
            .wait_for_stream(|event| {
                matches!(event, StreamEvent::PlaybackStarted { stream_id, speaker_ip, .. }
                    if *stream_id == stream && *speaker_ip == kitchen)
            })
            .await;
    })
    .await;
}

/// Proves: when a second stream takes a speaker, the first stream's `Stop`
/// lands before the second's `SetAVTransportURI`, the displaced client is
/// told `SpeakerTakenOver`, and only the new session remains.
#[tokio::test]
async fn a_takeover_stops_the_old_stream_before_setting_the_new_uri() {
    within("takeover", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let kitchen = sys.ip("Kitchen");
        let stream_a = sys.new_stream();
        let stream_b = sys.new_stream();

        assert!(sys.start(&stream_a, &["Kitchen"], false).await[0].success);
        let takeover_from = sys.fake.next_seq();
        assert!(sys.start(&stream_b, &["Kitchen"], false).await[0].success);

        let calls = sys.fake.calls_since(takeover_from);
        let stop = calls
            .iter()
            .find(|call| call.is(&kitchen, "Stop"))
            .expect("Stop for the old stream");
        let set_b = calls
            .iter()
            .find(|call| call.sets_uri_starting_with(&kitchen, &sys.speaker_uri(&stream_b)))
            .expect("SetAVTransportURI for the new stream");
        assert!(stop.seq < set_b.seq, "Stop must land before the new URI");
        assert_eq!(
            av_actions_since(&sys, &kitchen, takeover_from),
            ["Stop", "SetAVTransportURI", "Play"]
        );

        let stopped = sys.events.playback_stopped();
        assert_eq!(
            stopped,
            vec![(
                stream_a.clone(),
                kitchen.clone(),
                Some(SpeakerRemovalReason::SpeakerTakenOver)
            )]
        );

        let sessions = sys.sessions();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].stream_id, stream_b);

        let fetches = sys.fake.speaker_named("Kitchen").fetches();
        assert_eq!(fetches.len(), 2);
        assert_eq!(fetches[1].url, sys.stream_url(&stream_b));
    })
    .await;
}

/// Proves: two starts racing for one speaker are serialised by the
/// per-speaker lock — the call log shows one complete start sequence, then a
/// `Stop`, then the other — exactly one session survives, and the loser is
/// told `SpeakerTakenOver`.
#[tokio::test]
async fn concurrent_starts_on_one_speaker_do_not_interleave() {
    within("concurrent starts", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let kitchen = sys.ip("Kitchen");
        let stream_a = sys.new_stream();
        let stream_b = sys.new_stream();

        let (results_a, results_b) = tokio::join!(
            sys.start(&stream_a, &["Kitchen"], false),
            sys.start(&stream_b, &["Kitchen"], false)
        );
        assert!(results_a[0].success && results_b[0].success);

        assert_eq!(
            av_actions(&sys, &kitchen),
            [
                "SetAVTransportURI",
                "Play",
                "Stop",
                "SetAVTransportURI",
                "Play"
            ],
            "one whole start, then the takeover, then the other whole start"
        );
        let uris: Vec<String> = sys
            .fake
            .calls_for(&kitchen)
            .into_iter()
            .filter(|call| call.action == "SetAVTransportURI")
            .map(|call| call.arg("CurrentURI").unwrap_or_default().to_string())
            .collect();
        let (first, second) = (&uris[0], &uris[1]);
        assert_ne!(first, second);
        let stream_of = |uri: &str| {
            if *uri == sys.speaker_uri(&stream_a) {
                stream_a.clone()
            } else {
                assert_eq!(*uri, sys.speaker_uri(&stream_b));
                stream_b.clone()
            }
        };
        let (loser, winner) = (stream_of(first), stream_of(second));

        let sessions = sys.sessions();
        assert_eq!(sessions.len(), 1, "exactly one session survives");
        assert_eq!(sessions[0].stream_id, winner);
        assert_eq!(
            sys.events.playback_stopped(),
            vec![(loser, kitchen, Some(SpeakerRemovalReason::SpeakerTakenOver))]
        );
    })
    .await;
}

/// Proves: a synced start gives the coordinator the stream URL and joins the
/// others with `x-rincon:<coordinator uuid>`; the slaves never fetch the
/// stream; sessions carry the right roles; and the arbiter moves the group
/// onto RenderingControl subscriptions.
#[tokio::test]
async fn a_grouped_start_joins_slaves_to_the_coordinator() {
    within("grouped start", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office", "Bedroom"])
            .build()
            .await;
        let (kitchen, office, bedroom) = (sys.ip("Kitchen"), sys.ip("Office"), sys.ip("Bedroom"));
        let stream = sys.new_stream();
        let from = sys.fake.next_seq();

        let results = sys
            .start(&stream, &["Kitchen", "Office", "Bedroom"], true)
            .await;
        assert!(results.iter().all(|r| r.success), "{results:?}");

        assert_eq!(
            av_actions_since(&sys, &kitchen, from),
            ["SetAVTransportURI", "Play"]
        );
        let join_uri = format!("x-rincon:{}", sys.uuid("Kitchen"));
        for slave in [&office, &bedroom] {
            assert_eq!(
                av_actions_since(&sys, slave, from),
                ["SetAVTransportURI", "Play"]
            );
            assert!(
                sys.fake
                    .calls_since(from)
                    .iter()
                    .any(|call| call.sets_uri_starting_with(slave, &join_uri)),
                "{slave} joins with {join_uri}"
            );
            assert!(
                sys.fake.speaker_at(slave).fetches().is_empty(),
                "a slave never fetches the stream"
            );
            assert_eq!(
                sys.fake.speaker_at(slave).coordinator_uuid(),
                sys.uuid("Kitchen")
            );
        }
        assert_eq!(sys.fake.speaker_named("Kitchen").fetches().len(), 1);

        let coordinator = sys
            .session(&stream, "Kitchen")
            .expect("coordinator session");
        assert_eq!(coordinator.role, GroupRole::Coordinator);
        for name in ["Office", "Bedroom"] {
            let slave = sys.session(&stream, name).expect("slave session");
            assert_eq!(slave.role, GroupRole::Slave);
            assert_eq!(slave.coordinator_ip.as_deref(), Some(kitchen.as_str()));
            assert_eq!(slave.coordinator_uuid, Some(sys.uuid("Kitchen")));
            assert_eq!(slave.stream_url, join_uri);
        }

        for ip in [&kitchen, &office, &bedroom] {
            assert!(
                sys.fake
                    .subscription(ip, SonosService::RenderingControl)
                    .is_some(),
                "{ip} is on RenderingControl for the sync session"
            );
        }

        // A slave's own volume now arrives through RenderingControl and is
        // cached under the slave's address, not the coordinator's.
        assert_eq!(
            sys.fake.notify_rendering_control(&office, 40, false).await,
            200
        );
        sys.events
            .wait_for_sonos(|event| {
                matches!(event, SonosEvent::GroupVolume { speaker_ip, volume, .. }
                    if *speaker_ip == office && *volume == 40)
            })
            .await;
        assert_eq!(
            sys.services
                .sonos_state
                .group_volumes
                .get(&office)
                .map(|v| *v),
            Some(40)
        );
    })
    .await;
}

/// Proves: a PCM stream is handed over as an `http://...live.wav` URI, the
/// speaker fetches exactly that URL, and the fetch is answered — after the
/// prefill delay the PCM path imposes — with the stream's WAV response.
#[tokio::test]
async fn a_pcm_start_is_fetched_as_a_wav_url() {
    within("pcm start", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen"])
            .codec(AudioCodec::Pcm)
            .build()
            .await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();

        let results = sys.start(&stream, &["Kitchen"], false).await;
        assert!(results[0].success, "{results:?}");

        let uri = sys.speaker_uri(&stream);
        assert!(uri.starts_with("http://") && uri.ends_with(".wav"), "{uri}");
        assert!(sys
            .fake
            .calls_for(&kitchen)
            .iter()
            .any(|call| call.sets_uri_starting_with(&kitchen, &uri)));
        let fetches = sys.fake.speaker_named("Kitchen").fetches();
        assert_eq!(fetches.len(), 1);
        assert_eq!(fetches[0].url, uri);
        assert_eq!(fetches[0].status, 200);
        assert!(sys.fake.speaker_named("Kitchen").is_fetching());
        assert_eq!(
            sys.coordinator().get_expected_stream(&kitchen).as_deref(),
            Some(uri.as_str())
        );
    })
    .await;
}

/// Proves: removing the coordinator of a synced group stops it and promotes
/// a slave, which leaves its group, receives the stream URL, and fetches it
/// from its own address; the remaining slave is re-pointed to the promoted
/// speaker's UUID; session roles follow; and `PlaybackStopped` is emitted for
/// the old coordinator only.
#[tokio::test]
async fn removing_the_coordinator_promotes_a_slave_and_repoints_the_rest() {
    within("promotion", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office", "Bedroom"])
            .build()
            .await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();
        assert!(sys
            .start(&stream, &["Kitchen", "Office", "Bedroom"], true)
            .await
            .iter()
            .all(|r| r.success));
        let from = sys.fake.next_seq();

        let stopped = sys
            .coordinator()
            .stop_playback_speaker(&stream, &kitchen, Some(SpeakerRemovalReason::UserRemoved))
            .await;
        assert_eq!(stopped, vec![kitchen.clone()]);

        assert_eq!(
            av_actions_since(&sys, &kitchen, from),
            ["Stop", "SetAVTransportURI"],
            "old coordinator: Stop, then switched to its queue"
        );
        let queue_uri = format!("x-rincon-queue:{}#0", sys.uuid("Kitchen"));
        assert!(sys
            .fake
            .calls_since(from)
            .iter()
            .any(|call| call.sets_uri_starting_with(&kitchen, &queue_uri)));

        // Which slave got promoted is up to the session store's iteration
        // order; the log says which received the stream URL.
        let promoted = ["Office", "Bedroom"]
            .into_iter()
            .find(|name| {
                sys.fake.calls_since(from).iter().any(|call| {
                    call.sets_uri_starting_with(&sys.ip(name), &sys.speaker_uri(&stream))
                })
            })
            .expect("one slave receives the stream URL");
        let remaining = if promoted == "Office" {
            "Bedroom"
        } else {
            "Office"
        };
        let (promoted_ip, remaining_ip) = (sys.ip(promoted), sys.ip(remaining));

        assert_eq!(
            av_actions_since(&sys, &promoted_ip, from),
            [
                "BecomeCoordinatorOfStandaloneGroup",
                "SetAVTransportURI",
                "Play"
            ]
        );
        let fetches = sys.fake.speaker_named(promoted).fetches();
        assert_eq!(
            fetches.len(),
            1,
            "{promoted} fetches the stream once promoted"
        );
        assert_eq!(fetches[0].local_ip.to_string(), promoted_ip);
        assert_eq!(fetches[0].status, 200);
        assert!(sys.fake.speaker_named(promoted).is_fetching());

        assert_eq!(
            av_actions_since(&sys, &remaining_ip, from),
            [
                "BecomeCoordinatorOfStandaloneGroup",
                "SetAVTransportURI",
                "Play"
            ]
        );
        let repoint_uri = format!("x-rincon:{}", sys.uuid(promoted));
        assert!(
            sys.fake
                .calls_since(from)
                .iter()
                .any(|call| call.sets_uri_starting_with(&remaining_ip, &repoint_uri)),
            "{remaining} is re-pointed to {repoint_uri}"
        );
        assert!(sys.fake.speaker_named(remaining).fetches().is_empty());

        assert!(sys.session(&stream, "Kitchen").is_none());
        let promoted_session = sys.session(&stream, promoted).expect("promoted session");
        assert_eq!(promoted_session.role, GroupRole::Coordinator);
        assert_eq!(promoted_session.coordinator_uuid, Some(sys.uuid(promoted)));
        assert_eq!(promoted_session.stream_url, sys.stream_url(&stream));
        let remaining_session = sys.session(&stream, remaining).expect("remaining session");
        assert_eq!(remaining_session.role, GroupRole::Slave);
        assert_eq!(remaining_session.coordinator_ip, Some(promoted_ip.clone()));
        assert_eq!(remaining_session.stream_url, repoint_uri);

        assert_eq!(
            sys.events.playback_stopped(),
            vec![(stream, kitchen, Some(SpeakerRemovalReason::UserRemoved))],
            "only the old coordinator is reported stopped"
        );
    })
    .await;
}

/// Proves: when another stream takes the would-be-promoted slave while the
/// promotion is still stopping the old coordinator, the promotion notices
/// under the speaker's start lock and does not overwrite the new stream's
/// session; the slave's call log holds only the takeover, with no
/// interleaved promotion calls.
#[tokio::test]
async fn a_promotion_that_loses_the_slave_to_a_takeover_stands_down() {
    within("promotion vs takeover", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .build()
            .await;
        let (kitchen, office) = (sys.ip("Kitchen"), sys.ip("Office"));
        let stream_a = sys.new_stream();
        assert!(sys
            .start(&stream_a, &["Kitchen", "Office"], true)
            .await
            .iter()
            .all(|r| r.success));
        let stream_b = sys.new_stream();
        let from = sys.fake.next_seq();

        // Hold the promotion in its first step so the takeover lands while
        // it is in flight.
        sys.fake
            .fail(&kitchen, "Stop", Failure::Delay(Duration::from_millis(300)));

        let (stopped, results_b) = tokio::join!(
            sys.coordinator().stop_playback_speaker(
                &stream_a,
                &kitchen,
                Some(SpeakerRemovalReason::UserRemoved)
            ),
            async {
                sys.fake
                    .wait_for_call(from, |call| call.is(&kitchen, "Stop"))
                    .await;
                sys.start(&stream_b, &["Office"], false).await
            }
        );
        assert!(results_b[0].success, "{results_b:?}");
        assert_eq!(stopped, vec![kitchen.clone()]);

        assert_eq!(
            av_actions_since(&sys, &office, from),
            ["Stop", "SetAVTransportURI", "Play"],
            "only the takeover touched the slave"
        );
        let sessions = sys.sessions();
        assert_eq!(sessions.len(), 1, "{sessions:?}");
        assert_eq!(sessions[0].stream_id, stream_b);
        assert_eq!(sessions[0].speaker_ip, office);
        assert_eq!(sessions[0].role, GroupRole::Coordinator);
        assert_eq!(
            sys.coordinator().get_expected_stream(&office),
            Some(sys.speaker_uri(&stream_b))
        );
        assert_eq!(
            sys.fake
                .speaker_named("Office")
                .fetches()
                .last()
                .map(|f| f.url.clone()),
            Some(sys.stream_url(&stream_b))
        );
        assert!(sys.events.playback_stopped().contains(&(
            stream_a,
            office,
            Some(SpeakerRemovalReason::SpeakerTakenOver)
        )));
    })
    .await;
}

/// Proves: once another stream has taken a speaker, tearing the first stream
/// down sends that speaker nothing — it keeps playing the new stream.
///
/// The defensive re-check inside `stop_speakers` (a speaker whose session
/// changed hands between reading the IP list and stopping) has no await
/// point in front of it on any public path, so what is observable end to end
/// is this: no SOAP reaches the taken speaker, and its fetch survives.
#[tokio::test]
async fn tearing_down_a_replaced_stream_leaves_the_taken_speaker_alone() {
    within("stop after replacement", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let stream_a = sys.new_stream();
        let stream_b = sys.new_stream();
        assert!(sys.start(&stream_a, &["Kitchen"], false).await[0].success);
        assert!(sys.start(&stream_b, &["Kitchen"], false).await[0].success);
        let from = sys.fake.next_seq();

        sys.coordinator().remove_stream_async(&stream_a).await;

        assert!(
            sys.fake.calls_since(from).is_empty(),
            "no request reached the speaker: {:?}",
            sys.fake.calls_since(from)
        );
        let sessions = sys.sessions();
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].stream_id, stream_b);
        assert!(sys.fake.speaker_named("Kitchen").is_fetching());
        assert_eq!(
            sys.fake.speaker_named("Kitchen").current_uri(),
            sys.speaker_uri(&stream_b)
        );
        sys.events
            .wait_for_stream(|event| {
                matches!(event, StreamEvent::Ended { stream_id, .. } if *stream_id == stream_a)
            })
            .await;
    })
    .await;
}

/// Proves: an unsynced multi-speaker start gives every speaker the stream URL
/// and every speaker fetches it from its own address.
#[tokio::test]
async fn an_unsynced_start_has_every_speaker_fetch_the_stream() {
    within("unsynced start", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .build()
            .await;
        let stream = sys.new_stream();

        let results = sys.start(&stream, &["Kitchen", "Office"], false).await;
        assert!(results.iter().all(|r| r.success), "{results:?}");

        for name in ["Kitchen", "Office"] {
            let ip = sys.ip(name);
            assert_eq!(av_actions(&sys, &ip), ["SetAVTransportURI", "Play"]);
            let fetches = sys.fake.speaker_named(name).fetches();
            assert_eq!(fetches.len(), 1, "{name} fetches");
            assert_eq!(fetches[0].url, sys.stream_url(&stream));
            assert_eq!(fetches[0].local_ip.to_string(), ip);
            let session = sys.session(&stream, name).expect("session");
            assert_eq!(session.role, GroupRole::Coordinator);
        }
        assert_eq!(
            sys.coordinator().allowed_reader_ips(&stream).len(),
            2,
            "both speakers are entitled to fetch"
        );
    })
    .await;
}

/// Proves: at the moment a speaker issues its fetch — while `play_uri` is
/// still in flight and before the session is recorded — the stream's
/// allowlist already names that speaker, on the single-start path and on the
/// promotion path.
///
/// Limit: every loopback peer counts as the companion host, so with fakes on
/// 127/8 a refusal (404) cannot be provoked and `strict_stream_access` is
/// not exercised here. What is observable is the allowlist itself.
#[tokio::test]
async fn a_speaker_is_on_the_allowlist_when_its_fetch_arrives() {
    within("allowlist at fetch time", async {
        let sys = TestSystem::builder()
            .speakers(["Kitchen", "Office"])
            .build()
            .await;
        let (kitchen, office) = (sys.ip("Kitchen"), sys.ip("Office"));

        /// (fetching speaker, the stream's allowlist at that moment).
        type Observed = Vec<(String, Vec<String>)>;
        let seen: Arc<Mutex<Observed>> = Arc::new(Mutex::new(Vec::new()));
        let coordinator = Arc::clone(sys.coordinator());
        let record = Arc::clone(&seen);
        sys.fake.on_fetch(move |speaker, url| {
            // .../stream/{id}/live
            let stream_id = url
                .split('/')
                .rev()
                .nth(1)
                .expect("stream id in the fetch URL")
                .to_string();
            record.lock().unwrap().push((
                speaker.ip_string(),
                coordinator.allowed_reader_ips(&stream_id),
            ));
        });

        let stream = sys.new_stream();
        assert!(sys
            .start(&stream, &["Kitchen", "Office"], true)
            .await
            .iter()
            .all(|r| r.success));
        sys.coordinator()
            .stop_playback_speaker(&stream, &kitchen, Some(SpeakerRemovalReason::UserRemoved))
            .await;

        let seen = seen.lock().unwrap().clone();
        assert_eq!(
            seen.len(),
            2,
            "one fetch at start, one at promotion: {seen:?}"
        );
        assert_eq!(seen[0].0, kitchen);
        assert!(seen[0].1.contains(&kitchen), "start: {:?}", seen[0].1);
        assert_eq!(seen[1].0, office);
        assert!(seen[1].1.contains(&office), "promotion: {:?}", seen[1].1);
    })
    .await;
}
