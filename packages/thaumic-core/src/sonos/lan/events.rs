//! Events from the household's sockets, turned into the [`SonosEvent`]s GENA
//! would have sent and handed to the same channel, so everything downstream
//! of GENA runs unchanged on port 1443.
//!
//! - **Volume** events are handed on from the source the arbiter names for
//!   each speaker, while the household is on port 1443: a socket still open
//!   after it moved back to UPnP says nothing GENA does not.
//! - **A cast's state** is polled every [`POLL_EVERY`], and reported when it
//!   changes, as GENA reports a transport change. The speakers' own
//!   `playbackStatus` pushes can arrive 26-40 s late, so a push only brings
//!   the next poll forward; it never sets the state itself.
//! - **A session evicted** that we did not end is a takeover, and so is a
//!   cast's group moved to another coordinator by the household.
//! - **A socket that drops** under a live cast is reopened (the hub's
//!   backoff paces it) and the session joined again; one that reopens is
//!   given its subscriptions again.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use tokio::sync::broadcast::error::RecvError;
use tokio_util::sync::CancellationToken;

use super::client::{zone_groups, LanClient};
use super::protocol::Groups;
use super::socket::LanEvent;
use super::volume::volume_events;
use crate::runtime::TokioSpawner;
use crate::sonos::gena::{GenaSubscriptionManager, SonosEvent};
use crate::sonos::subscription_arbiter::SubscriptionArbiter;
use crate::utils::now_millis;

/// How often a live cast's state is read.
pub const POLL_EVERY: Duration = Duration::from_secs(2);

/// How long to wait between attempts to join a cast again.
const REJOIN_EVERY: Duration = Duration::from_secs(1);

/// Where the pump hands each event.
pub type EventSink = Arc<dyn Fn(SonosEvent) + Send + Sync>;

/// A sink into GENA's own event channel.
#[must_use]
pub fn gena_sink(gena: Arc<GenaSubscriptionManager>) -> EventSink {
    Arc::new(move |event| gena.report(event))
}

/// Polls the cast on `ip` now and hands on what changed.
fn poll_now(lan: &Arc<LanClient>, sink: &EventSink, spawner: &TokioSpawner, ip: String) {
    let (lan, sink) = (Arc::clone(lan), Arc::clone(sink));
    spawner.spawn(async move {
        lan.status_stale(&ip);
        if let Some(event) = lan.poll(&ip).await {
            sink(event);
        }
    });
}

/// Joins the cast on `ip` again until that works or the cast is over, once
/// at a time per speaker.
fn rejoin(
    lan: &Arc<LanClient>,
    sink: &EventSink,
    spawner: &TokioSpawner,
    rejoining: &Arc<Mutex<HashSet<String>>>,
    cancel: &CancellationToken,
    ip: String,
) {
    if !rejoining.lock().insert(ip.clone()) {
        return;
    }
    let (lan, sink, rejoining, cancel) = (
        Arc::clone(lan),
        Arc::clone(sink),
        Arc::clone(rejoining),
        cancel.clone(),
    );
    spawner.spawn(async move {
        while lan.has_cast(&ip) && !cancel.is_cancelled() {
            match lan.rejoin(&ip).await {
                Ok(event) => {
                    if let Some(event) = event {
                        sink(event);
                    }
                    break;
                }
                Err(e) => {
                    log::debug!("[Lan] {ip}: joining the cast again: {e}");
                    tokio::time::sleep(REJOIN_EVERY).await;
                }
            }
        }
        rejoining.lock().remove(&ip);
    });
}

/// Runs the pump until `cancel`.
pub fn start(
    lan: Arc<LanClient>,
    arbiter: Arc<SubscriptionArbiter>,
    sink: EventSink,
    spawner: &TokioSpawner,
    cancel: CancellationToken,
) {
    let mut events = lan.hub().subscribe();
    let tasks = spawner.clone();
    let rejoining = Arc::new(Mutex::new(HashSet::new()));
    {
        let (lan, sink, cancel) = (Arc::clone(&lan), Arc::clone(&sink), cancel.clone());
        spawner.spawn(async move {
            let mut every = tokio::time::interval(POLL_EVERY);
            every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = cancel.cancelled() => break,
                    _ = every.tick() => {}
                }
                for ip in lan.live_casts() {
                    if let Some(event) = lan.poll(&ip).await {
                        sink(event);
                    }
                }
                lan.retry_leaves().await;
            }
        });
    }
    spawner.spawn(async move {
        loop {
            let event = tokio::select! {
                _ = cancel.cancelled() => break,
                event = events.recv() => event,
            };
            match event {
                Ok(LanEvent::Frame { ip, frame, .. }) => match frame.name() {
                    "playbackStatus" | "playbackError" if lan.has_cast(&ip) => {
                        poll_now(&lan, &sink, &tasks, ip);
                    }
                    "groupCoordinatorChanged" if lan.has_cast(&ip) => {
                        let moved = frame.group_moved();
                        if let Some(to) = moved.as_ref().and_then(|m| m.ip.clone()) {
                            if let Some(player) = moved.and_then(|m| m.player_id) {
                                lan.hub().know(&to, &player);
                            }
                            let (lan, sink) = (Arc::clone(&lan), Arc::clone(&sink));
                            tasks.spawn(async move {
                                if let Some(event) = lan.coordinator_moved(&ip, &to).await {
                                    sink(event);
                                }
                            });
                        }
                    }
                    "sessionError" => {
                        if let Some(event) = lan.session_error(&ip, &frame) {
                            sink(event);
                        }
                    }
                    "groups" if arbiter.route().is_lan() => {
                        // The household regrouped: the topology refresh reads
                        // it, as after a ZoneGroupTopology event.
                        if let Ok(groups) = Groups::from_body(&frame.body) {
                            sink(SonosEvent::ZoneGroupsUpdated {
                                groups: zone_groups(&groups),
                                timestamp: now_millis(),
                            });
                        }
                    }
                    _ if arbiter.route().is_lan() => {
                        for event in volume_events(&ip, &frame, arbiter.is_in_sync_session(&ip)) {
                            sink(event);
                        }
                    }
                    _ => {}
                },
                Ok(LanEvent::Closed { ip }) => {
                    lan.socket_closed(&ip);
                    if lan.has_cast(&ip) {
                        rejoin(&lan, &sink, &tasks, &rejoining, &cancel, ip);
                    }
                }
                Ok(LanEvent::Reconnected { ip }) => {
                    lan.socket_closed(&ip);
                    let lan = Arc::clone(&lan);
                    tasks.spawn(async move { lan.ensure_subscriptions().await });
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
