//! Failure injection: speakers that fault, and speakers that never answer.
//!
//! Everything here runs on the real clock, including the hang tests, and
//! that is deliberate. A paused tokio clock auto-advances to the next timer
//! whenever the runtime parks without a cross-thread unpark; I/O readiness
//! found during the zero-length park does not count (`did_wake` is only set
//! by `Handle::unpark`). With a 10s SOAP timeout pending, every loopback
//! round trip — even the first `GetZoneGroupState` — therefore lands after
//! the deadline and times out. So a hang costs a real SOAP timeout: the
//! `Stop` hang below costs one (10s), and the `Play` hang, which the retry
//! policy attempts four times, costs over forty and is ignored by default.

use std::time::Duration;

use crate::events::StreamEvent;
use crate::protocol_constants::SOAP_TIMEOUT_SECS;
use crate::sonos::services::SonosService;
use crate::sonos::soap::{soap_request, SoapError};

use super::fake_sonos::Failure;
use super::harness::{within, TestSystem};

/// AVTransport SOAP actions the speaker at `ip` received at or after `seq`.
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

/// Proves: a `Play` that faults fails the start at once (a fault is not a
/// transient error, so nothing is retried) and leaves no session, no stream
/// admission and no `PlaybackStarted` behind.
#[tokio::test]
async fn a_faulting_play_fails_the_start_and_leaves_no_session() {
    within("faulting play", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let kitchen = sys.ip("Kitchen");
        sys.fake.fail(&kitchen, "Play", Failure::Fault(701));
        let stream = sys.new_stream();

        let results = sys.start(&stream, &["Kitchen"], false).await;

        assert!(!results[0].success, "{results:?}");
        assert!(
            results[0]
                .error
                .as_deref()
                .is_some_and(|error| error.contains("SOAP fault")),
            "{results:?}"
        );
        assert_eq!(
            av_actions_since(&sys, &kitchen, 0),
            ["SetAVTransportURI", "Play"],
            "a fault is not retried"
        );
        assert!(sys.sessions().is_empty());
        assert!(sys.coordinator().allowed_reader_ips(&stream).is_empty());
        assert!(!sys
            .events
            .stream_events()
            .iter()
            .any(|event| matches!(event, StreamEvent::PlaybackStarted { .. })));
        assert!(sys.fake.speaker_named("Kitchen").fetches().is_empty());
    })
    .await;
}

/// Proves: a `Stop` that faults during teardown is logged and teardown
/// continues — the speaker is still switched to its queue, the session is
/// removed and `Ended` is emitted.
#[tokio::test]
async fn a_faulting_stop_does_not_abort_teardown() {
    within("faulting stop", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let kitchen = sys.ip("Kitchen");
        let stream = sys.new_stream();
        assert!(sys.start(&stream, &["Kitchen"], false).await[0].success);
        sys.fake.fail(&kitchen, "Stop", Failure::Fault(500));
        let from = sys.fake.next_seq();

        sys.coordinator().remove_stream_async(&stream).await;

        assert_eq!(
            av_actions_since(&sys, &kitchen, from),
            ["Stop", "SetAVTransportURI"]
        );
        let queue_uri = format!("x-rincon-queue:{}#0", sys.uuid("Kitchen"));
        assert!(sys
            .fake
            .calls_since(from)
            .iter()
            .any(|call| call.sets_uri_starting_with(&kitchen, &queue_uri)));

        assert!(sys.sessions().is_empty());
        assert!(sys.coordinator().get_stream(&stream).is_none());
        assert!(!sys.fake.speaker_named("Kitchen").is_fetching());
        sys.events
            .wait_for_stream(|event| {
                matches!(event, StreamEvent::Ended { stream_id, .. } if *stream_id == stream)
            })
            .await;
    })
    .await;
}

/// Proves: a `Stop` that never answers holds teardown for exactly one SOAP
/// timeout — `stop` deliberately does not retry — after which teardown
/// continues: the speaker is switched to its queue over a fresh connection,
/// the session is removed and `Ended` is emitted.
///
/// Costs a real 10s; see the module docs for why the clock is not paused.
#[tokio::test]
async fn a_hanging_stop_holds_teardown_for_one_soap_timeout_then_continues() {
    let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
    let kitchen = sys.ip("Kitchen");
    let stream = sys.new_stream();
    assert!(sys.start(&stream, &["Kitchen"], false).await[0].success);
    sys.fake.fail(&kitchen, "Stop", Failure::Hang);
    let from = sys.fake.next_seq();

    let started = std::time::Instant::now();
    within(
        "teardown past a hanging Stop",
        sys.coordinator().remove_stream_async(&stream),
    )
    .await;
    let elapsed = started.elapsed();

    let timeout = Duration::from_secs(SOAP_TIMEOUT_SECS);
    assert!(
        elapsed >= timeout,
        "returned after {elapsed:?}, before the timeout"
    );
    assert!(
        elapsed < timeout + Duration::from_secs(5),
        "returned after {elapsed:?}, well past one timeout"
    );
    assert_eq!(
        av_actions_since(&sys, &kitchen, from),
        ["Stop", "SetAVTransportURI"],
        "one Stop, no retry, then the queue switch"
    );
    assert!(sys.sessions().is_empty());
    assert!(sys.coordinator().get_stream(&stream).is_none());
    sys.events
        .wait_for_stream(
            |event| matches!(event, StreamEvent::Ended { stream_id, .. } if *stream_id == stream),
        )
        .await;
}

/// Proves: when `Play` never answers, the start fails after the SOAP timeout
/// and its three retries — within the budget those allow — and leaves no
/// session, no stream admission and no `PlaybackStarted` behind.
///
/// Ignored by default because it costs over forty real seconds (four 10s
/// timeouts plus the retry delays); see the module docs for why the clock
/// cannot be paused. Run it with `--ignored`.
#[tokio::test]
#[ignore = "costs four real SOAP timeouts (over 40s); run with --ignored"]
async fn a_hanging_play_fails_the_start_within_the_retry_budget() {
    let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
    let kitchen = sys.ip("Kitchen");
    sys.fake.fail(&kitchen, "Play", Failure::Hang);
    let stream = sys.new_stream();

    let started = std::time::Instant::now();
    let results = sys.start(&stream, &["Kitchen"], false).await;
    let elapsed = started.elapsed();

    assert!(!results[0].success, "{results:?}");
    let plays = av_actions_since(&sys, &kitchen, 0)
        .iter()
        .filter(|action| *action == "Play")
        .count();
    assert_eq!(plays, 4, "one attempt and three retries");
    let budget = Duration::from_secs(SOAP_TIMEOUT_SECS * 4) + Duration::from_secs(5);
    assert!(elapsed <= budget, "took {elapsed:?}, more than {budget:?}");
    assert!(
        elapsed >= Duration::from_secs(SOAP_TIMEOUT_SECS * 4),
        "took {elapsed:?}, less than four timeouts"
    );
    assert!(sys.sessions().is_empty());
    assert!(sys.coordinator().allowed_reader_ips(&stream).is_empty());
    assert!(!sys
        .events
        .stream_events()
        .iter()
        .any(|event| matches!(event, StreamEvent::PlaybackStarted { .. })));
    assert!(sys.fake.speaker_named("Kitchen").fetches().is_empty());
}

/// Proves: the fake answers an action it does not model with a SOAP fault the
/// real client surfaces as `SoapError::Fault`, so a test that drives an
/// unmodelled action fails loudly instead of passing by accident.
#[tokio::test]
async fn the_fake_faults_on_actions_it_does_not_model() {
    within("unknown action", async {
        let sys = TestSystem::builder().speakers(["Kitchen"]).build().await;
        let kitchen = sys.ip("Kitchen");

        let result = soap_request(
            sys.services.http_client(),
            &kitchen,
            sys.fake.port(),
            SonosService::AVTransport,
            "Seek",
            &[
                ("InstanceID", "0"),
                ("Unit", "REL_TIME"),
                ("Target", "0:00:10"),
            ],
        )
        .await;

        assert!(
            matches!(result, Err(SoapError::Fault(ref message)) if message == "UPnPError"),
            "{result:?}"
        );
        let seek = sys
            .fake
            .calls_for(&kitchen)
            .into_iter()
            .find(|call| call.action == "Seek")
            .expect("the attempt is logged");
        assert_eq!(seek.arg("Target"), Some("0:00:10"));
    })
    .await;
}
