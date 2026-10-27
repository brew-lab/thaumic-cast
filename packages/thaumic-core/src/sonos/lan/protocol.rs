//! Frames of the Sonos local Control API.
//!
//! Every message on the socket is a JSON array `[header, body]`. A command's
//! header names the namespace, the command, the household and the object it
//! acts on (a group, player or session), plus a `cmdId` that the reply echoes.
//! Replies carry `response` and `success`; events carry `name` and no `cmdId`.
//! The shapes here are the ones recorded from speakers on firmware 86.10
//! (`testdata/frames.json`).

use serde::Deserialize;
use serde_json::{json, Map, Value};

use crate::sonos::soap::SoapError;

/// The public placeholder key that the speakers accept on the LAN.
pub const API_KEY: &str = "123e4567-e89b-12d3-a456-426655440000";

/// The WebSocket subprotocol the speakers require.
pub const SUBPROTOCOL: &str = "v1.api.smartspeaker.audio";

/// The port of the local Control API.
pub const PORT: u16 = 1443;

/// The WebSocket path on that port.
pub const WS_PATH: &str = "/websocket/api";

/// The path of a player's description of itself, on the same port, asked
/// for with a plain `GET` carrying the key.
pub const INFO_PATH: &str = "/api/v1/players/local/info";

/// The WebSocket URL of a speaker's Control API.
#[must_use]
pub fn websocket_url(ip: &str) -> String {
    format!("wss://{ip}:{PORT}{WS_PATH}")
}

/// The host of a `websocketUrl` as the speakers report it
/// (`wss://192.168.1.10:1443/websocket/api` → `192.168.1.10`).
#[must_use]
pub fn host_of(websocket_url: &str) -> Option<&str> {
    let rest = websocket_url.split_once("://")?.1;
    let host = rest.split(['/', ':']).next()?;
    (!host.is_empty()).then_some(host)
}

/// Error codes in [`SoapError::Lan`]: the speaker's own, and the ones the
/// transport sets when there is no reply to read.
pub mod code {
    /// No reply within the call's timeout.
    pub const TIMEOUT: &str = "LAN_TIMEOUT";
    /// The socket closed before the reply arrived, or was already closed.
    pub const SOCKET_CLOSED: &str = "LAN_SOCKET_CLOSED";
    /// The socket could not be opened (TCP, TLS or the WebSocket handshake).
    pub const CONNECT_FAILED: &str = "LAN_CONNECT_FAILED";
    /// A reply the transport could not read.
    pub const BAD_REPLY: &str = "LAN_BAD_REPLY";
    /// An operation this route does not carry out.
    pub const UNSUPPORTED: &str = "LAN_UNSUPPORTED";
    /// The command went to a player that no longer leads the group.
    pub const GROUP_MOVED: &str = "GROUP_STATUS_MOVED";
    /// The household has Authentication on: every command is refused.
    pub const NO_PERMISSION: &str = "ERROR_NO_PERMISSION";
    /// Our playback session was ended by someone else, or by our own leave.
    pub const SESSION_EVICTED: &str = "ERROR_SESSION_EVICTED";
}

/// Whether a [`SoapError::Lan`] code is worth retrying: no reply arrived,
/// and the hub reopens a closed socket on the next call. A speaker's own
/// error codes are answers, not transient failures.
#[must_use]
pub fn is_transient_code(c: &str) -> bool {
    matches!(c, code::TIMEOUT | code::SOCKET_CLOSED)
}

/// The error for a transport failure with the given code.
pub(crate) fn transport_error(c: &str, message: impl Into<String>) -> SoapError {
    SoapError::Lan {
        code: c.to_string(),
        message: message.into(),
    }
}

/// The speaker a socket expects to reach, checked against its certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SpeakerIdentity {
    /// The player id (`RINCON_…01400`), from discovery or `getGroups`.
    pub player_id: String,
    /// The household id, once known. Before the first socket it is not.
    pub household_id: Option<String>,
}

/// What a command acts on, which decides the id field in its header.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// The household only (`groups:1 getGroups`).
    Household,
    /// A group (`groupId`).
    Group(String),
    /// A player (`playerId`).
    Player(String),
    /// A playback session (`sessionId`).
    Session(String),
}

/// One command to send.
#[derive(Debug, Clone)]
pub struct Command {
    /// The namespace, e.g. `playback:1`.
    pub namespace: &'static str,
    /// The command, e.g. `getPlaybackStatus`.
    pub command: &'static str,
    /// What it acts on.
    pub target: Target,
    /// The body: an object, empty for most reads.
    pub body: Value,
}

impl Command {
    /// A command with an empty body.
    #[must_use]
    pub fn new(namespace: &'static str, command: &'static str, target: Target) -> Self {
        Self {
            namespace,
            command,
            target,
            body: json!({}),
        }
    }

    /// The same command with this body.
    #[must_use]
    pub fn with_body(mut self, body: Value) -> Self {
        self.body = body;
        self
    }

    /// `namespace/command`, for logs.
    #[must_use]
    pub fn key(&self) -> String {
        format!("{}/{}", self.namespace, self.command)
    }

    /// The text frame to send.
    #[must_use]
    pub fn to_frame(&self, household_id: &str, cmd_id: &str) -> String {
        let mut header = Map::new();
        header.insert("namespace".into(), self.namespace.into());
        header.insert("command".into(), self.command.into());
        header.insert("householdId".into(), household_id.into());
        match &self.target {
            Target::Household => {}
            Target::Group(id) => {
                header.insert("groupId".into(), id.as_str().into());
            }
            Target::Player(id) => {
                header.insert("playerId".into(), id.as_str().into());
            }
            Target::Session(id) => {
                header.insert("sessionId".into(), id.as_str().into());
            }
        }
        header.insert("cmdId".into(), cmd_id.into());
        Value::Array(vec![Value::Object(header), self.body.clone()]).to_string()
    }
}

/// A frame received from a speaker: a reply or an event.
#[derive(Debug, Clone, PartialEq)]
pub struct Frame {
    /// The header object.
    pub header: Map<String, Value>,
    /// The body; an empty object when the frame had none.
    pub body: Value,
}

impl Frame {
    /// Parses a text frame. `None` for anything that is not `[header, body]`.
    #[must_use]
    pub fn parse(text: &str) -> Option<Self> {
        let Value::Array(mut parts) = serde_json::from_str::<Value>(text).ok()? else {
            return None;
        };
        if parts.is_empty() || parts.len() > 2 {
            return None;
        }
        let body = if parts.len() == 2 {
            parts.pop()?
        } else {
            json!({})
        };
        let Value::Object(header) = parts.pop()? else {
            return None;
        };
        Some(Self { header, body })
    }

    fn header_str(&self, key: &str) -> Option<&str> {
        self.header.get(key).and_then(Value::as_str)
    }

    fn body_str(&self, key: &str) -> Option<&str> {
        self.body.get(key).and_then(Value::as_str)
    }

    /// The `cmdId` a reply echoes; events have none.
    #[must_use]
    pub fn cmd_id(&self) -> Option<&str> {
        self.header_str("cmdId")
    }

    /// The namespace, e.g. `playback:1` (session events use `playbackSession`).
    #[must_use]
    pub fn namespace(&self) -> &str {
        self.header_str("namespace").unwrap_or_default()
    }

    /// The command a reply answers, or the event's name.
    #[must_use]
    pub fn name(&self) -> &str {
        self.header_str("response")
            .or_else(|| self.header_str("name"))
            .unwrap_or_default()
    }

    /// The header's `type`, which names the body's object type.
    #[must_use]
    pub fn kind(&self) -> &str {
        self.header_str("type").unwrap_or_default()
    }

    /// Whether a reply reports success; a frame without the flag counts as one.
    #[must_use]
    pub fn success(&self) -> bool {
        self.header.get("success").and_then(Value::as_bool) != Some(false)
    }

    /// The header's `householdId`.
    #[must_use]
    pub fn household_id(&self) -> Option<&str> {
        self.header_str("householdId")
    }

    /// The header's `groupId`.
    #[must_use]
    pub fn group_id(&self) -> Option<&str> {
        self.header_str("groupId")
    }

    /// The header's `sessionId`.
    #[must_use]
    pub fn session_id(&self) -> Option<&str> {
        self.header_str("sessionId")
    }

    /// The header's `playerId`.
    #[must_use]
    pub fn player_id(&self) -> Option<&str> {
        self.header_str("playerId")
    }

    /// The body's `errorCode`, or `GROUP_STATUS_MOVED` for a moved group.
    #[must_use]
    pub fn error_code(&self) -> Option<&str> {
        self.body_str("errorCode").or_else(|| {
            (self.body_str("groupStatus") == Some(code::GROUP_MOVED)).then_some(code::GROUP_MOVED)
        })
    }

    /// The body's `reason`, if any.
    #[must_use]
    pub fn reason(&self) -> Option<&str> {
        self.body_str("reason")
    }

    /// Where the group went, when a player answers that it no longer leads it.
    #[must_use]
    pub fn group_moved(&self) -> Option<GroupMoved> {
        if self.body_str("groupStatus") != Some(code::GROUP_MOVED) {
            return None;
        }
        Some(GroupMoved {
            ip: self
                .body_str("websocketUrl")
                .and_then(host_of)
                .map(str::to_string),
            player_id: self.body_str("playerId").map(str::to_string),
        })
    }

    /// The reply as a result: a refusal becomes an error.
    ///
    /// `ERROR_NO_PERMISSION` (Authentication on) becomes
    /// [`SoapError::UpnpDisabled`]: switching UPnP on is the fix the user is
    /// told either way.
    pub fn into_result(self) -> Result<Self, SoapError> {
        if self.success() {
            return Ok(self);
        }
        let c = self.error_code().unwrap_or(code::BAD_REPLY).to_string();
        if c == code::NO_PERMISSION {
            return Err(SoapError::UpnpDisabled);
        }
        let message = self
            .reason()
            .map(str::to_string)
            .unwrap_or_else(|| self.body.to_string());
        Err(SoapError::Lan { code: c, message })
    }
}

/// The new leader of a group, from a `GROUP_STATUS_MOVED` answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupMoved {
    /// The new coordinator's IP, from its `websocketUrl`.
    pub ip: Option<String>,
    /// The new coordinator's player id.
    pub player_id: Option<String>,
}

/// The household's groups and players (`groups:1 getGroups`, or the
/// `groups` event).
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Groups {
    /// Every group, a lone player being a group of one.
    #[serde(default)]
    pub groups: Vec<Group>,
    /// Every player.
    #[serde(default)]
    pub players: Vec<Player>,
}

/// One group.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    /// The group id (`RINCON_…:N`). It changes when membership changes.
    pub id: String,
    /// The group's display name.
    #[serde(default)]
    pub name: String,
    /// The coordinator's player id, which is its RINCON uuid.
    pub coordinator_id: String,
    /// Members, the coordinator included.
    #[serde(default)]
    pub player_ids: Vec<String>,
}

/// One player.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Player {
    /// The player id, which is its RINCON uuid.
    pub id: String,
    /// The room name.
    #[serde(default)]
    pub name: String,
    /// Its Control API URL, which carries its IP.
    #[serde(default)]
    pub websocket_url: String,
    /// What it supports, e.g. `PLAYBACK`, `HT_PLAYBACK`.
    #[serde(default)]
    pub capabilities: Vec<String>,
    /// The devices that make up the player: one, or a bonded set.
    #[serde(default)]
    pub devices: Vec<Device>,
}

/// One device of a player.
#[derive(Debug, Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    /// The device id, which is its RINCON uuid.
    pub id: String,
    /// The model as Sonos names it to people, e.g. `Play:1`.
    #[serde(default)]
    pub model_display_name: Option<String>,
}

impl Player {
    /// The model of the player's own device, as Sonos names it to people.
    #[must_use]
    pub fn model(&self) -> Option<&str> {
        self.devices
            .iter()
            .find(|d| d.id == self.id)
            .and_then(|d| d.model_display_name.as_deref())
    }
}

/// A player's description of itself, from [`INFO_PATH`]: where detection
/// learns the household id that every command carries.
#[derive(Debug, Clone, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LocalInfo {
    /// The player id, which is its RINCON uuid.
    pub player_id: String,
    /// The household id.
    pub household_id: String,
}

impl LocalInfo {
    /// Reads the JSON the player answered with.
    pub fn parse(text: &str) -> Result<Self, SoapError> {
        serde_json::from_str(text)
            .map_err(|e| transport_error(code::BAD_REPLY, format!("player info: {e}")))
    }
}

impl Groups {
    /// Reads the body of a `getGroups` reply or a `groups` event.
    pub fn from_body(body: &Value) -> Result<Self, SoapError> {
        Self::deserialize(body)
            .map_err(|e| transport_error(code::BAD_REPLY, format!("groups: {e}")))
    }

    /// The group a player is in.
    #[must_use]
    pub fn group_of(&self, player_id: &str) -> Option<&Group> {
        self.groups
            .iter()
            .find(|g| g.player_ids.iter().any(|p| p == player_id))
    }

    /// A player's IP, from its `websocketUrl`.
    #[must_use]
    pub fn ip_of(&self, player_id: &str) -> Option<&str> {
        self.players
            .iter()
            .find(|p| p.id == player_id)
            .and_then(|p| host_of(&p.websocket_url))
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    const FRAMES: &str = include_str!("testdata/frames.json");

    /// A recorded frame by name, as the text a speaker sends.
    pub(crate) fn recorded(name: &str) -> String {
        let all: Value = serde_json::from_str(FRAMES).expect("fixture is JSON");
        all.get(name)
            .unwrap_or_else(|| panic!("no recorded frame {name}"))
            .to_string()
    }

    fn frame(name: &str) -> Frame {
        Frame::parse(&recorded(name)).expect("recorded frame parses")
    }

    #[test]
    fn a_command_frame_carries_the_household_its_target_and_the_cmd_id() {
        let cmd = Command::new(
            "playback:1",
            "getPlaybackStatus",
            Target::Group("RINCON_A:5".into()),
        );
        let sent: Value = serde_json::from_str(&cmd.to_frame("Sonos_H", "t7")).unwrap();
        assert_eq!(
            sent,
            json!([{
                "namespace": "playback:1",
                "command": "getPlaybackStatus",
                "householdId": "Sonos_H",
                "groupId": "RINCON_A:5",
                "cmdId": "t7"
            }, {}])
        );

        let vol = Command::new(
            "playerVolume:1",
            "setVolume",
            Target::Player("RINCON_A".into()),
        )
        .with_body(json!({ "volume": 12 }));
        let sent: Value = serde_json::from_str(&vol.to_frame("Sonos_H", "t8")).unwrap();
        assert_eq!(sent[0]["playerId"], "RINCON_A");
        assert_eq!(sent[1], json!({ "volume": 12 }));

        let leave = Command::new(
            "playbackSession:1",
            "leaveSession",
            Target::Session("RINCON_A:5@1".into()),
        );
        let sent: Value = serde_json::from_str(&leave.to_frame("Sonos_H", "t9")).unwrap();
        assert_eq!(sent[0]["sessionId"], "RINCON_A:5@1");
        assert!(sent[0].get("groupId").is_none());
    }

    #[test]
    fn recorded_replies_are_matched_by_their_cmd_id_and_read_as_successes() {
        for name in [
            "reply_create_session",
            "reply_load_cloud_queue",
            "reply_get_playback_status",
            "reply_get_volume",
            "reply_get_groups",
        ] {
            let f = frame(name);
            assert_eq!(f.cmd_id(), Some("c1"), "{name}");
            assert!(f.success(), "{name}");
            assert!(f.clone().into_result().is_ok(), "{name}");
        }
        let created = frame("reply_create_session");
        assert_eq!(created.name(), "createSession");
        assert_eq!(
            created.body["sessionId"],
            "RINCON_000000000A0101400:207@26678728"
        );
        let status = frame("reply_get_playback_status");
        assert_eq!(status.namespace(), "playback:1");
        assert_eq!(status.kind(), "playbackStatus");
    }

    #[test]
    fn authentication_on_reads_as_upnp_disabled() {
        let f = frame("reply_no_permission");
        assert!(!f.success());
        assert_eq!(f.error_code(), Some(code::NO_PERMISSION));
        assert!(matches!(f.into_result(), Err(SoapError::UpnpDisabled)));
    }

    #[test]
    fn an_eviction_is_an_event_with_its_code_reason_and_session() {
        let f = frame("event_session_evicted");
        assert_eq!(f.cmd_id(), None);
        assert_eq!(f.namespace(), "playbackSession");
        assert_eq!(f.name(), "sessionError");
        assert_eq!(f.error_code(), Some(code::SESSION_EVICTED));
        assert_eq!(f.reason(), Some("AV Transport URI changed"));
        assert_eq!(
            f.session_id(),
            Some("RINCON_000000000A0101400:205@832355261")
        );
    }

    #[test]
    fn events_carry_their_name_and_target() {
        let f = frame("event_playback_status");
        assert_eq!(f.name(), "playbackStatus");
        assert_eq!(f.group_id(), Some("RINCON_000000000A0101400:208"));
        assert_eq!(f.body["playbackState"], "PLAYBACK_STATE_IDLE");

        let f = frame("event_playback_error");
        assert_eq!(f.error_code(), Some("ERROR_PLAYBACK_FAILED"));
    }

    #[test]
    fn a_moved_group_names_its_new_leader() {
        let f = frame("reply_group_moved");
        assert_eq!(f.error_code(), Some(code::GROUP_MOVED));
        assert_eq!(
            f.group_moved(),
            Some(GroupMoved {
                ip: Some("192.168.1.12".into()),
                player_id: Some("RINCON_000000000C0101400".into()),
            })
        );
        match f.into_result() {
            Err(SoapError::Lan { code: c, .. }) => assert_eq!(c, code::GROUP_MOVED),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(frame("reply_get_volume").group_moved(), None);
    }

    #[test]
    fn recorded_groups_give_membership_and_each_players_ip() {
        for name in ["reply_get_groups", "event_groups"] {
            let g = Groups::from_body(&frame(name).body).expect(name);
            assert_eq!(g.groups.len(), 3, "{name}");
            assert_eq!(g.players.len(), 3, "{name}");
            let office = g.group_of("RINCON_000000000A0101400").expect("office");
            assert_eq!(office.coordinator_id, "RINCON_000000000A0101400");
            assert_eq!(g.ip_of("RINCON_000000000A0101400"), Some("192.168.1.10"));
            assert_eq!(g.ip_of("RINCON_000000000C0101400"), Some("192.168.1.12"));
        }
        let g = Groups::from_body(&frame("reply_get_groups").body).unwrap();
        let playbar = g
            .players
            .iter()
            .find(|p| p.id == "RINCON_000000000C0101400")
            .unwrap();
        assert!(playbar.capabilities.iter().any(|c| c == "HT_PLAYBACK"));
        assert_eq!(playbar.model(), Some("Playbar"));
        assert_eq!(Player::default().model(), None);
    }

    #[test]
    fn player_info_gives_the_household_and_a_bad_one_is_refused() {
        let info = LocalInfo::parse(
            r#"{"device":{"modelDisplayName":"Play:1"},"householdId":"Sonos_H.x",
                "playerId":"RINCON_A","groupId":"RINCON_A:5"}"#,
        )
        .unwrap();
        assert_eq!(info.household_id, "Sonos_H.x");
        assert_eq!(info.player_id, "RINCON_A");
        match LocalInfo::parse(r#"{"playerId":"RINCON_A"}"#) {
            Err(SoapError::Lan { code: c, .. }) => assert_eq!(c, code::BAD_REPLY),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[test]
    fn only_a_missing_reply_is_transient() {
        assert!(is_transient_code(code::TIMEOUT));
        assert!(is_transient_code(code::SOCKET_CLOSED));
        assert!(!is_transient_code(code::CONNECT_FAILED));
        assert!(!is_transient_code(code::GROUP_MOVED));
        assert!(!is_transient_code(code::SESSION_EVICTED));
        assert!(!is_transient_code("ERROR_INVALID_PARAMETER"));
        let e = transport_error(code::TIMEOUT, "no reply in 5 s");
        assert!(e.is_transient());
        assert_eq!(e.to_string(), "port 1443 LAN_TIMEOUT: no reply in 5 s");
    }

    #[test]
    fn anything_but_a_header_and_body_is_not_a_frame() {
        assert_eq!(Frame::parse("not json"), None);
        assert_eq!(Frame::parse("{}"), None);
        assert_eq!(Frame::parse("[]"), None);
        assert_eq!(Frame::parse("[1, {}]"), None);
        assert_eq!(Frame::parse("[{}, {}, {}]"), None);
        let bare = Frame::parse(r#"[{"namespace":"groups:1","name":"groups"}]"#).unwrap();
        assert_eq!(bare.body, json!({}));
    }

    #[test]
    fn a_websocket_url_gives_its_host() {
        assert_eq!(
            host_of("wss://192.168.1.10:1443/websocket/api"),
            Some("192.168.1.10")
        );
        assert_eq!(host_of("wss://speaker.local/x"), Some("speaker.local"));
        assert_eq!(host_of("192.168.1.10"), None);
        assert_eq!(host_of("wss:///x"), None);
        assert_eq!(
            websocket_url("192.168.1.10"),
            "wss://192.168.1.10:1443/websocket/api"
        );
    }
}
