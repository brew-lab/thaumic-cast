//! The local Control API of one fake speaker: the player's description of
//! itself and the WebSocket, answering from the household's model.
//!
//! Hardware serves these over TLS on port 1443; the fake serves them in the
//! clear on the household's own port, and the harness reaches them with a
//! plain connector, so only the transport under the frames differs.
//!
//! * The description and the WebSocket both need the API key, and the
//!   WebSocket its subprotocol, as on hardware.
//! * `groups:1 getGroups` lists the groups of the same model
//!   `GetZoneGroupState` describes, with a player for each room and none for
//!   a satellite: how hardware lists a home theatre's satellites has not
//!   been recorded yet.
//! * `playerVolume:1` reads and sets the speaker's own level and mute, the
//!   ones RenderingControl reads and sets; `groupVolume:1` the group level and
//!   mute GroupRenderingControl does, on the group's coordinator only. Each
//!   group's id is `<coordinator>:1`, as in `GetZoneGroupState`. A fixed
//!   output refuses `setVolume` (the error code is assumed; none has been
//!   recorded).
//! * `subscribe` to either namespace pushes the current level at once and
//!   every change after it to that socket, as hardware does; a write that
//!   changes nothing pushes nothing.
//! * Casts (`playback:1`, `playbackSession:1`) and group changes
//!   (`groups:1 modifyGroupMembers`) are modelled in `lan_cast`.
//! * A speaker's sockets can be dropped from its side
//!   ([`FakeSonosSystem::drop_lan_sockets`]).
//! * With Authentication on ([`FakeSonosSystem::set_lan_authentication`])
//!   every command is refused with `ERROR_NO_PERMISSION`, the reply recorded
//!   from hardware; the description still answers.
//! * A failure injected with [`FakeSonosSystem::fail`] for the action
//!   `"<namespace> <command>"` (e.g. `"playerVolume:1 getVolume"`) is
//!   applied: a fault is a refusal, a hang no reply, a delay a late one.
//! * Any other command is refused with `ERROR_UNSUPPORTED_COMMAND`, so a
//!   test fails loudly instead of silently succeeding.
//!
//! Every command is logged ([`FakeSonosSystem::lan_calls`]).

use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::{SinkExt, StreamExt};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};
use tokio::sync::{mpsc, Notify};

use crate::sonos::lan::protocol::{Frame, API_KEY, SUBPROTOCOL, WS_PATH};
use crate::sonos::lan::volume::{GROUP_VOLUME, PLAYER_VOLUME};

use super::lan_cast::{self, PLAYBACK, SESSION};
use super::server::Ctx;
use super::{Failure, FakeSonosSystem, FakeSpeaker};

/// The household id every fake speaker reports. Hardware's has a dot, and
/// certificates carry only the part before it.
pub(crate) const FAKE_HOUSEHOLD_ID: &str = "Sonos_FAKEHOUSEHOLD000000000.fake";

/// One command a fake speaker received on its WebSocket.
#[derive(Debug, Clone)]
pub(crate) struct LanCall {
    /// Address of the speaker that received it.
    pub speaker_ip: String,
    /// The namespace, e.g. `groups:1`.
    pub namespace: String,
    /// The command, e.g. `getGroups`.
    pub command: String,
    /// The player, group or session it named.
    pub target: Option<String>,
    /// The household id the command carried.
    pub household_id: Option<String>,
    /// Its body.
    pub body: Value,
}

/// A socket subscribed to one namespace for one player, group or session.
pub(super) struct Subscriber {
    pub namespace: String,
    pub target: String,
    pub out: mpsc::UnboundedSender<String>,
}

/// One playback session on a group.
#[derive(Debug, Clone)]
pub(super) struct LanSession {
    pub id: String,
    pub app_id: String,
}

/// The household's local Control API state.
#[derive(Default)]
pub(super) struct LanState {
    /// Sockets subscribed to events.
    pub subscribers: Mutex<Vec<Subscriber>>,
    /// Each open socket's speaker, and how to drop it.
    pub sockets: Mutex<Vec<(String, Arc<Notify>)>>,
    /// The playback session on each group, by group id.
    pub sessions: Mutex<std::collections::HashMap<String, LanSession>>,
    /// Session ids handed out so far.
    pub next_session: std::sync::atomic::AtomicUsize,
}

fn has_key(headers: &HeaderMap) -> bool {
    headers
        .get("X-Sonos-Api-Key")
        .is_some_and(|key| key == API_KEY)
}

/// `GET /api/v1/players/local/info`.
pub(super) async fn info(State(ctx): State<Ctx>, headers: HeaderMap) -> Response {
    if !has_key(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let speaker = &ctx.speaker;
    Json(json!({
        "_objectType": "discoveryInfo",
        "device": { "id": speaker.uuid, "name": speaker.name, "modelDisplayName": "Play:1" },
        "householdId": FAKE_HOUSEHOLD_ID,
        "playerId": speaker.uuid,
        "groupId": format!("{}:1", speaker.coordinator_uuid()),
    }))
    .into_response()
}

/// The WebSocket at [`WS_PATH`].
pub(super) async fn socket(
    State(ctx): State<Ctx>,
    headers: HeaderMap,
    upgrade: WebSocketUpgrade,
) -> Response {
    let offers_protocol = headers
        .get("Sec-WebSocket-Protocol")
        .and_then(|value| value.to_str().ok())
        .is_some_and(|value| value.split(',').any(|p| p.trim() == SUBPROTOCOL));
    if !has_key(&headers) || !offers_protocol {
        return StatusCode::FORBIDDEN.into_response();
    }
    upgrade
        .protocols([SUBPROTOCOL])
        .on_upgrade(move |socket| serve(ctx, socket))
}

/// Answers each command in its own task, so a hang or a delay holds up
/// nothing else; replies and pushes share one writer.
async fn serve(ctx: Ctx, socket: WebSocket) {
    let dropped = Arc::new(Notify::new());
    if let Some(system) = ctx.system.upgrade() {
        system
            .lan
            .sockets
            .lock()
            .push((ctx.speaker.ip.to_string(), Arc::clone(&dropped)));
    }
    let (mut sink, mut stream) = socket.split();
    let (out, mut outgoing) = mpsc::unbounded_channel::<String>();
    let writer = tokio::spawn(async move {
        while let Some(text) = outgoing.recv().await {
            if sink.send(Message::Text(text.into())).await.is_err() {
                break;
            }
        }
    });
    loop {
        let message = tokio::select! {
            _ = dropped.notified() => break,
            message = stream.next() => message,
        };
        let Some(Ok(message)) = message else {
            break;
        };
        let Message::Text(text) = message else {
            continue;
        };
        let Some(frame) = Frame::parse(text.as_str()) else {
            continue;
        };
        let Some(system) = ctx.system.upgrade() else {
            break;
        };
        let speaker = Arc::clone(&ctx.speaker);
        let out = out.clone();
        tokio::spawn(async move { answer(&system, &speaker, &frame, out).await });
    }
    writer.abort();
    if let Some(system) = ctx.system.upgrade() {
        system
            .lan
            .sockets
            .lock()
            .retain(|(_, d)| !Arc::ptr_eq(d, &dropped));
    }
}

/// The player, group or session a frame names.
fn target_of(frame: &Frame) -> Option<String> {
    frame
        .player_id()
        .or(frame.group_id())
        .or(frame.session_id())
        .map(str::to_string)
}

/// Answers `frame` on `out`.
async fn answer(
    system: &Arc<FakeSonosSystem>,
    speaker: &Arc<FakeSpeaker>,
    frame: &Frame,
    out: mpsc::UnboundedSender<String>,
) {
    let command = frame
        .header
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let target = target_of(frame);
    system.record_lan(LanCall {
        speaker_ip: speaker.ip.to_string(),
        namespace: frame.namespace().to_string(),
        command: command.clone(),
        target: target.clone(),
        household_id: frame.household_id().map(str::to_string),
        body: frame.body.clone(),
    });

    if system.lan_authentication() {
        let _ = out.send(reply(
            frame,
            &command,
            Err(refusal("ERROR_NO_PERMISSION", "Unauthorized")),
        ));
        return;
    }
    let action = format!("{} {command}", frame.namespace());
    match system.failure_for(&speaker.ip.to_string(), &action) {
        Some(Failure::Fault(_) | Failure::FaultOnce(_)) => {
            let _ = out.send(reply(
                frame,
                &command,
                Err(refusal("ERROR_COMMAND_FAILED", "Injected")),
            ));
            return;
        }
        Some(Failure::Hang) => return,
        Some(Failure::Delay(delay)) => tokio::time::sleep(delay).await,
        None => {}
    }

    let target = target.unwrap_or_default();
    let result = match (frame.namespace(), command.as_str()) {
        ("groups:1", "getGroups") => Ok(groups(system)),
        ("groups:1", "modifyGroupMembers") if target != group_id(speaker) || !leads(speaker) => {
            Err(not_here(&target))
        }
        ("groups:1", "modifyGroupMembers") => {
            Ok(lan_cast::modify_members(system, speaker, &frame.body))
        }
        (PLAYER_VOLUME, _) if target != speaker.uuid => Err(not_here(&target)),
        (PLAYER_VOLUME, "getVolume") => Ok(player_volume(speaker)),
        (PLAYER_VOLUME, "setVolume") => set_player_volume(system, speaker, &frame.body),
        (PLAYER_VOLUME, "setMute") => {
            set_player_mute(system, speaker, &frame.body);
            Ok(json!({}))
        }
        (GROUP_VOLUME, _) if target != group_id(speaker) || !leads(speaker) => {
            Err(not_here(&target))
        }
        (GROUP_VOLUME, "getVolume") => Ok(group_volume(speaker)),
        (GROUP_VOLUME, "setVolume") => {
            set_group(system, speaker, &frame.body, "volume");
            Ok(json!({}))
        }
        (GROUP_VOLUME, "setMute") => {
            set_group(system, speaker, &frame.body, "muted");
            Ok(json!({}))
        }
        (PLAYER_VOLUME | GROUP_VOLUME, "subscribe") => {
            let _ = out.send(reply(frame, &command, Ok(json!({}))));
            let first = if frame.namespace() == PLAYER_VOLUME {
                player_volume(speaker)
            } else {
                group_volume(speaker)
            };
            let _ = out.send(event(frame.namespace(), &target, first));
            system.lan.subscribers.lock().push(Subscriber {
                namespace: frame.namespace().to_string(),
                target,
                out,
            });
            return;
        }
        (PLAYBACK | SESSION, _) => {
            match lan_cast::answer(system, speaker, frame, &command, &target, &out).await {
                Some(result) => result,
                None => return,
            }
        }
        _ => Err(refusal(
            "ERROR_UNSUPPORTED_COMMAND",
            "Not modelled by the fake",
        )),
    };
    let _ = out.send(reply(frame, &command, result));
}

/// A reply to `frame`: its header with `response` for `command`, then the
/// body, or the refusal's.
pub(super) fn reply(frame: &Frame, command: &str, result: Result<Value, Value>) -> String {
    let mut header: Map<String, Value> = frame.header.clone();
    header.remove("command");
    header.insert("response".into(), command.into());
    header.insert("success".into(), result.is_ok().into());
    let body = result.unwrap_or_else(|refused| refused);
    json!([header, body]).to_string()
}

/// An event in `namespace` for the player or group `target`.
fn event(namespace: &str, target: &str, body: Value) -> String {
    let name = namespace.trim_end_matches(":1");
    let id_field = if namespace == GROUP_VOLUME {
        "groupId"
    } else {
        "playerId"
    };
    event_as(namespace, name, id_field, target, body)
}

/// An event named `name` in `namespace`, whose header names `target` in
/// `id_field`.
pub(super) fn event_as(
    namespace: &str,
    name: &str,
    id_field: &str,
    target: &str,
    body: Value,
) -> String {
    json!([
        {
            "namespace": namespace,
            "householdId": FAKE_HOUSEHOLD_ID,
            id_field: target,
            "name": name,
            "type": name,
        },
        body
    ])
    .to_string()
}

pub(super) fn refusal(code: &str, reason: &str) -> Value {
    json!({ "_objectType": "globalError", "errorCode": code, "reason": reason })
}

pub(super) fn not_here(target: &str) -> Value {
    refusal(
        "ERROR_INVALID_OBJECT_ID",
        &format!("{target} is not on this player"),
    )
}

/// The id of the group `speaker` is in.
pub(super) fn group_id(speaker: &FakeSpeaker) -> String {
    format!("{}:1", speaker.coordinator_uuid())
}

pub(super) fn leads(speaker: &FakeSpeaker) -> bool {
    speaker.coordinator_uuid() == speaker.uuid
}

fn player_volume(speaker: &FakeSpeaker) -> Value {
    let state = speaker.state.lock();
    json!({
        "_objectType": "playerVolume",
        "volume": state.volume,
        "muted": state.mute,
        "fixed": state.output_fixed,
    })
}

fn group_volume(speaker: &FakeSpeaker) -> Value {
    let state = speaker.state.lock();
    json!({
        "_objectType": "groupVolume",
        "volume": state.group_volume,
        "muted": state.group_mute,
        "fixed": false,
    })
}

fn set_player_volume(
    system: &FakeSonosSystem,
    speaker: &FakeSpeaker,
    body: &Value,
) -> Result<Value, Value> {
    let volume = body["volume"].as_u64().unwrap_or(0).min(100) as u8;
    let changed = {
        let mut state = speaker.state.lock();
        if state.output_fixed {
            return Err(refusal("ERROR_DISALLOWED_BY_POLICY", "The output is fixed"));
        }
        std::mem::replace(&mut state.volume, volume) != volume
    };
    if changed {
        system.push_player_volume(speaker);
    }
    Ok(json!({}))
}

fn set_player_mute(system: &FakeSonosSystem, speaker: &FakeSpeaker, body: &Value) {
    let muted = body["muted"].as_bool().unwrap_or(false);
    let changed = std::mem::replace(&mut speaker.state.lock().mute, muted) != muted;
    if changed {
        system.push_player_volume(speaker);
    }
}

fn set_group(system: &FakeSonosSystem, speaker: &FakeSpeaker, body: &Value, field: &str) {
    let changed = {
        let mut state = speaker.state.lock();
        if field == "volume" {
            let volume = body["volume"].as_u64().unwrap_or(0).min(100) as u8;
            std::mem::replace(&mut state.group_volume, volume) != volume
        } else {
            let muted = body["muted"].as_bool().unwrap_or(false);
            std::mem::replace(&mut state.group_mute, muted) != muted
        }
    };
    if changed {
        system.push_group_volume(speaker);
    }
}

impl FakeSonosSystem {
    /// Sends `body` in `namespace` to every socket subscribed to it for
    /// `target`, forgetting sockets that have closed.
    fn push_lan(&self, namespace: &str, target: &str, body: Value) {
        self.push_lan_text(namespace, target, &event(namespace, target, body));
    }

    /// Sends `text` to every socket subscribed to `namespace` for `target`,
    /// forgetting sockets that have closed.
    pub(super) fn push_lan_text(&self, namespace: &str, target: &str, text: &str) {
        let text = text.to_string();
        self.lan.subscribers.lock().retain(|s| {
            if s.namespace != namespace || s.target != target {
                return !s.out.is_closed();
            }
            s.out.send(text.clone()).is_ok()
        });
    }

    /// Pushes `speaker`'s own level to its subscribers.
    pub(super) fn push_player_volume(&self, speaker: &FakeSpeaker) {
        self.push_lan(PLAYER_VOLUME, &speaker.uuid, player_volume(speaker));
    }

    /// Pushes the level of the group `coordinator` leads to its subscribers.
    pub(super) fn push_group_volume(&self, coordinator: &FakeSpeaker) {
        self.push_lan(
            GROUP_VOLUME,
            &group_id(coordinator),
            group_volume(coordinator),
        );
    }
}

/// The `group` object `getGroups` and `modifyGroupMembers` describe a
/// group with.
pub(super) fn group_json(coordinator: &FakeSpeaker, members: &[Arc<FakeSpeaker>]) -> Value {
    json!({
        "_objectType": "group",
        "id": format!("{}:1", coordinator.uuid),
        "name": coordinator.name,
        "coordinatorId": coordinator.uuid,
        "playerIds": members.iter().map(|m| m.uuid.clone()).collect::<Vec<_>>(),
    })
}

/// The address the local Control API of `speaker` is reached at.
pub(super) fn websocket_url(system: &FakeSonosSystem, speaker: &FakeSpeaker) -> String {
    format!("ws://{}:{}{WS_PATH}", speaker.ip, system.port())
}

/// The `getGroups` body for the household's model.
fn groups(system: &FakeSonosSystem) -> Value {
    let zone_groups = system.zone_groups();
    let groups: Vec<Value> = zone_groups
        .iter()
        .map(|(coordinator, members)| group_json(coordinator, members))
        .collect();
    let players: Vec<Value> = zone_groups
        .iter()
        .flat_map(|(_, members)| members.iter().map(|m| player(system, m)))
        .collect();
    json!({ "_objectType": "groups", "groups": groups, "players": players })
}

fn player(system: &FakeSonosSystem, speaker: &Arc<FakeSpeaker>) -> Value {
    json!({
        "_objectType": "player",
        "id": speaker.uuid,
        "name": speaker.name,
        "websocketUrl": websocket_url(system, speaker),
        "capabilities": ["PLAYBACK", "CLOUD", "AUDIO_CLIP"],
        "devices": [{ "id": speaker.uuid, "modelDisplayName": "Play:1" }],
    })
}
