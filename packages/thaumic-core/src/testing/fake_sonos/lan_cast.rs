//! Casts on a fake speaker's local Control API: playback sessions, cloud
//! queue loads and the playback a group reports, as recorded from firmware
//! 86.10.
//!
//! * `playbackSession:1 createSession` on a group the speaker leads creates
//!   a session, evicting any other there (reason `Replaced`, as another app's
//!   session does). `joinSession` returns the session of the same app id if
//!   there is one (`sessionCreated: false`), or creates one.
//! * `loadCloudQueue` reads the queue as a speaker does, from the speaker's
//!   own address: `context`, then `itemWindow?reason=load&itemId=…`. It plays
//!   the item named, fetching its `mediaUrl` the way `Play` fetches a URI, and
//!   answers once that fetch has its response headers.
//! * When the item's body ends on its own the speaker moves on to the item
//!   listed after it, staying PLAYING, and fetches it; with none listed it
//!   asks the queue again (`reason=queueCompleted`), and with still none the
//!   group is PAUSED at the item's declared length. A next item it cannot
//!   fetch gets a `playbackError` and leaves the group PAUSED on that item.
//! * `playback:1 getPlaybackStatus` reports the state, the item and the item
//!   before it; the position is a fixed 5 s while playing, as RelTime is.
//!   `pause` pauses; with nothing loaded it is refused
//!   (`ERROR_PLAYBACK_NO_CONTENT`).
//! * `leaveSession` ends the session: its subscribers get
//!   `ERROR_SESSION_EVICTED` with reason `AV Transport URI changed`, the same
//!   reason as any other eviction, and the group goes idle.
//! * `subscribe` to `playback:1` pushes the group's status at once and on
//!   every change; to `playbackSession:1`, its session's errors.
//! * The Sonos app can take a group over ([`FakeSonosSystem::take_over_on_lan`]).

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde_json::{json, Value};
use tokio::sync::mpsc;

use crate::sonos::lan::protocol::Frame;
use crate::sonos::types::TransportState;

use super::lan::{event_as, group_id, leads, not_here, refusal, reply, LanSession, Subscriber};
use super::{FakeSonosSystem, FakeSpeaker};

/// The playback namespace.
pub(super) const PLAYBACK: &str = "playback:1";
/// The session namespace.
pub(super) const SESSION: &str = "playbackSession:1";

/// One queue request a speaker made.
#[derive(Debug, Clone)]
pub(crate) struct QueueRead {
    /// The speaker that made it.
    pub speaker_ip: String,
    /// The URL asked for.
    pub url: String,
    /// The HTTP status answered, or 0 if none.
    pub status: u16,
}

/// Answers a cast command, or replies itself and returns `None`.
pub(super) async fn answer(
    system: &Arc<FakeSonosSystem>,
    speaker: &Arc<FakeSpeaker>,
    frame: &Frame,
    command: &str,
    target: &str,
    out: &mpsc::UnboundedSender<String>,
) -> Option<Result<Value, Value>> {
    let on_my_group = target == group_id(speaker) && leads(speaker);
    let result = match (frame.namespace(), command) {
        (PLAYBACK, _) if !on_my_group => Err(not_here(target)),
        (PLAYBACK, "getPlaybackStatus") => Ok(status(speaker)),
        (PLAYBACK, "subscribe") => {
            let _ = out.send(reply(frame, command, Ok(json!({}))));
            let _ = out.send(status_event(speaker));
            subscribe(system, PLAYBACK, target, out);
            return None;
        }
        (PLAYBACK, "pause") => {
            if speaker.state.lock().lan.item_id.is_none() {
                Err(
                    json!({ "_objectType": "playbackError", "errorCode": "ERROR_PLAYBACK_NO_CONTENT" }),
                )
            } else {
                set_transport(system, speaker, TransportState::Paused);
                Ok(json!({}))
            }
        }
        (SESSION, "createSession" | "joinSession") if !on_my_group => Err(not_here(target)),
        (SESSION, "createSession") => {
            let app_id = frame.body["appId"].as_str().unwrap_or_default();
            Ok(open_session(system, speaker, target, app_id, false))
        }
        (SESSION, "joinSession") => {
            let app_id = frame.body["appId"].as_str().unwrap_or_default();
            Ok(open_session(system, speaker, target, app_id, true))
        }
        (SESSION, _) if session_group(system, target).as_deref() != Some(&group_id(speaker)) => {
            Err(refusal(
                "ERROR_INVALID_OBJECT_ID",
                "There is no session on this player.",
            ))
        }
        (SESSION, "subscribe") => {
            let _ = out.send(reply(frame, command, Ok(json!({}))));
            subscribe(system, SESSION, target, out);
            return None;
        }
        (SESSION, "loadCloudQueue") => load(system, speaker, &frame.body).await,
        (SESSION, "refreshCloudQueue") => Ok(json!({})),
        (SESSION, "leaveSession") => {
            let group = group_id(speaker);
            let session = system.lan.sessions.lock().remove(&group);
            if let Some(session) = session {
                evict(system, speaker, &session, "AV Transport URI changed");
            }
            Ok(json!({}))
        }
        _ => Err(refusal(
            "ERROR_UNSUPPORTED_COMMAND",
            "Not modelled by the fake",
        )),
    };
    Some(result)
}

fn subscribe(
    system: &FakeSonosSystem,
    namespace: &str,
    target: &str,
    out: &mpsc::UnboundedSender<String>,
) {
    system.lan.subscribers.lock().push(Subscriber {
        namespace: namespace.to_string(),
        target: target.to_string(),
        out: out.clone(),
    });
}

/// The group a session is on.
fn session_group(system: &FakeSonosSystem, session_id: &str) -> Option<String> {
    system
        .lan
        .sessions
        .lock()
        .iter()
        .find(|(_, s)| s.id == session_id)
        .map(|(group, _)| group.clone())
}

/// Creates a session on `group`, or with `join`, returns the one of the same
/// app there.
fn open_session(
    system: &FakeSonosSystem,
    speaker: &FakeSpeaker,
    group: &str,
    app_id: &str,
    join: bool,
) -> Value {
    let existing = system.lan.sessions.lock().get(group).cloned();
    if let Some(session) = &existing {
        if join && session.app_id == app_id {
            return json!({ "_objectType": "sessionStatus", "sessionId": session.id,
                           "sessionState": "SESSION_STATE_CONNECTED", "sessionCreated": false });
        }
        evict(system, speaker, session, "Replaced");
    }
    let n = system.lan.next_session.fetch_add(1, Ordering::Relaxed);
    let session = LanSession {
        id: format!("{group}@{n}"),
        app_id: app_id.to_string(),
    };
    system
        .lan
        .sessions
        .lock()
        .insert(group.to_string(), session.clone());
    json!({ "_objectType": "sessionStatus", "sessionId": session.id,
            "sessionState": "SESSION_STATE_CONNECTED", "sessionCreated": true })
}

/// Tells `session`'s subscribers it was evicted for `reason`, and leaves the
/// group idle.
fn evict(system: &FakeSonosSystem, speaker: &FakeSpeaker, session: &LanSession, reason: &str) {
    let text = event_as(
        "playbackSession",
        "sessionError",
        "sessionId",
        &session.id,
        json!({ "_objectType": "sessionError", "errorCode": "ERROR_SESSION_EVICTED", "reason": reason }),
    );
    system.push_lan_text(SESSION, &session.id, &text);
    speaker.abort_fetch();
    {
        let mut state = speaker.state.lock();
        state.transport = TransportState::Stopped;
        state.current_uri.clear();
        let played = state.lan.item_id.take();
        state.lan.previous_item_id = played.or(state.lan.previous_item_id.take());
        state.lan.position_ms = 0;
    }
    system.push_status(speaker);
}

/// Loads the item named in a `loadCloudQueue` body, reading the queue first
/// as a speaker does.
async fn load(
    system: &Arc<FakeSonosSystem>,
    speaker: &Arc<FakeSpeaker>,
    body: &Value,
) -> Result<Value, Value> {
    let base = body["queueBaseUrl"].as_str().unwrap_or_default();
    let item_id = body["itemId"].as_str().unwrap_or_default();
    let failed = || {
        Err(
            json!({ "_objectType": "playbackError", "errorCode": "ERROR_PLAYBACK_FAILED",
                    "reason": "ERROR_CANT_REACH_SERVER" }),
        )
    };
    if read_queue(system, speaker, &format!("{base}context"))
        .await
        .is_none()
    {
        return failed();
    }
    let window = format!("{base}itemWindow?reason=load&itemId={item_id}");
    let Some(window) = read_queue(system, speaker, &window).await else {
        return failed();
    };
    let Some(item) = window["items"]
        .as_array()
        .and_then(|items| items.iter().find(|i| i["id"] == item_id))
    else {
        return failed();
    };
    let media_url = item["track"]["mediaUrl"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    let next = next_after(&window, item_id);
    {
        let mut state = speaker.state.lock();
        state.lan.queue_base = base.to_string();
        state.lan.next = next;
        let played = state.lan.item_id.replace(item_id.to_string());
        if played.as_deref() != Some(item_id) {
            state.lan.previous_item_id = played.or(state.lan.previous_item_id.take());
        }
        state.lan.duration_ms = item["track"]["durationMillis"].as_u64();
        state.lan.position_ms = 5_000;
        state.current_uri = media_url.clone();
        state.next_uri.clear();
        state.transport = TransportState::Playing;
    }
    speaker.start_fetch(system, media_url).await;
    system.push_status(speaker);
    Ok(json!({}))
}

/// The item an `itemWindow` answer lists after `item_id`.
fn next_after(window: &Value, item_id: &str) -> Option<(String, String, Option<u64>)> {
    let items = window["items"].as_array()?;
    let at = items.iter().position(|i| i["id"] == item_id)?;
    let next = items.get(at + 1)?;
    Some((
        next["id"].as_str()?.to_string(),
        next["track"]["mediaUrl"].as_str()?.to_string(),
        next["track"]["durationMillis"].as_u64(),
    ))
}

/// GETs a queue URL from the speaker's own address and records it; the JSON
/// of a 200.
async fn read_queue(system: &FakeSonosSystem, speaker: &FakeSpeaker, url: &str) -> Option<Value> {
    let response = speaker.fetcher.get(url).send().await;
    let status = response.as_ref().map_or(0, |r| r.status().as_u16());
    system.queue_reads.lock().push(QueueRead {
        speaker_ip: speaker.ip.to_string(),
        url: url.to_string(),
        status,
    });
    let response = response.ok().filter(|r| r.status().is_success())?;
    response.json().await.ok()
}

fn set_transport(system: &FakeSonosSystem, speaker: &FakeSpeaker, transport: TransportState) {
    speaker.state.lock().transport = transport;
    system.push_status(speaker);
}

/// The status `getPlaybackStatus` reports for the group `speaker` leads.
fn status(speaker: &FakeSpeaker) -> Value {
    let state = speaker.state.lock();
    let playback_state = match state.transport {
        TransportState::Playing => "PLAYBACK_STATE_PLAYING",
        TransportState::Paused => "PLAYBACK_STATE_PAUSED",
        TransportState::Transitioning => "PLAYBACK_STATE_BUFFERING",
        TransportState::Stopped => "PLAYBACK_STATE_IDLE",
    };
    json!({
        "_objectType": "playbackStatus",
        "playbackState": playback_state,
        "positionMillis": state.lan.position_ms,
        "itemId": state.lan.item_id.clone().unwrap_or_default(),
        "previousItemId": state.lan.previous_item_id.clone().unwrap_or_default(),
    })
}

fn status_event(speaker: &FakeSpeaker) -> String {
    event_as(
        PLAYBACK,
        "playbackStatus",
        "groupId",
        &group_id(speaker),
        status(speaker),
    )
}

impl FakeSonosSystem {
    /// Pushes the status of the group `speaker` leads to its subscribers.
    pub(super) fn push_status(&self, speaker: &FakeSpeaker) {
        self.push_lan_text(PLAYBACK, &group_id(speaker), &status_event(speaker));
    }

    /// A loaded item's body ended on its own: the speaker moves on to the
    /// item listed after it, asking the queue again if none is, and returns
    /// its media URL; or, with none, the group pauses at the item's declared
    /// length.
    pub(super) async fn lan_advance(&self, speaker: &FakeSpeaker) -> Option<String> {
        let (current, base, next) = {
            let state = speaker.state.lock();
            if state.transport != TransportState::Playing {
                return None;
            }
            let current = state.lan.item_id.clone()?;
            (
                current,
                state.lan.queue_base.clone(),
                state.lan.next.clone(),
            )
        };
        let next = match next {
            Some(next) => Some(next),
            None => {
                let url = format!("{base}itemWindow?reason=queueCompleted&itemId={current}");
                read_queue(self, speaker, &url)
                    .await
                    .and_then(|window| next_after(&window, &current))
            }
        };
        let Some((id, url, duration_ms)) = next else {
            self.lan_item_ended(speaker);
            return None;
        };
        {
            let mut state = speaker.state.lock();
            state.lan.previous_item_id = Some(current);
            state.lan.item_id = Some(id);
            state.lan.duration_ms = duration_ms;
            state.lan.position_ms = 5_000;
            state.lan.next = None;
            state.current_uri = url.clone();
        }
        self.push_status(speaker);
        Some(url)
    }

    /// The item moved on to could not be fetched: a `playbackError`, and the
    /// group PAUSED on it, as hardware does.
    pub(super) fn lan_item_failed(&self, speaker: &FakeSpeaker) {
        let item = {
            let mut state = speaker.state.lock();
            let Some(item) = state.lan.item_id.clone() else {
                return;
            };
            state.transport = TransportState::Paused;
            state.lan.position_ms = 0;
            item
        };
        let text = event_as(
            PLAYBACK,
            "playbackError",
            "groupId",
            &group_id(speaker),
            json!({ "_objectType": "playbackError", "errorCode": "ERROR_PLAYBACK_FAILED",
                    "reason": "ERROR_CANT_REACH_SERVER", "itemId": item }),
        );
        self.push_lan_text(PLAYBACK, &group_id(speaker), &text);
        self.push_status(speaker);
    }

    /// A loaded item's body ended on its own with nothing after it: the
    /// group pauses at the item's declared length, as hardware does at the
    /// end of a queue.
    fn lan_item_ended(&self, speaker: &FakeSpeaker) {
        {
            let mut state = speaker.state.lock();
            if state.lan.item_id.is_none() || state.transport != TransportState::Playing {
                return;
            }
            state.transport = TransportState::Paused;
            state.lan.position_ms = state.lan.duration_ms.unwrap_or(state.lan.position_ms);
        }
        self.push_status(speaker);
    }

    /// Another app takes over the group the speaker in room `name` leads, as
    /// the Sonos app does: our session is evicted (`Replaced`) and its audio
    /// stops.
    pub fn take_over_on_lan(&self, name: &str) {
        let speaker = self.speaker_named(name);
        let session = self.lan.sessions.lock().remove(&group_id(speaker));
        if let Some(session) = session {
            evict(self, speaker, &session, "Replaced");
        }
    }

    /// The playback session on the group the speaker in room `name` leads.
    pub fn lan_session(&self, name: &str) -> Option<String> {
        let group = group_id(self.speaker_named(name));
        self.lan.sessions.lock().get(&group).map(|s| s.id.clone())
    }

    /// Drops every socket to the speaker in room `name` from its side.
    pub fn drop_lan_sockets(&self, name: &str) {
        let ip = self.speaker_named(name).ip.to_string();
        for (at, dropped) in self.lan.sockets.lock().iter() {
            if *at == ip {
                dropped.notify_one();
            }
        }
    }

    /// Every queue request the speakers made, in order.
    pub fn queue_reads(&self) -> Vec<QueueRead> {
        self.queue_reads.lock().clone()
    }
}
