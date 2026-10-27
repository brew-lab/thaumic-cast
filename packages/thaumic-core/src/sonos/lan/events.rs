//! Events from the household's sockets, turned into the [`SonosEvent`]s GENA
//! would have sent and handed to the same channel, so everything downstream
//! of GENA runs unchanged on port 1443.
//!
//! Only while the household is on port 1443: a socket still open after the
//! household moved back to UPnP says nothing GENA does not.

use std::sync::Arc;

use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;

use super::client::LanClient;
use super::socket::LanEvent;
use super::volume::volume_events;
use crate::runtime::TokioSpawner;
use crate::sonos::gena::{GenaSubscriptionManager, SonosEvent};
use crate::sonos::subscription_arbiter::SubscriptionArbiter;

/// Where the pump hands each event.
pub type EventSink = Arc<dyn Fn(SonosEvent) + Send + Sync>;

/// A sink into GENA's own event channel.
#[must_use]
pub fn gena_sink(gena: Arc<GenaSubscriptionManager>) -> EventSink {
    Arc::new(move |event| gena.report(event))
}

/// Runs the pump until `cancel`: each volume event from the source the
/// arbiter names for its speaker goes to `sink`, and a socket that reopens
/// is given its subscriptions again.
pub fn start(
    lan: Arc<LanClient>,
    arbiter: Arc<SubscriptionArbiter>,
    sink: EventSink,
    spawner: &TokioSpawner,
    cancel: CancellationToken,
) {
    let mut events = lan.hub().subscribe();
    let resubscriber = spawner.clone();
    spawner.spawn(async move {
        loop {
            let event = tokio::select! {
                _ = cancel.cancelled() => break,
                event = events.recv() => event,
            };
            match event {
                Ok(LanEvent::Frame { ip, frame, .. }) => {
                    if !arbiter.route().is_lan() {
                        continue;
                    }
                    for event in volume_events(&ip, &frame, arbiter.is_in_sync_session(&ip)) {
                        sink(event);
                    }
                }
                Ok(LanEvent::Closed { ip }) => lan.socket_closed(&ip),
                Ok(LanEvent::Reconnected { ip }) => {
                    lan.socket_closed(&ip);
                    let lan = Arc::clone(&lan);
                    resubscriber.spawn(async move { lan.ensure_subscriptions().await });
                }
                Err(RecvError::Lagged(missed)) => {
                    log::warn!("[Lan] event pump fell behind; {missed} event(s) lost");
                }
                Err(RecvError::Closed) => break,
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use parking_lot::Mutex;
    use serde_json::json;

    use super::*;
    use crate::sonos::lan::fake::{ok, FakeConnector, FakeSpeaker};
    use crate::sonos::lan::protocol::tests::recorded;
    use crate::sonos::lan::protocol::Frame;
    use crate::sonos::routed::{HouseholdRoute, Route};

    const OFFICE: &str = "192.168.1.10";
    const OFFICE_ID: &str = "RINCON_000000000A0101400";
    const OFFICE_GROUP: &str = "RINCON_000000000A0101400:205";

    fn volume_event(namespace: &str, id_field: &str, id: &str, volume: u8) -> String {
        let name = namespace.trim_end_matches(":1");
        json!([
            { "namespace": namespace, "householdId": "Sonos_H", id_field: id,
              "name": name, "type": name },
            { "_objectType": name, "volume": volume, "muted": false, "fixed": false }
        ])
        .to_string()
    }

    /// `(volume, own)` of every GroupVolume handed on so far.
    fn levels(seen: &Mutex<Vec<SonosEvent>>) -> Vec<(u8, bool)> {
        seen.lock()
            .iter()
            .filter_map(|e| match e {
                SonosEvent::GroupVolume { volume, own, .. } => Some((*volume, *own)),
                _ => None,
            })
            .collect()
    }

    async fn settle() {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }

    #[tokio::test]
    async fn each_speaker_s_level_is_handed_on_from_the_source_that_counts_on_port_1443_only() {
        let speaker = FakeSpeaker::start(|f| match f.header["command"].as_str() {
            Some("getGroups") => {
                vec![ok(Frame::parse(&recorded("reply_get_groups"))
                    .unwrap()
                    .body)]
            }
            _ => vec![ok(json!({}))],
        })
        .await;
        let connector = Arc::new(FakeConnector::default());
        connector.add(OFFICE, &speaker);
        connector
            .infos
            .lock()
            .insert(OFFICE.into(), recorded("local_info"));
        let lan = Arc::new(LanClient::new(connector));
        let route = Arc::new(HouseholdRoute::default());
        route.set(Route::Lan);
        let (gena, _rx) = GenaSubscriptionManager::new(reqwest::Client::new());
        let arbiter = Arc::new(SubscriptionArbiter::with_route(
            Arc::new(gena),
            route.clone(),
        ));
        let seen = Arc::new(Mutex::new(Vec::new()));
        let collected = Arc::clone(&seen);
        let cancel = CancellationToken::new();
        start(
            Arc::clone(&lan),
            Arc::clone(&arbiter),
            Arc::new(move |event| collected.lock().push(event)),
            &TokioSpawner::new(tokio::runtime::Handle::current()),
            cancel.clone(),
        );
        lan.zone_groups(OFFICE, OFFICE_ID).await.unwrap();

        speaker.push(volume_event("playerVolume:1", "playerId", OFFICE_ID, 11));
        speaker.push(volume_event("groupVolume:1", "groupId", OFFICE_GROUP, 12));
        settle().await;
        assert_eq!(levels(&seen), [(12, false)]);

        arbiter
            .enter_sync_session(&[OFFICE.to_string()], "http://127.0.0.1:1/notify")
            .await;
        speaker.push(volume_event("playerVolume:1", "playerId", OFFICE_ID, 21));
        speaker.push(volume_event("groupVolume:1", "groupId", OFFICE_GROUP, 22));
        settle().await;
        assert_eq!(levels(&seen), [(12, false), (21, true)]);

        route.set(Route::Upnp);
        speaker.push(volume_event("playerVolume:1", "playerId", OFFICE_ID, 31));
        settle().await;
        assert_eq!(levels(&seen).len(), 2);
        cancel.cancel();
    }
}
