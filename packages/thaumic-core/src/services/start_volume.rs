//! The level each room starts a cast at.
//!
//! A cast used to start at whatever level the room was left at, which after a
//! party can be 80 or more. The client now sends a limit ("start no louder
//! than") and, optionally, a level the user set by hand for a room before
//! pressing Cast, keyed by the room's player UUID. Before anything is played, each room of each target is:
//!
//! - left alone if its output is fixed (line level: the amplifier sets it);
//! - set to its own hand-set level, if there is one, even above the limit,
//!   since that is the user's own choice (a grouped partner without one
//!   follows the limit);
//! - otherwise turned down to the limit if it is above it, and never turned
//!   up;
//! - set to the limit if its level cannot be read, because safety comes first.
//!
//! Each room is set with its own `RenderingControl.SetVolume`, never
//! `SetGroupVolume`: that scales every room in proportion, so a group at
//! Kitchen 72 and Dining 20 would end at 30 and 8 instead of 30 and 20.
//!
//! The level is always read from the speaker. The GENA cache is not used: it
//! has no timestamp, so a stale value cannot be told from a fresh one, and it
//! holds the group volume for a coordinator rather than each room's own.
//!
//! With no limit and no hand-set level nothing is read or set, so an older
//! client that sends neither behaves exactly as before.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::Deserialize;

use crate::sonos::traits::SonosVolumeControl;
use crate::sonos::types::{ZoneGroup, ZoneGroupMember};
use crate::state::SonosState;

/// How long one read or write of a room's volume may take before the room is
/// treated as unreadable. Short, because the cast waits for it.
const START_VOLUME_SOAP_TIMEOUT: Duration = Duration::from_secs(2);

/// The highest level Sonos accepts.
const MAX_VOLUME: u8 = 100;

/// What the client asked for, carried on `START_PLAYBACK` as `startVolume`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartVolumeRequest {
    /// The highest level a room may start at (0-100). `None` means the user
    /// turned the limit off.
    #[serde(default)]
    pub limit: Option<u8>,
    /// Levels the user set by hand before Cast, keyed by the room's player
    /// UUID (`RINCON_…`). Each applies to that room only.
    #[serde(default)]
    pub rooms: HashMap<String, u8>,
}

impl StartVolumeRequest {
    /// Whether the request can change anything at all.
    #[must_use]
    pub fn is_noop(&self) -> bool {
        self.limit.is_none() && self.rooms.is_empty()
    }

    /// The limit, clamped to the Sonos range.
    fn limit(&self) -> Option<u8> {
        self.limit.map(|limit| limit.min(MAX_VOLUME))
    }

    /// The hand-set level for the room `uuid`, clamped to the Sonos range.
    fn hand_set(&self, uuid: &str) -> Option<u8> {
        self.rooms.get(uuid).map(|level| (*level).min(MAX_VOLUME))
    }
}

/// What was read from one room before the cast starts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct RoomReading {
    /// The room's own volume, or `None` if it could not be read.
    pub volume: Option<u8>,
    /// Whether the room's output is fixed (line level).
    pub fixed: bool,
}

/// The level to set a room to before the cast starts, or `None` to leave it
/// as it is. See the module documentation for the rule.
#[must_use]
pub(crate) fn plan_room(
    reading: RoomReading,
    limit: Option<u8>,
    hand_set: Option<u8>,
) -> Option<u8> {
    if reading.fixed {
        return None;
    }
    if let Some(level) = hand_set {
        return (reading.volume != Some(level)).then_some(level);
    }
    let limit = limit?;
    match reading.volume {
        Some(now) if now > limit => Some(limit),
        Some(_) => None,
        None => Some(limit),
    }
}

/// One room of a Sonos group: the device that plays for it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Room {
    /// The primary's player UUID, which names the room.
    pub uuid: String,
    /// The primary's IP.
    pub ip: String,
    /// The coordinator IP of the Sonos group the room is in now.
    pub coordinator_ip: String,
}

/// Folds the topology into rooms, group by group, each group's coordinator
/// first.
///
/// Invisible devices (home-theatre satellites, the second speaker of a stereo
/// pair) play as part of their room's primary and are left out. Members of
/// one group that share a room name are folded too, the first kept, which
/// covers a topology read without the flag. The extension folds the same way
/// (`roomsOf` in protocol); `fixtures/rooms.json` holds both to it.
#[must_use]
pub(crate) fn rooms(groups: &[ZoneGroup]) -> Vec<Room> {
    let mut rooms = Vec::new();
    for group in groups {
        let is_coordinator = |m: &&ZoneGroupMember| m.uuid == group.coordinator_uuid;
        let coordinator = group.members.iter().filter(is_coordinator);
        let others = group.members.iter().filter(|m| !is_coordinator(m));
        let mut seen_names: HashSet<&str> = HashSet::new();
        for member in coordinator.chain(others) {
            if member.invisible || !seen_names.insert(member.zone_name.as_str()) {
                continue;
            }
            rooms.push(Room {
                uuid: member.uuid.clone(),
                ip: member.ip.clone(),
                coordinator_ip: group.coordinator_ip.clone(),
            });
        }
    }
    rooms
}

/// The rooms a target plays on, as `(uuid, ip)` per room.
///
/// A target is a group's coordinator. Every room of its Sonos group is
/// included, the coordinator's first (see [`rooms`]). A target missing from
/// the topology is taken to be a room on its own, named by the UUID of the
/// member with its IP if one is known; with none, no hand-set level can match
/// it and it follows the limit.
#[must_use]
pub(crate) fn target_rooms(groups: &[ZoneGroup], target_ip: &str) -> Vec<(String, String)> {
    let target: Vec<(String, String)> = rooms(groups)
        .into_iter()
        .filter(|room| room.coordinator_ip == target_ip)
        .map(|room| (room.uuid, room.ip))
        .collect();
    if !target.is_empty() {
        return target;
    }
    let uuid = groups
        .iter()
        .flat_map(|g| &g.members)
        .find(|m| m.ip == target_ip)
        .map(|m| m.uuid.clone())
        .unwrap_or_default();
    vec![(uuid, target_ip.to_string())]
}

/// Reads one room's volume and whether its output is fixed.
///
/// A fixed flag that cannot be read counts as not fixed: setting the volume
/// of a fixed output only fails, it does no harm.
async fn read_room(sonos: &dyn SonosVolumeControl, ip: &str) -> RoomReading {
    let (fixed, volume) = futures::future::join(
        tokio::time::timeout(
            START_VOLUME_SOAP_TIMEOUT,
            sonos.get_speaker_output_fixed(ip),
        ),
        tokio::time::timeout(START_VOLUME_SOAP_TIMEOUT, sonos.get_speaker_volume(ip)),
    )
    .await;
    let fixed = match fixed {
        Ok(Ok(fixed)) => fixed,
        Ok(Err(e)) => {
            log::debug!("[StartVolume] {ip}: could not read whether the output is fixed: {e}");
            false
        }
        Err(_) => {
            log::debug!("[StartVolume] {ip}: no answer on whether the output is fixed");
            false
        }
    };
    let volume = match volume {
        Ok(Ok(volume)) => Some(volume),
        Ok(Err(e)) => {
            log::debug!("[StartVolume] {ip}: could not read the volume: {e}");
            None
        }
        Err(_) => {
            log::debug!("[StartVolume] {ip}: no answer when reading the volume");
            None
        }
    };
    RoomReading { volume, fixed }
}

/// Reads, decides and sets one room.
async fn start_room(
    sonos: &dyn SonosVolumeControl,
    ip: &str,
    limit: Option<u8>,
    hand_set: Option<u8>,
) {
    let reading = read_room(sonos, ip).await;
    let Some(level) = plan_room(reading, limit, hand_set) else {
        log::debug!(
            "[StartVolume] {ip}: left as it is (now {:?}, fixed {}, limit {:?}, hand-set {:?})",
            reading.volume,
            reading.fixed,
            limit,
            hand_set
        );
        return;
    };
    match tokio::time::timeout(
        START_VOLUME_SOAP_TIMEOUT,
        sonos.set_speaker_volume(ip, level),
    )
    .await
    {
        Ok(Ok(())) => log::debug!(
            "[StartVolume] {ip}: set to {level} (was {:?}, limit {:?}, hand-set {:?})",
            reading.volume,
            limit,
            hand_set
        ),
        Ok(Err(e)) => log::warn!("[StartVolume] {ip}: could not set the start level {level}: {e}"),
        Err(_) => log::warn!("[StartVolume] {ip}: no answer when setting the start level {level}"),
    }
}

/// Sets the start level of every room of every target, before playback.
///
/// Runs the rooms concurrently and returns once every one has been read and,
/// where the rule says so, set. Failures are logged; the cast goes ahead.
///
/// # Arguments
/// * `sonos` - Volume control for the speakers
/// * `sonos_state` - The topology, for each target's rooms and fixed outputs
/// * `targets` - The speakers about to start (group coordinators)
/// * `request` - The limit and hand-set levels the client sent
pub(crate) async fn apply_start_volume(
    sonos: &dyn SonosVolumeControl,
    sonos_state: &SonosState,
    targets: &[String],
    request: &StartVolumeRequest,
) {
    if request.is_noop() || targets.is_empty() {
        return;
    }
    let limit = request.limit();
    let groups = sonos_state.groups.read().clone();

    let mut seen: HashSet<String> = HashSet::new();
    let mut starts: Vec<(String, Option<u8>)> = Vec::new();
    for target in targets {
        // The group's own flag, from GENA, covers a group whose rooms all
        // play at line level; each room is still asked for itself below.
        if sonos_state
            .group_volume_fixed
            .get(target)
            .is_some_and(|fixed| *fixed)
        {
            log::debug!("[StartVolume] {target}: fixed output, left as it is");
            continue;
        }
        for (uuid, ip) in target_rooms(&groups, target) {
            let hand_set = request.hand_set(&uuid);
            if limit.is_none() && hand_set.is_none() {
                continue;
            }
            if seen.insert(ip.clone()) {
                starts.push((ip, hand_set));
            }
        }
    }

    let starts = starts
        .iter()
        .map(|(ip, hand_set)| start_room(sonos, ip, limit, *hand_set));
    futures::future::join_all(starts).await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reading(volume: Option<u8>) -> RoomReading {
        RoomReading {
            volume,
            fixed: false,
        }
    }

    #[test]
    fn a_room_above_the_limit_is_turned_down_to_it() {
        assert_eq!(plan_room(reading(Some(72)), Some(30), None), Some(30));
    }

    #[test]
    fn a_room_at_or_below_the_limit_is_left_alone() {
        assert_eq!(plan_room(reading(Some(30)), Some(30), None), None);
        assert_eq!(plan_room(reading(Some(10)), Some(30), None), None);
        assert_eq!(plan_room(reading(Some(0)), Some(30), None), None);
    }

    #[test]
    fn a_room_that_cannot_be_read_is_set_to_the_limit() {
        assert_eq!(plan_room(reading(None), Some(30), None), Some(30));
    }

    #[test]
    fn a_hand_set_level_wins_even_above_the_limit() {
        assert_eq!(plan_room(reading(Some(20)), Some(30), Some(45)), Some(45));
        assert_eq!(plan_room(reading(Some(72)), Some(30), Some(12)), Some(12));
        assert_eq!(plan_room(reading(None), Some(30), Some(45)), Some(45));
        assert_eq!(plan_room(reading(Some(20)), None, Some(45)), Some(45));
    }

    #[test]
    fn a_hand_set_level_the_room_is_already_at_sends_nothing() {
        assert_eq!(plan_room(reading(Some(45)), Some(30), Some(45)), None);
    }

    #[test]
    fn a_fixed_output_is_never_set() {
        let fixed = |volume| RoomReading {
            volume,
            fixed: true,
        };
        assert_eq!(plan_room(fixed(Some(100)), Some(30), None), None);
        assert_eq!(plan_room(fixed(None), Some(30), None), None);
        assert_eq!(plan_room(fixed(Some(100)), Some(30), Some(20)), None);
    }

    #[test]
    fn with_the_limit_off_and_no_hand_set_level_nothing_changes() {
        assert_eq!(plan_room(reading(Some(90)), None, None), None);
        assert_eq!(plan_room(reading(None), None, None), None);
    }

    #[test]
    fn out_of_range_levels_are_clamped_to_100() {
        let request = StartVolumeRequest {
            limit: Some(200),
            rooms: HashMap::from([("RINCON_A".to_string(), 150)]),
        };
        assert_eq!(request.limit(), Some(100));
        assert_eq!(request.hand_set("RINCON_A"), Some(100));
    }

    #[test]
    fn the_request_parses_from_the_wire_and_defaults_to_no_change() {
        let full: StartVolumeRequest = serde_json::from_value(serde_json::json!({
            "limit": 30,
            "rooms": { "RINCON_A": 45 }
        }))
        .unwrap();
        assert_eq!(full.limit, Some(30));
        assert_eq!(full.rooms.get("RINCON_A"), Some(&45));
        assert!(!full.is_noop());

        let empty: StartVolumeRequest = serde_json::from_value(serde_json::json!({})).unwrap();
        assert!(empty.is_noop());
    }

    fn ips(rooms: Vec<(String, String)>) -> Vec<String> {
        rooms.into_iter().map(|(_, ip)| ip).collect()
    }

    fn member(ip: &str, zone: &str, invisible: bool) -> ZoneGroupMember {
        ZoneGroupMember {
            uuid: format!("RINCON_{ip}"),
            ip: ip.to_string(),
            zone_name: zone.to_string(),
            model: "One".to_string(),
            invisible,
        }
    }

    fn group(coordinator: &str, members: Vec<ZoneGroupMember>) -> ZoneGroup {
        ZoneGroup {
            id: format!("{coordinator}:1"),
            name: "group".to_string(),
            coordinator_uuid: format!("RINCON_{coordinator}"),
            coordinator_ip: coordinator.to_string(),
            members,
        }
    }

    #[test]
    fn every_room_of_a_sonos_group_is_a_target_room_coordinator_first() {
        let groups = vec![group(
            "10.0.0.2",
            vec![
                member("10.0.0.3", "Dining Room", false),
                member("10.0.0.2", "Kitchen", false),
            ],
        )];
        assert_eq!(
            ips(target_rooms(&groups, "10.0.0.2")),
            ["10.0.0.2", "10.0.0.3"]
        );
    }

    #[test]
    fn satellites_and_stereo_partners_follow_their_primary() {
        let groups = vec![group(
            "10.0.0.2",
            vec![
                member("10.0.0.2", "Living Room", false),
                member("10.0.0.4", "Living Room", true),
                member("10.0.0.5", "Living Room", true),
                member("10.0.0.6", "Study", false),
                member("10.0.0.7", "Study", true),
            ],
        )];
        assert_eq!(
            ips(target_rooms(&groups, "10.0.0.2")),
            ["10.0.0.2", "10.0.0.6"]
        );
    }

    #[test]
    fn rooms_fold_the_shared_fixture_as_the_extension_does() {
        // packages/protocol's roomsOf folds the same file to the same rooms.
        const ROOMS: &str = include_str!("../../../protocol/fixtures/rooms.json");
        let fixture: serde_json::Value = serde_json::from_str(ROOMS).expect("rooms.json is JSON");
        let groups: Vec<ZoneGroup> =
            serde_json::from_value(fixture["groups"].clone()).expect("the groups parse");

        let mut got: Vec<(String, String, String)> = rooms(&groups)
            .into_iter()
            .map(|room| (room.uuid, room.ip, room.coordinator_ip))
            .collect();
        got.sort();
        let mut want: Vec<(String, String, String)> = fixture["rooms"]
            .as_array()
            .expect("a rooms list")
            .iter()
            .map(|room| {
                let field = |key: &str| room[key].as_str().expect(key).to_string();
                (field("id"), field("ip"), field("coordinatorIp"))
            })
            .collect();
        want.sort();
        assert_eq!(got, want);
    }

    #[test]
    fn a_target_missing_from_the_topology_is_a_room_on_its_own() {
        assert_eq!(
            target_rooms(&[], "10.0.0.9"),
            [(String::new(), "10.0.0.9".to_string())]
        );
    }

    #[test]
    fn target_rooms_are_named_by_their_primary_uuid() {
        let groups = vec![group(
            "10.0.0.2",
            vec![
                member("10.0.0.2", "Kitchen", false),
                member("10.0.0.3", "Patio", false),
            ],
        )];
        let uuids: Vec<String> = target_rooms(&groups, "10.0.0.2")
            .into_iter()
            .map(|(uuid, _)| uuid)
            .collect();
        assert_eq!(uuids, ["RINCON_10.0.0.2", "RINCON_10.0.0.3"]);
    }

    #[test]
    fn a_pair_without_the_flag_folds_by_name_onto_the_coordinator() {
        let groups = vec![group(
            "10.0.0.5",
            vec![
                member("10.0.0.4", "Bedroom", false),
                member("10.0.0.5", "Bedroom", false),
            ],
        )];
        assert_eq!(ips(target_rooms(&groups, "10.0.0.5")), ["10.0.0.5"]);
    }
}
