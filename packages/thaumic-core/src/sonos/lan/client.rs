//! The household as the services see it over the local Control API.
//!
//! Detection learns the household id from a player's description of itself,
//! asked for over a connection checked for that player, and the topology is
//! read with `groups:1 getGroups` and given the shape `GetZoneGroupState`
//! gives on port 1400. Every player that read lists is made known to the hub
//! at its address, so later sockets can be checked for it.

use std::sync::Arc;

use parking_lot::RwLock;

use super::hub::LanHub;
use super::protocol::{code, host_of, transport_error, Groups, LocalInfo, SpeakerIdentity};
use super::socket::LanConnector;
use crate::error::SoapResult;
use crate::sonos::types::{HouseholdTopology, ZoneGroup, ZoneGroupMember, ZoneGroupSnapshot};
use crate::sonos::zone_groups::group_name;

/// What a member's model reads as when Sonos does not name it.
const UNKNOWN_MODEL: &str = "Speaker";

/// The household over port 1443.
pub struct LanClient {
    connector: Arc<dyn LanConnector>,
    hub: LanHub,
    /// The household id, once detection has learnt it.
    household_id: RwLock<Option<String>>,
}

impl LanClient {
    /// A client whose sockets and requests go through `connector`.
    #[must_use]
    pub fn new(connector: Arc<dyn LanConnector>) -> Self {
        Self {
            hub: LanHub::new(Arc::clone(&connector)),
            connector,
            household_id: RwLock::new(None),
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
    /// route that stopped working, whose household may have changed.
    pub fn forget_household(&self) {
        *self.household_id.write() = None;
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
        let groups = self.hub.groups(ip, &household_id).await?;
        for player in &groups.players {
            if let Some(at) = host_of(&player.websocket_url) {
                self.hub.know(at, &player.id);
            }
        }
        Ok(ZoneGroupSnapshot {
            groups: zone_groups(&groups),
            household: HouseholdTopology::default(),
        })
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

    const HH: &str = "Sonos_HOUSEHOLD0000000000000000000";
    const OFFICE: &str = "192.168.1.10";
    const OFFICE_ID: &str = "RINCON_000000000A0101400";

    fn groups_body() -> serde_json::Value {
        Frame::parse(&recorded("reply_get_groups")).unwrap().body
    }

    /// A household whose Office answers `getGroups` with the recorded reply.
    async fn office() -> (Arc<FakeConnector>, FakeSpeaker) {
        let speaker = FakeSpeaker::start(|f| {
            assert_eq!(f.header["command"], "getGroups");
            vec![ok(groups_body())]
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
            expected,
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

        // Known now: a second read asks for no description.
        lan.zone_groups(OFFICE, OFFICE_ID).await.unwrap();
        assert_eq!(connector.expected.lock().len(), 2);
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
    }
}
