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
//! * With Authentication on ([`FakeSonosSystem::set_lan_authentication`])
//!   every command is refused with `ERROR_NO_PERMISSION`, the reply recorded
//!   from hardware; the description still answers.
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
use serde_json::{json, Map, Value};

use crate::sonos::lan::protocol::{Frame, API_KEY, SUBPROTOCOL, WS_PATH};

use super::server::Ctx;
use super::{FakeSonosSystem, FakeSpeaker};

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
    /// The household id the command carried.
    pub household_id: Option<String>,
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

async fn serve(ctx: Ctx, mut socket: WebSocket) {
    while let Some(Ok(message)) = socket.recv().await {
        let Message::Text(text) = message else {
            continue;
        };
        let Some(frame) = Frame::parse(text.as_str()) else {
            continue;
        };
        let Some(system) = ctx.system.upgrade() else {
            break;
        };
        let reply = answer(&system, &ctx.speaker, &frame);
        if socket.send(Message::Text(reply.into())).await.is_err() {
            break;
        }
    }
}

/// The reply to `frame`, as text.
fn answer(system: &FakeSonosSystem, speaker: &FakeSpeaker, frame: &Frame) -> String {
    let command = frame
        .header
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    system.record_lan(LanCall {
        speaker_ip: speaker.ip.to_string(),
        namespace: frame.namespace().to_string(),
        command: command.clone(),
        household_id: frame.household_id().map(str::to_string),
    });

    if system.lan_authentication() {
        return reply(
            frame,
            &command,
            false,
            refusal("ERROR_NO_PERMISSION", "Unauthorized"),
        );
    }
    match (frame.namespace(), command.as_str()) {
        ("groups:1", "getGroups") => reply(frame, &command, true, groups(system)),
        _ => reply(
            frame,
            &command,
            false,
            refusal("ERROR_UNSUPPORTED_COMMAND", "Not modelled by the fake"),
        ),
    }
}

/// A reply to `frame`: its header with `response` for `command`, then `body`.
fn reply(frame: &Frame, command: &str, success: bool, body: Value) -> String {
    let mut header: Map<String, Value> = frame.header.clone();
    header.remove("command");
    header.insert("response".into(), command.into());
    header.insert("success".into(), success.into());
    json!([header, body]).to_string()
}

fn refusal(code: &str, reason: &str) -> Value {
    json!({ "_objectType": "globalError", "errorCode": code, "reason": reason })
}

/// The `getGroups` body for the household's model.
fn groups(system: &FakeSonosSystem) -> Value {
    let zone_groups = system.zone_groups();
    let groups: Vec<Value> = zone_groups
        .iter()
        .map(|(coordinator, members)| {
            json!({
                "_objectType": "group",
                "id": format!("{}:1", coordinator.uuid),
                "name": coordinator.name,
                "coordinatorId": coordinator.uuid,
                "playerIds": members.iter().map(|m| m.uuid.clone()).collect::<Vec<_>>(),
            })
        })
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
        "websocketUrl": format!("ws://{}:{}{WS_PATH}", speaker.ip, system.port()),
        "capabilities": ["PLAYBACK", "CLOUD", "AUDIO_CLIP"],
        "devices": [{ "id": speaker.uuid, "modelDisplayName": "Play:1" }],
    })
}
