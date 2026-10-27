//! The household as the services see it over the local Control API.
//!
//! Detection learns the household id from a player's description of itself,
//! asked for over a connection checked for that player, and the topology is
//! read with `groups:1 getGroups` and given the shape `GetZoneGroupState`
//! gives on port 1400. Every player that read lists is made known to the hub
//! at its address, so later sockets can be checked for it, and the read is
//! kept: a group's commands name its group id, which only `getGroups` gives.
//!
//! Each read also makes sure every room's own level and every group's level
//! is subscribed to, so their events reach the event pump (see
//! [`super::events`]); a socket that closed loses its subscriptions, and the
//! pump asks for them again when it reopens.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use async_trait::async_trait;
use futures::future::join_all;
use parking_lot::{Mutex, RwLock};
use serde_json::json;

use super::hub::LanHub;
use super::playback::Cast;
use super::protocol::{
    code, host_of, transport_error, Command, Groups, LocalInfo, SpeakerIdentity, Target,
};
use super::queue::CloudQueues;
use super::socket::LanConnector;
use super::volume::{VolumeState, GROUP_VOLUME, PLAYER_VOLUME};
use crate::error::SoapResult;
use crate::sonos::routed::HouseholdRoute;
use crate::sonos::soap::SoapError;
use crate::sonos::traits::SonosVolumeControl;
use crate::sonos::types::{HouseholdTopology, ZoneGroup, ZoneGroupMember, ZoneGroupSnapshot};
use crate::sonos::zone_groups::group_name;

/// What a member's model reads as when Sonos does not name it.
const UNKNOWN_MODEL: &str = "Speaker";

/// One event subscription: the speaker whose socket holds it, the
/// namespace, and the player or group it is for.
type Subscription = (String, &'static str, String);

/// The household over port 1443.
pub struct LanClient {
    connector: Arc<dyn LanConnector>,
    hub: LanHub,
    /// The household id, once detection has learnt it.
    household_id: RwLock<Option<String>>,
    /// The last groups read.
    groups: RwLock<Groups>,
    /// The event subscriptions held.
    subscribed: Mutex<HashSet<Subscription>>,
    /// The queues casts are loaded from, served by the API.
    pub(super) queues: Arc<CloudQueues>,
    /// The household's route, held while a cast is live.
    pub(super) route: Arc<HouseholdRoute>,
    /// Live casts, by the IP of the coordinator they play on.
    pub(super) casts: Mutex<HashMap<String, Cast>>,
    /// Sessions ended while the speaker refused to leave them (Authentication
    /// on), left again later.
    pub(super) unleft: Mutex<Vec<super::playback::Unleft>>,
}

impl LanClient {
    /// A client whose sockets and requests go through `connector`, with
    /// queues and a route of its own.
    #[must_use]
    pub fn new(connector: Arc<dyn LanConnector>) -> Self {
        Self::with_casting(connector, Arc::default(), Arc::default())
    }

    /// A client that loads casts from `queues`, which the API serves, and
    /// holds `route` on port 1443 while one is live.
    #[must_use]
    pub fn with_casting(
        connector: Arc<dyn LanConnector>,
        queues: Arc<CloudQueues>,
        route: Arc<HouseholdRoute>,
    ) -> Self {
        Self {
            hub: LanHub::new(Arc::clone(&connector)),
            connector,
            household_id: RwLock::new(None),
            groups: RwLock::new(Groups::default()),
            subscribed: Mutex::new(HashSet::new()),
            queues,
            route,
            casts: Mutex::new(HashMap::new()),
            unleft: Mutex::new(Vec::new()),
        }
    }

    /// The household's sockets.
    #[must_use]
    pub fn hub(&self) -> &LanHub {
        &self.hub
    }

    /// The household id, once detection has learnt it.
    #[must_use]
    pub fn household_id(&self) -> Option<String> {
        self.household_id.read().clone()
    }

    /// Forgets the household id, so the next read learns it again: for a
    /// route that stopped working, whose household may have changed. Kept
    /// while a cast is live: its commands still need it (Authentication on
    /// refuses them, but a stop still tries), and its household cannot have
    /// changed under it.
    pub fn forget_household(&self) {
        if self.casts.lock().is_empty() {
            *self.household_id.write() = None;
        }
    }

    /// The household id, for a command.
    pub(super) fn household(&self) -> SoapResult<String> {
        self.household_id()
            .ok_or_else(|| transport_error(code::CONNECT_FAILED, "the household is not known yet"))
    }

    /// The player at `ip`, for a command.
    pub(super) fn player(&self, ip: &str) -> SoapResult<String> {
        self.hub.player_at(ip).ok_or_else(|| {
            transport_error(code::CONNECT_FAILED, format!("no player known at {ip}"))
        })
    }

    /// Learns the household id from the player at `ip`, which must be
    /// `player_id`.
    async fn detect(&self, ip: &str, player_id: &str) -> SoapResult<String> {
        let expect = SpeakerIdentity {
            player_id: player_id.to_string(),
            household_id: None,
        };
        let text = self
            .connector
            .local_info(ip, &expect)
            .await
            .map_err(|e| transport_error(code::CONNECT_FAILED, format!("{ip}: {e}")))?;
        let info = LocalInfo::parse(&text)?;
        if info.player_id != player_id {
            return Err(transport_error(
                code::BAD_REPLY,
                format!(
                    "{ip} describes itself as {}, not {player_id}",
                    info.player_id
                ),
            ));
        }
        self.hub.know(ip, player_id);
        *self.household_id.write() = Some(info.household_id.clone());
        Ok(info.household_id)
    }

    /// Reads the groups through `ip` and keeps them, making each listed
    /// player known at its address.
    pub(super) async fn read_groups(&self, ip: &str, household_id: &str) -> SoapResult<Groups> {
        let groups = self.hub.groups(ip, household_id).await?;
        self.keep_groups(&groups);
        Ok(groups)
    }

    /// Keeps `groups` as the last read, making each listed player known at
    /// its address.
    pub(super) fn keep_groups(&self, groups: &Groups) {
        for player in &groups.players {
            if let Some(at) = host_of(&player.websocket_url) {
                self.hub.know(at, &player.id);
            }
        }
        *self.groups.write() = groups.clone();
    }

    /// Reads the household's groups through the player at `ip`, learning
    /// the household from it first if that is not known yet.
    ///
    /// `player_id` is the player discovery or the last topology put at `ip`.
    /// The snapshot's household is empty: `getGroups` carries none of the
    /// radio, reboot or satellite detail that comparing refreshes needs.
    pub async fn zone_groups(&self, ip: &str, player_id: &str) -> SoapResult<ZoneGroupSnapshot> {
        let household_id = match self.household_id() {
            Some(id) => {
                self.hub.know(ip, player_id);
                id
            }
            None => self.detect(ip, player_id).await?,
        };
        let groups = self.read_groups(ip, &household_id).await?;
        self.ensure_subscriptions().await;
        Ok(ZoneGroupSnapshot {
            groups: zone_groups(&groups),
            household: HouseholdTopology::default(),
        })
    }

    /// The subscriptions the last groups read call for: every player's own
    /// level on its own socket, and every group's level on its
    /// coordinator's.
    fn wanted_subscriptions(&self) -> HashSet<Subscription> {
        let groups = self.groups.read();
        let players = groups.players.iter().filter_map(|p| {
            let ip = host_of(&p.websocket_url)?;
            Some((ip.to_string(), PLAYER_VOLUME, p.id.clone()))
        });
        let led = groups.groups.iter().filter_map(|g| {
            let ip = groups.ip_of(&g.coordinator_id)?;
            Some((ip.to_string(), GROUP_VOLUME, g.id.clone()))
        });
        players.chain(led).collect()
    }

    /// Subscribes to every level the last groups read calls for that is not
    /// subscribed to yet, and forgets the ones it no longer calls for. A
    /// failure is logged and tried again on the next call.
    pub async fn ensure_subscriptions(&self) {
        let Some(household_id) = self.household_id() else {
            return;
        };
        let wanted = self.wanted_subscriptions();
        let missing: Vec<Subscription> = {
            let mut held = self.subscribed.lock();
            held.retain(|s| wanted.contains(s));
            wanted.into_iter().filter(|s| !held.contains(s)).collect()
        };
        let calls = missing.into_iter().map(|sub| {
            let household_id = household_id.clone();
            async move {
                let (ip, namespace, id) = &sub;
                let target = match *namespace {
                    GROUP_VOLUME => Target::Group(id.clone()),
                    _ => Target::Player(id.clone()),
                };
                let cmd = Command::new(namespace, "subscribe", target);
                match self.hub.call(ip, &household_id, &cmd).await {
                    Ok(_) => {
                        self.subscribed.lock().insert(sub);
                    }
                    Err(e) => log::warn!("[Lan] {ip}: {namespace} subscribe for {id}: {e}"),
                }
            }
        });
        join_all(calls).await;
    }

    /// Forgets the subscriptions held on `ip`'s socket, which closed.
    pub fn socket_closed(&self, ip: &str) {
        self.subscribed.lock().retain(|(at, _, _)| at != ip);
    }

    /// The group led by the player at `ip`, from the last groups read, or
    /// from a fresh read when that one names none.
    async fn group_led_by(&self, ip: &str, household_id: &str) -> SoapResult<String> {
        let player = self.player(ip)?;
        let led = |groups: &Groups| {
            groups
                .groups
                .iter()
                .find(|g| g.coordinator_id == player)
                .map(|g| g.id.clone())
        };
        if let Some(id) = led(&self.groups.read()) {
            return Ok(id);
        }
        led(&self.read_groups(ip, household_id).await?)
            .ok_or_else(|| transport_error(code::BAD_REPLY, format!("{ip} leads no group")))
    }

    /// Sends a `playerVolume` command for the room at `ip`, on its socket.
    async fn room(
        &self,
        ip: &str,
        command: &'static str,
        body: serde_json::Value,
    ) -> SoapResult<serde_json::Value> {
        let household_id = self.household()?;
        let cmd =
            Command::new(PLAYER_VOLUME, command, Target::Player(self.player(ip)?)).with_body(body);
        Ok(self
            .hub
            .call(ip, &household_id, &cmd)
            .await?
            .frame()
            .body
            .clone())
    }

    /// Sends a `groupVolume` command for the group led by the player at
    /// `ip`, on its socket.
    async fn group(
        &self,
        ip: &str,
        command: &'static str,
        body: serde_json::Value,
    ) -> SoapResult<serde_json::Value> {
        self.on_group(ip, GROUP_VOLUME, command, body).await
    }

    /// Sends a command in `namespace` for the group led by the player at
    /// `ip`, on its socket, and returns the reply's body. A refusal after the
    /// group changed is sent once more, to the group a fresh read names.
    pub(super) async fn on_group(
        &self,
        ip: &str,
        namespace: &'static str,
        command: &'static str,
        body: serde_json::Value,
    ) -> SoapResult<serde_json::Value> {
        Ok(self.on_group_at(ip, namespace, command, body).await?.0)
    }

    /// [`Self::on_group`], with the speaker that answered: another one than
    /// `ip` when the group's coordinator moved and the command followed it.
    pub(super) async fn on_group_at(
        &self,
        ip: &str,
        namespace: &'static str,
        command: &'static str,
        body: serde_json::Value,
    ) -> SoapResult<(serde_json::Value, String)> {
        let household_id = self.household()?;
        let group_id = self.group_led_by(ip, &household_id).await?;
        let send = |group_id: String| {
            let cmd =
                Command::new(namespace, command, Target::Group(group_id)).with_body(body.clone());
            let household_id = household_id.clone();
            async move { self.hub.call(ip, &household_id, &cmd).await }
        };
        let answer = |reply: super::hub::HubReply| (reply.frame().body.clone(), reply.ip);
        match send(group_id.clone()).await {
            Ok(reply) => Ok(answer(reply)),
            Err(e @ SoapError::Lan { .. }) if !e.is_transient() => {
                self.read_groups(ip, &household_id).await?;
                let now = self.group_led_by(ip, &household_id).await?;
                if now == group_id {
                    return Err(e);
                }
                Ok(answer(send(now).await?))
            }
            Err(e) => Err(e),
        }
    }
}

#[async_trait]
impl SonosVolumeControl for LanClient {
    async fn get_group_volume(&self, coordinator_ip: &str) -> SoapResult<u8> {
        let body = self.group(coordinator_ip, "getVolume", json!({})).await?;
        Ok(VolumeState::from_body(&body)?.volume)
    }

    async fn set_group_volume(&self, coordinator_ip: &str, volume: u8) -> SoapResult<()> {
        self.group(
            coordinator_ip,
            "setVolume",
            json!({ "volume": volume.min(100) }),
        )
        .await
        .map(drop)
    }

    async fn get_group_mute(&self, coordinator_ip: &str) -> SoapResult<bool> {
        let body = self.group(coordinator_ip, "getVolume", json!({})).await?;
        Ok(VolumeState::from_body(&body)?.muted)
    }

    async fn set_group_mute(&self, coordinator_ip: &str, mute: bool) -> SoapResult<()> {
        self.group(coordinator_ip, "setMute", json!({ "muted": mute }))
            .await
            .map(drop)
    }

    async fn get_speaker_volume(&self, speaker_ip: &str) -> SoapResult<u8> {
        let body = self.room(speaker_ip, "getVolume", json!({})).await?;
        Ok(VolumeState::from_body(&body)?.volume)
    }

    async fn set_speaker_volume(&self, speaker_ip: &str, volume: u8) -> SoapResult<()> {
        self.room(
            speaker_ip,
            "setVolume",
            json!({ "volume": volume.min(100) }),
        )
        .await
        .map(drop)
    }

    async fn get_speaker_output_fixed(&self, speaker_ip: &str) -> SoapResult<bool> {
        let body = self.room(speaker_ip, "getVolume", json!({})).await?;
        Ok(VolumeState::from_body(&body)?.fixed)
    }

    async fn get_speaker_mute(&self, speaker_ip: &str) -> SoapResult<bool> {
        let body = self.room(speaker_ip, "getVolume", json!({})).await?;
        Ok(VolumeState::from_body(&body)?.muted)
    }

    async fn set_speaker_mute(&self, speaker_ip: &str, mute: bool) -> SoapResult<()> {
        self.room(speaker_ip, "setMute", json!({ "muted": mute }))
            .await
            .map(drop)
    }
}

/// `getGroups` in the shape `GetZoneGroupState` gives: each group with its
/// coordinator's address and every member's room and model. A group whose
/// coordinator has no address is left out, as the UPnP parser leaves out one
/// it cannot place.
fn zone_groups(groups: &Groups) -> Vec<ZoneGroup> {
    groups
        .groups
        .iter()
        .filter_map(|group| {
            let coordinator_ip = groups.ip_of(&group.coordinator_id)?.to_string();
            let members: Vec<ZoneGroupMember> = group
                .player_ids
                .iter()
                .filter_map(|id| {
                    let player = groups.players.iter().find(|p| &p.id == id)?;
                    Some(ZoneGroupMember {
                        uuid: player.id.clone(),
                        ip: host_of(&player.websocket_url)?.to_string(),
                        zone_name: player.name.clone(),
                        model: player.model().unwrap_or(UNKNOWN_MODEL).to_string(),
                        invisible: false,
                    })
                })
                .collect();
            let coordinator_name = members
                .iter()
                .find(|m| m.uuid == group.coordinator_id)
                .map(|m| m.zone_name.clone());
            Some(ZoneGroup {
                id: group.id.clone(),
                name: group_name(coordinator_name.as_deref(), &members),
                coordinator_uuid: group.coordinator_id.clone(),
                coordinator_ip,
                members,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sonos::lan::fake::{ok, Act, FakeConnector, FakeSpeaker};
    use crate::sonos::lan::protocol::tests::recorded;
    use crate::sonos::lan::protocol::Frame;
    use crate::sonos::soap::SoapError;
    use serde_json::json;

    const HH: &str = "Sonos_HOUSEHOLD0000000000000000000";
    const OFFICE: &str = "192.168.1.10";
    const OFFICE_ID: &str = "RINCON_000000000A0101400";

    fn groups_body() -> serde_json::Value {
        Frame::parse(&recorded("reply_get_groups")).unwrap().body
    }

    /// A household whose Office answers `getGroups` with the recorded reply.
    /// The command a frame carries.
    fn command(f: &Frame) -> &str {
        f.header["command"].as_str().unwrap_or_default()
    }

    /// A household whose Office answers `getGroups` with the recorded reply
    /// and every volume command with level 48. Its other players have no
    /// fake, so they cannot be reached.
    async fn office() -> (Arc<FakeConnector>, FakeSpeaker) {
        let speaker = FakeSpeaker::start(|f| match command(f) {
            "getGroups" => vec![ok(groups_body())],
            _ => vec![ok(json!({ "volume": 48, "muted": false, "fixed": false }))],
        })
        .await;
        let connector = Arc::new(FakeConnector::default());
        connector.add(OFFICE, &speaker);
        connector
            .infos
            .lock()
            .insert(OFFICE.into(), recorded("local_info"));
        (connector, speaker)
    }

    #[tokio::test]
    async fn detection_learns_the_household_from_the_player_it_expected() {
        let (connector, speaker) = office().await;
        let lan = LanClient::new(connector.clone());

        let snapshot = lan.zone_groups(OFFICE, OFFICE_ID).await.unwrap();
        assert_eq!(lan.household_id().as_deref(), Some(HH));
        let expected = connector.expected.lock().clone();
        assert_eq!(
            expected[..2],
            [
                SpeakerIdentity {
                    player_id: OFFICE_ID.into(),
                    household_id: None,
                },
                SpeakerIdentity {
                    player_id: OFFICE_ID.into(),
                    household_id: Some(HH.into()),
                },
            ]
        );
        assert_eq!(speaker.received.lock()[0].household_id(), Some(HH));
        assert_eq!(snapshot.groups.len(), 3);
        assert!(snapshot.household.groups.is_empty());

        // Known now: a second read asks for no description, and every
        // socket expects the household.
        lan.zone_groups(OFFICE, OFFICE_ID).await.unwrap();
        let expected = connector.expected.lock().clone();
        assert_eq!(
            expected.iter().filter(|e| e.household_id.is_none()).count(),
            1
        );
    }

    #[tokio::test]
    async fn a_read_subscribes_each_room_s_level_and_each_group_s_on_its_coordinator() {
        let (connector, speaker) = office().await;
        let lan = LanClient::new(connector.clone());
        lan.zone_groups(OFFICE, OFFICE_ID).await.unwrap();

        let subscribed: Vec<(String, Option<String>, Option<String>)> = speaker
            .received
            .lock()
            .iter()
            .filter(|f| command(f) == "subscribe")
            .map(|f| {
                (
                    f.namespace().to_string(),
                    f.player_id().map(str::to_string),
                    f.group_id().map(str::to_string),
                )
            })
            .collect();
        assert_eq!(subscribed.len(), 2, "{subscribed:?}");
        assert!(subscribed.contains(&(PLAYER_VOLUME.into(), Some(OFFICE_ID.into()), None)));
        assert!(subscribed.contains(&(
            GROUP_VOLUME.into(),
            None,
            Some("RINCON_000000000A0101400:205".into())
        )));
        // Kitchen and the Playbar were tried on their own sockets.
        assert_eq!(connector.attempts("192.168.1.11"), 1);
        assert_eq!(connector.attempts("192.168.1.12"), 1);

        // Held now: a second read asks for nothing more on Office.
        let before = speaker.received.lock().len();
        lan.zone_groups(OFFICE, OFFICE_ID).await.unwrap();
        assert_eq!(speaker.received.lock().len(), before + 1);

        // A closed socket loses them, and they are asked for again.
        lan.socket_closed(OFFICE);
        lan.ensure_subscriptions().await;
        assert_eq!(speaker.received.lock().len(), before + 3);
    }

    #[tokio::test]
    async fn a_room_s_level_goes_to_its_player_and_a_group_s_to_the_group_it_leads() {
        let (connector, speaker) = office().await;
        let lan = LanClient::new(connector);
        lan.zone_groups(OFFICE, OFFICE_ID).await.unwrap();
        let from = speaker.received.lock().len();

        assert_eq!(lan.get_speaker_volume(OFFICE).await.unwrap(), 48);
        assert!(!lan.get_speaker_output_fixed(OFFICE).await.unwrap());
        lan.set_speaker_volume(OFFICE, 130).await.unwrap();
        lan.set_speaker_mute(OFFICE, true).await.unwrap();
        assert_eq!(lan.get_group_volume(OFFICE).await.unwrap(), 48);
        lan.set_group_mute(OFFICE, false).await.unwrap();

        let sent: Vec<(String, String, serde_json::Value, Option<String>)> =
            speaker.received.lock()[from..]
                .iter()
                .map(|f| {
                    (
                        f.namespace().to_string(),
                        command(f).to_string(),
                        f.body.clone(),
                        f.player_id().or(f.group_id()).map(str::to_string),
                    )
                })
                .collect();
        let office = Some(OFFICE_ID.to_string());
        let group = Some("RINCON_000000000A0101400:205".to_string());
        assert_eq!(
            sent,
            [
                (
                    PLAYER_VOLUME.into(),
                    "getVolume".into(),
                    json!({}),
                    office.clone()
                ),
                (
                    PLAYER_VOLUME.into(),
                    "getVolume".into(),
                    json!({}),
                    office.clone()
                ),
                (
                    PLAYER_VOLUME.into(),
                    "setVolume".into(),
                    json!({ "volume": 100 }),
                    office.clone()
                ),
                (
                    PLAYER_VOLUME.into(),
                    "setMute".into(),
                    json!({ "muted": true }),
                    office
                ),
                (
                    GROUP_VOLUME.into(),
                    "getVolume".into(),
                    json!({}),
                    group.clone()
                ),
                (
                    GROUP_VOLUME.into(),
                    "setMute".into(),
                    json!({ "muted": false }),
                    group
                ),
            ]
        );
    }

    #[tokio::test]
    async fn a_group_command_refused_after_a_regroup_goes_to_the_group_a_fresh_read_names() {
        let reads = Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let counter = Arc::clone(&reads);
        let speaker = FakeSpeaker::start(move |f| match command(f) {
            "getGroups" => {
                let mut body = groups_body();
                if counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst) > 0 {
                    body["groups"][0]["id"] = "RINCON_000000000A0101400:206".into();
                }
                vec![ok(body)]
            }
            "setVolume" if f.group_id() == Some("RINCON_000000000A0101400:205") => {
                vec![Act::Reply {
                    success: false,
                    body: json!({ "_objectType": "globalError", "errorCode": "ERROR_INVALID_OBJECT_ID" }),
                }]
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
        let lan = LanClient::new(connector);
        lan.zone_groups(OFFICE, OFFICE_ID).await.unwrap();

        lan.set_group_volume(OFFICE, 20).await.unwrap();
        let sets: Vec<Option<String>> = speaker
            .received
            .lock()
            .iter()
            .filter(|f| command(f) == "setVolume")
            .map(|f| f.group_id().map(str::to_string))
            .collect();
        assert_eq!(
            sets,
            [
                Some("RINCON_000000000A0101400:205".to_string()),
                Some("RINCON_000000000A0101400:206".to_string())
            ]
        );
    }

    #[tokio::test]
    async fn volume_needs_a_known_household_and_player() {
        let lan = LanClient::new(Arc::new(FakeConnector::default()));
        for result in [
            lan.get_speaker_volume(OFFICE).await.map(drop),
            lan.set_group_volume(OFFICE, 5).await,
        ] {
            match result {
                Err(SoapError::Lan { code: c, .. }) => assert_eq!(c, code::CONNECT_FAILED),
                other => panic!("unexpected {other:?}"),
            }
        }
    }

    #[tokio::test]
    async fn groups_read_as_zone_groups_with_addresses_rooms_and_models() {
        let (connector, _speaker) = office().await;
        let lan = LanClient::new(connector);
        let groups = lan.zone_groups(OFFICE, OFFICE_ID).await.unwrap().groups;

        let office = &groups[0];
        assert_eq!(office.id, "RINCON_000000000A0101400:205");
        assert_eq!(office.name, "Office");
        assert_eq!(office.coordinator_uuid, OFFICE_ID);
        assert_eq!(office.coordinator_ip, OFFICE);
        assert_eq!(office.members.len(), 1);
        assert_eq!(office.members[0].ip, OFFICE);
        assert_eq!(office.members[0].zone_name, "Office");
        assert_eq!(office.members[0].model, "Play:1");
        assert!(!office.members[0].invisible);
        assert_eq!(groups[2].members[0].model, "Playbar");
        assert_eq!(groups[2].coordinator_ip, "192.168.1.12");
    }

    #[test]
    fn a_grouped_room_is_named_as_on_port_1400_and_a_placeless_group_is_left_out() {
        let mut body = groups_body();
        body["groups"][0]["playerIds"] = serde_json::json!([OFFICE_ID, "RINCON_000000000B0101400"]);
        body["groups"][1]["coordinatorId"] = "RINCON_UNLISTED".into();
        let groups = zone_groups(&Groups::from_body(&body).unwrap());
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].name, "Office, Kitchen");
        assert_eq!(groups[0].members.len(), 2);
        assert_eq!(groups[1].name, "Living Room");
    }

    #[tokio::test]
    async fn a_player_that_describes_itself_as_another_is_refused() {
        let (connector, _speaker) = office().await;
        let lan = LanClient::new(connector);
        match lan.zone_groups(OFFICE, "RINCON_000000000B0101400").await {
            Err(SoapError::Lan { code: c, .. }) => assert_eq!(c, code::BAD_REPLY),
            other => panic!("unexpected {other:?}"),
        }
        assert_eq!(lan.household_id(), None);
    }

    #[tokio::test]
    async fn no_description_means_no_route() {
        let connector = Arc::new(FakeConnector::default());
        let lan = LanClient::new(connector);
        match lan.zone_groups(OFFICE, OFFICE_ID).await {
            Err(SoapError::Lan { code: c, .. }) => assert_eq!(c, code::CONNECT_FAILED),
            other => panic!("unexpected {other:?}"),
        }
    }

    #[tokio::test]
    async fn authentication_on_reads_as_upnp_off_and_a_forgotten_household_is_learnt_again() {
        let speaker = FakeSpeaker::start(|_| {
            vec![Act::Raw(
                recorded("reply_no_permission").replace("\"c1\"", "\"{cmdId}\""),
            )]
        })
        .await;
        let connector = Arc::new(FakeConnector::default());
        connector.add(OFFICE, &speaker);
        connector
            .infos
            .lock()
            .insert(OFFICE.into(), recorded("local_info"));
        let lan = LanClient::new(connector.clone());

        assert!(matches!(
            lan.zone_groups(OFFICE, OFFICE_ID).await,
            Err(SoapError::UpnpDisabled)
        ));
        lan.forget_household();
        assert_eq!(lan.household_id(), None);
        let _ = lan.zone_groups(OFFICE, OFFICE_ID).await;
        assert_eq!(
            connector
                .expected
                .lock()
                .iter()
                .filter(|e| e.household_id.is_none())
                .count(),
            2
        );
    }
}

/// A read-only check against a real speaker, run by hand:
/// `THAUMIC_LAN_IP=… THAUMIC_LAN_PLAYER=RINCON_… THAUMIC_LAN_HH=Sonos_… cargo test -p thaumic-core --lib lan::client::hardware -- --ignored`
#[cfg(test)]
mod hardware {
    use std::sync::Arc;

    use super::LanClient;
    use crate::sonos::lan::hub::CONNECT_TIMEOUT;
    use crate::sonos::lan::TlsConnector;
    use crate::sonos::traits::SonosVolumeControl;

    fn env(name: &str) -> String {
        std::env::var(name).unwrap_or_else(|_| panic!("set {name}"))
    }

    #[tokio::test]
    #[ignore = "needs a speaker on the LAN"]
    async fn a_real_household_is_detected_and_read_as_zone_groups() {
        let (ip, player, hh) = (
            env("THAUMIC_LAN_IP"),
            env("THAUMIC_LAN_PLAYER"),
            env("THAUMIC_LAN_HH"),
        );
        let lan = LanClient::new(Arc::new(TlsConnector::new(CONNECT_TIMEOUT)));
        let snapshot = lan.zone_groups(&ip, &player).await.expect("detection");
        assert_eq!(lan.household_id(), Some(hh));
        for group in &snapshot.groups {
            println!(
                "{} ({}) at {}: {:?}",
                group.name,
                group.id,
                group.coordinator_ip,
                group
                    .members
                    .iter()
                    .map(|m| (m.zone_name.as_str(), m.ip.as_str(), m.model.as_str()))
                    .collect::<Vec<_>>()
            );
        }
        assert!(snapshot
            .groups
            .iter()
            .any(|g| g.members.iter().any(|m| m.uuid == player && m.ip == ip)));

        // Reads only: the room's own level and its group's.
        let own = lan.get_speaker_volume(&ip).await.expect("room level");
        let fixed = lan.get_speaker_output_fixed(&ip).await.expect("fixed");
        let muted = lan.get_speaker_mute(&ip).await.expect("room mute");
        let group = lan.get_group_volume(&ip).await.expect("group level");
        println!("room {own} (muted {muted}, fixed {fixed}), group {group}");
    }
}
