//! Planning a cast to rooms as one Sonos group.
//!
//! A cast names the rooms it plays (player UUIDs of room primaries) and plays
//! exactly those, as one Sonos group: rooms that were not chosen keep playing
//! whatever they were playing. This module decides, from the household's
//! grouping alone, which room leads the cast's group and which rooms have to
//! move to join it. It does no I/O; the stream coordinator carries the plan
//! out.
//!
//! The rules, in order:
//!
//! 1. **Rooms, not players.** Home-theatre satellites and the second speaker
//!    of a stereo pair fold into their room's primary
//!    ([`super::start_volume::rooms`]), so no call ever names one.
//! 2. **An exact group.** When the chosen rooms are exactly one Sonos group,
//!    the stream goes to that group's coordinator and nothing moves.
//! 3. **A running cast** keeps its coordinator: the chosen rooms already in
//!    its group stay, and the rest join it.
//! 4. **Otherwise** the coordinator is a chosen room that coordinates a group
//!    made only of chosen rooms, the largest such group first, then the
//!    order chosen; failing that (every chosen room shares a group with a
//!    room that was not chosen) the first chosen room that is a member of
//!    its group rather than its coordinator, since a member hands nothing on
//!    when it leaves, else the first chosen room. A chosen room in a
//!    group that also holds rooms not chosen always moves, whoever leads, so
//!    the choice never changes whose music restarts: it only keeps the moves
//!    few.
//!
//! Every chosen room that was in a group of two or more rooms records that
//! group ([`OldGroup`]) so it can be put back when the cast stops.

use std::collections::{HashMap, HashSet};

use crate::sonos::types::ZoneGroup;

use super::start_volume::rooms;

/// One room, by the player UUID and IP of its primary.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RoomRef {
    /// The primary's player UUID (`RINCON_…`), which names the room.
    pub uuid: String,
    /// The primary's IP.
    pub ip: String,
}

/// The Sonos group a room was in before a cast moved it.
///
/// Kept in memory on the room's playback session and never sent anywhere: a
/// crash loses it, which leaves the room where the cast put it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct OldGroup {
    /// The group's coordinator then.
    pub coordinator_uuid: String,
    /// The group's other rooms then, as primary UUIDs (never satellites).
    pub partners: Vec<String>,
    /// Whether the room stayed in that group for the cast: it is the cast's
    /// coordinator, or one of its rooms that were already grouped with it.
    /// Such a room goes nowhere when the cast stops: the group is still there.
    pub kept: bool,
}

/// A room that joins the cast's group.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct JoinRoom {
    /// The room.
    pub room: RoomRef,
    /// Whether it has to leave a group of other rooms before it joins: a
    /// room is only ever told to join while it stands alone.
    pub leave_first: bool,
}

/// How a cast to rooms is carried out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RegroupPlan {
    /// The room that plays the stream and leads the cast's group.
    pub coordinator: RoomRef,
    /// Whether the coordinator is one of the chosen rooms. Only a running
    /// cast's coordinator can lead without being chosen again.
    pub coordinator_chosen: bool,
    /// Whether the coordinator leaves a group that holds rooms not chosen.
    /// When it led that group, the rooms left behind restart their track.
    pub coordinator_leaves: bool,
    /// Chosen rooms already in the coordinator's group: nothing is sent.
    pub stay: Vec<RoomRef>,
    /// Chosen rooms that join the coordinator's group, in the order chosen.
    pub join: Vec<JoinRoom>,
    /// Chosen UUIDs that name no room in the household.
    pub unknown: Vec<String>,
    /// The group each chosen room was in, for every chosen room that shared
    /// a group with another room, keyed by room UUID.
    pub snapshots: HashMap<String, OldGroup>,
}

/// Why no plan could be made.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum PlanError {
    /// None of the chosen UUIDs names a room in the household.
    NoRooms,
}

/// One Sonos group seen as rooms.
#[derive(Debug, Clone)]
struct GroupRooms {
    coordinator_uuid: String,
    /// The group's rooms, its coordinator's first.
    rooms: Vec<RoomRef>,
}

/// The household's groups as rooms, satellites folded into their primaries.
fn group_rooms(groups: &[ZoneGroup]) -> Vec<GroupRooms> {
    let mut out: Vec<GroupRooms> = groups
        .iter()
        .map(|group| GroupRooms {
            coordinator_uuid: group.coordinator_uuid.clone(),
            rooms: Vec::new(),
        })
        .collect();
    for room in rooms(groups) {
        if let Some(index) = groups
            .iter()
            .position(|g| g.coordinator_ip == room.coordinator_ip)
        {
            out[index].rooms.push(RoomRef {
                uuid: room.uuid,
                ip: room.ip,
            });
        }
    }
    out.retain(|group| !group.rooms.is_empty());
    out
}

/// The room a chosen UUID names: a room primary, or the primary of the room a
/// bonded device (satellite, stereo partner) belongs to.
fn resolve(groups: &[ZoneGroup], view: &[GroupRooms], uuid: &str) -> Option<(usize, RoomRef)> {
    for (index, group) in view.iter().enumerate() {
        if let Some(room) = group.rooms.iter().find(|room| room.uuid == uuid) {
            return Some((index, room.clone()));
        }
    }
    // A bonded device: find the room of the same name in its group.
    let (zone, coordinator_uuid) = groups.iter().find_map(|g| {
        g.members
            .iter()
            .find(|m| m.uuid == uuid)
            .map(|m| (m.zone_name.clone(), g.coordinator_uuid.clone()))
    })?;
    let primary_uuid = groups
        .iter()
        .find(|g| g.coordinator_uuid == coordinator_uuid)?
        .members
        .iter()
        .find(|m| m.zone_name == zone && !m.invisible)?
        .uuid
        .clone();
    view.iter().enumerate().find_map(|(index, group)| {
        group
            .rooms
            .iter()
            .find(|room| room.uuid == primary_uuid)
            .map(|room| (index, room.clone()))
    })
}

/// Plans a cast to `chosen` rooms (player UUIDs, in the order chosen) on the
/// household `groups`. `cast_coordinator` is the UUID of the room leading the
/// stream's running cast, if it has one (an added room, or a resume).
///
/// # Errors
/// [`PlanError::NoRooms`] when no chosen UUID names a room.
pub(crate) fn plan_regroup(
    chosen: &[String],
    groups: &[ZoneGroup],
    cast_coordinator: Option<&str>,
) -> Result<RegroupPlan, PlanError> {
    let view = group_rooms(groups);

    let mut picked: Vec<(usize, RoomRef)> = Vec::new();
    let mut unknown = Vec::new();
    for uuid in chosen {
        match resolve(groups, &view, uuid) {
            Some((index, room)) => {
                if !picked.iter().any(|(_, r)| r.uuid == room.uuid) {
                    picked.push((index, room));
                }
            }
            None => {
                if !unknown.contains(uuid) {
                    unknown.push(uuid.clone());
                }
            }
        }
    }
    if picked.is_empty() {
        return Err(PlanError::NoRooms);
    }
    let chosen_set: HashSet<&str> = picked.iter().map(|(_, r)| r.uuid.as_str()).collect();
    let all_chosen = |group: &GroupRooms| {
        group
            .rooms
            .iter()
            .all(|room| chosen_set.contains(room.uuid.as_str()))
    };

    // Rule 3: a running cast keeps its coordinator, while it still leads a
    // Sonos group.
    let running = cast_coordinator.and_then(|uuid| {
        view.iter()
            .enumerate()
            .find(|(_, g)| g.coordinator_uuid == uuid)
            .map(|(index, g)| (index, g.rooms[0].clone()))
    });

    let is_running = running.is_some();
    let (coordinator_index, coordinator, coordinator_leaves) = if let Some((index, room)) = running
    {
        (index, room, false)
    } else if let Some(index) = view
        .iter()
        .position(|g| g.rooms.len() == picked.len() && all_chosen(g))
    {
        // Rule 2: exactly one Sonos group.
        (index, view[index].rooms[0].clone(), false)
    } else {
        // Rule 4: the largest group of chosen rooms only, then the order
        // chosen; else the first chosen room.
        let mut best: Option<(usize, usize)> = None; // (group index, size)
        for (index, room) in &picked {
            let group = &view[*index];
            let leads = group.coordinator_uuid == room.uuid;
            let bigger = best.map_or(true, |(_, size)| group.rooms.len() > size);
            if leads && all_chosen(group) && bigger {
                best = Some((*index, group.rooms.len()));
            }
        }
        match best {
            Some((index, _)) => (index, view[index].rooms[0].clone(), false),
            None => {
                // A member leaving its group hands nothing on, so one leads
                // rather than a room that coordinates others, when there is one.
                let (index, room) = picked
                    .iter()
                    .find(|(index, room)| view[*index].coordinator_uuid != room.uuid)
                    .unwrap_or(&picked[0])
                    .clone();
                let leaves = view[index].rooms.len() > 1;
                (index, room, leaves)
            }
        }
    };

    let coordinator_chosen = chosen_set.contains(coordinator.uuid.as_str());
    let mut stay = Vec::new();
    let mut join = Vec::new();
    for (index, room) in &picked {
        if room.uuid == coordinator.uuid {
            continue;
        }
        if *index == coordinator_index && !coordinator_leaves {
            stay.push(room.clone());
        } else {
            join.push(JoinRoom {
                room: room.clone(),
                leave_first: view[*index].rooms.len() > 1,
            });
        }
    }

    // Snapshots: every chosen room that shared a group, except rooms already
    // in a running cast's group (their group before the cast is not known
    // here, and their sessions keep the one recorded when they joined).
    let mut snapshots = HashMap::new();
    for (index, room) in &picked {
        let group = &view[*index];
        if group.rooms.len() < 2 || (is_running && *index == coordinator_index) {
            continue;
        }
        snapshots.insert(
            room.uuid.clone(),
            OldGroup {
                kept: *index == coordinator_index && !coordinator_leaves,
                coordinator_uuid: group.coordinator_uuid.clone(),
                partners: group
                    .rooms
                    .iter()
                    .filter(|r| r.uuid != room.uuid)
                    .map(|r| r.uuid.clone())
                    .collect(),
            },
        );
    }

    Ok(RegroupPlan {
        coordinator,
        coordinator_chosen,
        coordinator_leaves,
        stay,
        join,
        unknown,
        snapshots,
    })
}

/// A room leaving a cast that recorded the group it was in.
#[derive(Debug, Clone)]
pub(crate) struct Leaving {
    /// The room's primary UUID.
    pub uuid: String,
    /// The room's primary IP.
    pub ip: String,
    /// The group it was in before the cast.
    pub old_group: OldGroup,
}

/// One room to put back: the group it rejoins, by its current coordinator.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Rejoin {
    /// The room's primary IP.
    pub ip: String,
    /// The coordinator of the group it rejoins, as that group is now.
    pub coordinator_uuid: String,
}

/// Where each room leaving a cast goes back to.
///
/// `leaving` are the rooms leaving now, each standing alone by the time it
/// is put back; `staying` are the cast's rooms that keep playing. `groups`
/// is the household as read when the rooms left. For each leaving room:
///
/// - If one of its old partners is still in the household and not in the
///   cast, it rejoins that partner's group under whoever coordinates it now
///   (its old coordinator may have left, and Sonos promoted another room).
///   The old coordinator is preferred when it is such a partner.
/// - If its old group was made only of cast rooms (two groups merged for the
///   cast), the group is rebuilt among the rooms leaving now: the old
///   coordinator, else the smallest UUID, stays alone and the rest rejoin it.
///   Every room of that group picks the same anchor, so nothing loops.
/// - Otherwise it stays alone.
pub(crate) fn plan_restore(
    leaving: &[Leaving],
    groups: &[ZoneGroup],
    staying: &HashSet<String>,
) -> Vec<Rejoin> {
    let coordinator_of: HashMap<String, String> = group_rooms(groups)
        .into_iter()
        .flat_map(|group| {
            let coordinator = group.coordinator_uuid;
            group
                .rooms
                .into_iter()
                .map(move |room| (room.uuid, coordinator.clone()))
        })
        .collect();
    let gone: HashSet<&str> = leaving.iter().map(|room| room.uuid.as_str()).collect();
    let in_cast = |uuid: &str| gone.contains(uuid) || staying.contains(uuid);
    let present = |uuid: &str| coordinator_of.contains_key(uuid);

    let mut rejoins = Vec::new();
    for room in leaving {
        let old = &room.old_group;
        // The old coordinator first, then the partners in order.
        let mut partners: Vec<&str> = Vec::new();
        if old.partners.contains(&old.coordinator_uuid) {
            partners.push(old.coordinator_uuid.as_str());
        }
        partners.extend(
            old.partners
                .iter()
                .map(String::as_str)
                .filter(|uuid| *uuid != old.coordinator_uuid),
        );

        if let Some(partner) = partners.iter().find(|uuid| present(uuid) && !in_cast(uuid)) {
            let target = &coordinator_of[*partner];
            if !in_cast(target) && *target != room.uuid {
                rejoins.push(Rejoin {
                    ip: room.ip.clone(),
                    coordinator_uuid: target.clone(),
                });
            }
            continue;
        }

        let mates: Vec<&str> = partners
            .iter()
            .copied()
            .filter(|uuid| gone.contains(uuid) && present(uuid))
            .collect();
        if mates.is_empty() {
            continue;
        }
        let anchor =
            if gone.contains(old.coordinator_uuid.as_str()) && present(&old.coordinator_uuid) {
                old.coordinator_uuid.as_str()
            } else {
                mates
                    .iter()
                    .copied()
                    .chain(std::iter::once(room.uuid.as_str()))
                    .min()
                    .unwrap_or(room.uuid.as_str())
            };
        if anchor != room.uuid {
            rejoins.push(Rejoin {
                ip: room.ip.clone(),
                coordinator_uuid: anchor.to_string(),
            });
        }
    }
    follow_moving_anchors(rejoins, leaving)
}

/// Sends a room whose anchor rejoins another group straight to that group.
///
/// Sonos leaves a coordinator's members alone when it joins another group, so
/// a room put back with an anchor that then moves on would be stranded on its
/// own. Following each anchor to where it goes keeps them together, in any
/// order. A loop, which the plan never makes, stops where it started.
fn follow_moving_anchors(rejoins: Vec<Rejoin>, leaving: &[Leaving]) -> Vec<Rejoin> {
    let uuid_of: HashMap<&str, &str> = leaving
        .iter()
        .map(|room| (room.ip.as_str(), room.uuid.as_str()))
        .collect();
    let moves: HashMap<&str, &str> = rejoins
        .iter()
        .filter_map(|r| Some((*uuid_of.get(r.ip.as_str())?, r.coordinator_uuid.as_str())))
        .collect();
    let resolved: Vec<String> = rejoins
        .iter()
        .map(|r| {
            let mut target = r.coordinator_uuid.as_str();
            for _ in 0..moves.len() {
                match moves.get(target) {
                    Some(next) => target = next,
                    None => break,
                }
            }
            target.to_string()
        })
        .collect();
    rejoins
        .into_iter()
        .zip(resolved)
        .filter(|(r, target)| uuid_of.get(r.ip.as_str()) != Some(&target.as_str()))
        .map(|(r, coordinator_uuid)| Rejoin {
            coordinator_uuid,
            ..r
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sonos::types::ZoneGroupMember;

    /// A household from groups of room names, each coordinator first. Room
    /// `X` has UUID `RINCON_X` and IP `ip-X`; a name ending in `*` is a
    /// satellite of the room before it.
    fn household(groups: &[&[&str]]) -> Vec<ZoneGroup> {
        groups
            .iter()
            .map(|names| {
                let mut members = Vec::new();
                let mut zone = String::new();
                for name in names.iter() {
                    let invisible = name.ends_with('*');
                    let bare = name.trim_end_matches('*');
                    if !invisible {
                        zone = bare.to_string();
                    }
                    members.push(ZoneGroupMember {
                        uuid: format!("RINCON_{bare}"),
                        ip: format!("ip-{bare}"),
                        zone_name: zone.clone(),
                        model: "One".to_string(),
                        invisible,
                    });
                }
                ZoneGroup {
                    id: format!("RINCON_{}:1", names[0]),
                    name: names[0].to_string(),
                    coordinator_uuid: format!("RINCON_{}", names[0]),
                    coordinator_ip: format!("ip-{}", names[0]),
                    members,
                }
            })
            .collect()
    }

    fn ids(names: &[&str]) -> Vec<String> {
        names.iter().map(|n| format!("RINCON_{n}")).collect()
    }

    fn names(rooms: &[RoomRef]) -> Vec<String> {
        rooms
            .iter()
            .map(|r| r.uuid.trim_start_matches("RINCON_").to_string())
            .collect()
    }

    fn joins(plan: &RegroupPlan) -> Vec<(String, bool)> {
        plan.join
            .iter()
            .map(|j| {
                (
                    j.room.uuid.trim_start_matches("RINCON_").to_string(),
                    j.leave_first,
                )
            })
            .collect()
    }

    fn plan(groups: &[&[&str]], chosen: &[&str]) -> RegroupPlan {
        plan_regroup(&ids(chosen), &household(groups), None).expect("a plan")
    }

    #[test]
    fn an_exact_group_plays_on_its_coordinator_and_moves_nothing() {
        let p = plan(&[&["Kitchen", "Patio"], &["Office"]], &["Patio", "Kitchen"]);
        assert_eq!(p.coordinator.uuid, "RINCON_Kitchen");
        assert!(!p.coordinator_leaves);
        assert_eq!(names(&p.stay), ["Patio"]);
        assert!(p.join.is_empty());
        assert!(p.unknown.is_empty());
    }

    #[test]
    fn a_whole_group_plus_a_standalone_room_joins_only_the_standalone_room() {
        let p = plan(
            &[&["Kitchen", "Patio"], &["Office"]],
            &["Office", "Kitchen", "Patio"],
        );
        assert_eq!(p.coordinator.uuid, "RINCON_Kitchen");
        assert_eq!(names(&p.stay), ["Patio"]);
        assert_eq!(joins(&p), [("Office".to_string(), false)]);
    }

    #[test]
    fn a_member_pulled_from_a_mixed_group_leaves_it_first() {
        let p = plan(&[&["Kitchen", "Patio"], &["Office"]], &["Office", "Patio"]);
        assert_eq!(p.coordinator.uuid, "RINCON_Office");
        assert!(!p.coordinator_leaves);
        assert_eq!(joins(&p), [("Patio".to_string(), true)]);
        assert_eq!(
            p.snapshots.get("RINCON_Patio"),
            Some(&OldGroup {
                coordinator_uuid: "RINCON_Kitchen".to_string(),
                partners: vec!["RINCON_Kitchen".to_string()],
                kept: false,
            })
        );
        assert!(!p.snapshots.contains_key("RINCON_Office"));
    }

    #[test]
    fn with_no_clean_group_the_first_room_leads_and_leaves_its_group() {
        let p = plan(
            &[&["Kitchen", "Patio"], &["Office", "Den"]],
            &["Kitchen", "Office"],
        );
        assert_eq!(p.coordinator.uuid, "RINCON_Kitchen");
        assert!(p.coordinator_leaves);
        assert!(p.stay.is_empty());
        assert_eq!(joins(&p), [("Office".to_string(), true)]);
        assert_eq!(
            p.snapshots.get("RINCON_Kitchen"),
            Some(&OldGroup {
                coordinator_uuid: "RINCON_Kitchen".to_string(),
                partners: vec!["RINCON_Patio".to_string()],
                kept: false,
            })
        );
    }

    #[test]
    fn with_no_clean_group_a_member_leads_before_a_coordinator() {
        // Patio leaving hands nothing on; Kitchen still has to move, and
        // Dining's music restarts either way, but only once.
        let p = plan(&[&["Kitchen", "Patio", "Dining"]], &["Kitchen", "Patio"]);
        assert_eq!(p.coordinator.uuid, "RINCON_Patio");
        assert!(p.coordinator_leaves);
        assert!(p.stay.is_empty());
        assert_eq!(joins(&p), [("Kitchen".to_string(), true)]);
    }

    #[test]
    fn a_whole_group_beats_a_standalone_room_which_beats_the_rest() {
        let groups: &[&[&str]] = &[&["Kitchen", "Patio"], &["Office"], &["Den", "Hall"]];
        let p = plan(groups, &["Den", "Office", "Kitchen", "Patio"]);
        assert_eq!(p.coordinator.uuid, "RINCON_Kitchen");

        let p = plan(groups, &["Den", "Office"]);
        assert_eq!(p.coordinator.uuid, "RINCON_Office");
        assert_eq!(joins(&p), [("Den".to_string(), true)]);
    }

    #[test]
    fn equal_groups_go_by_the_order_chosen() {
        let groups: &[&[&str]] = &[&["Kitchen", "Patio"], &["Office", "Den"]];
        let p = plan(groups, &["Den", "Office", "Patio", "Kitchen"]);
        assert_eq!(p.coordinator.uuid, "RINCON_Office");
        assert_eq!(
            joins(&p),
            [("Patio".to_string(), true), ("Kitchen".to_string(), true)]
        );
        assert_eq!(names(&p.stay), ["Den"]);
        // Both whole groups are recorded: the leading one is kept, the other
        // is rebuilt afterwards.
        assert_eq!(p.snapshots.len(), 4);
        assert!(p.snapshots["RINCON_Office"].kept && p.snapshots["RINCON_Den"].kept);
        assert!(!p.snapshots["RINCON_Kitchen"].kept && !p.snapshots["RINCON_Patio"].kept);
    }

    #[test]
    fn a_satellite_is_never_named_and_a_home_theatre_is_one_room() {
        let groups: &[&[&str]] = &[&["Living", "Sub*", "Rear*"], &["Kitchen"]];
        let p = plan(groups, &["Kitchen", "Living"]);
        assert_eq!(p.coordinator.uuid, "RINCON_Kitchen");
        assert_eq!(joins(&p), [("Living".to_string(), false)]);
        assert!(p.snapshots.is_empty());

        // A satellite's UUID stands for its room.
        let p = plan(groups, &["Sub"]);
        assert_eq!(p.coordinator.uuid, "RINCON_Living");
        assert!(p.join.is_empty() && p.stay.is_empty());
    }

    #[test]
    fn unknown_rooms_are_reported_and_none_known_is_an_error() {
        let groups = household(&[&["Kitchen"]]);
        let p = plan_regroup(&ids(&["Gone", "Kitchen"]), &groups, None).expect("a plan");
        assert_eq!(p.unknown, ids(&["Gone"]));
        assert_eq!(
            plan_regroup(&ids(&["Gone"]), &groups, None),
            Err(PlanError::NoRooms)
        );
    }

    #[test]
    fn a_running_cast_keeps_its_coordinator() {
        let groups = household(&[&["Office", "Den"], &["Kitchen", "Patio"], &["Hall"]]);
        let p = plan_regroup(&ids(&["Kitchen", "Hall"]), &groups, Some("RINCON_Office"))
            .expect("a plan");
        assert_eq!(p.coordinator.uuid, "RINCON_Office");
        assert!(!p.coordinator_chosen);
        assert!(!p.coordinator_leaves);
        assert_eq!(
            joins(&p),
            [("Kitchen".to_string(), true), ("Hall".to_string(), false)]
        );
        assert!(p.snapshots.contains_key("RINCON_Kitchen"));

        // A resume: every room already in the cast's group stays.
        let p =
            plan_regroup(&ids(&["Office", "Den"]), &groups, Some("RINCON_Office")).expect("a plan");
        assert!(p.coordinator_chosen);
        assert_eq!(names(&p.stay), ["Den"]);
        assert!(p.join.is_empty());
        assert!(p.snapshots.is_empty());
    }

    #[test]
    fn a_running_cast_that_no_longer_leads_a_group_is_planned_afresh() {
        let groups = household(&[&["Kitchen", "Office"]]);
        let p = plan_regroup(&ids(&["Kitchen", "Office"]), &groups, Some("RINCON_Office"))
            .expect("a plan");
        assert_eq!(p.coordinator.uuid, "RINCON_Kitchen");
    }

    #[test]
    fn a_room_chosen_twice_is_planned_once() {
        let p = plan(
            &[&["Kitchen"], &["Office"]],
            &["Office", "Kitchen", "Office"],
        );
        assert_eq!(p.coordinator.uuid, "RINCON_Office");
        assert_eq!(joins(&p), [("Kitchen".to_string(), false)]);
    }

    fn leaving(name: &str, coordinator: &str, partners: &[&str]) -> Leaving {
        Leaving {
            uuid: format!("RINCON_{name}"),
            ip: format!("ip-{name}"),
            old_group: OldGroup {
                coordinator_uuid: format!("RINCON_{coordinator}"),
                partners: ids(partners),
                kept: false,
            },
        }
    }

    fn rejoins(plan: &[Rejoin]) -> Vec<(String, String)> {
        plan.iter()
            .map(|r| {
                (
                    r.ip.trim_start_matches("ip-").to_string(),
                    r.coordinator_uuid.trim_start_matches("RINCON_").to_string(),
                )
            })
            .collect()
    }

    fn staying(names: &[&str]) -> HashSet<String> {
        ids(names).into_iter().collect()
    }

    #[test]
    fn a_member_goes_back_to_its_old_coordinator() {
        let groups = household(&[&["Kitchen"], &["Patio"], &["Office"]]);
        let plan = plan_restore(
            &[leaving("Patio", "Kitchen", &["Kitchen"])],
            &groups,
            &staying(&["Office"]),
        );
        assert_eq!(rejoins(&plan), [("Patio".into(), "Kitchen".into())]);
    }

    #[test]
    fn a_room_goes_back_to_the_current_coordinator_of_its_old_partners() {
        // Kitchen led Kitchen + Patio + Dining and left for the cast: Patio
        // was promoted and now leads Dining.
        let groups = household(&[&["Kitchen"], &["Patio", "Dining"]]);
        let plan = plan_restore(
            &[leaving("Kitchen", "Kitchen", &["Patio", "Dining"])],
            &groups,
            &HashSet::new(),
        );
        assert_eq!(rejoins(&plan), [("Kitchen".into(), "Patio".into())]);
    }

    #[test]
    fn with_its_old_partners_gone_a_room_stays_alone() {
        let groups = household(&[&["Patio"]]);
        let plan = plan_restore(
            &[leaving("Patio", "Kitchen", &["Kitchen"])],
            &groups,
            &HashSet::new(),
        );
        assert!(plan.is_empty());
    }

    #[test]
    fn a_partner_still_casting_is_not_rejoined() {
        let groups = household(&[&["Office", "Den"], &["Patio"]]);
        let plan = plan_restore(
            &[leaving("Patio", "Den", &["Den"])],
            &groups,
            &staying(&["Office", "Den"]),
        );
        assert!(plan.is_empty());
    }

    #[test]
    fn two_merged_groups_are_rebuilt_around_their_old_coordinators() {
        let groups = household(&[&["Office"], &["Den"], &["Kitchen"], &["Patio"]]);
        let plan = plan_restore(
            &[
                leaving("Office", "Office", &["Den"]),
                leaving("Den", "Office", &["Office"]),
                leaving("Kitchen", "Kitchen", &["Patio"]),
                leaving("Patio", "Kitchen", &["Kitchen"]),
            ],
            &groups,
            &HashSet::new(),
        );
        assert_eq!(
            rejoins(&plan),
            [
                ("Den".into(), "Office".into()),
                ("Patio".into(), "Kitchen".into())
            ]
        );
    }

    #[test]
    fn a_rebuilt_group_without_its_coordinator_picks_one_anchor() {
        let groups = household(&[&["Den"], &["Hall"]]);
        let plan = plan_restore(
            &[
                leaving("Den", "Office", &["Office", "Hall"]),
                leaving("Hall", "Office", &["Office", "Den"]),
            ],
            &groups,
            &HashSet::new(),
        );
        assert_eq!(rejoins(&plan), [("Hall".into(), "Den".into())]);
    }

    #[test]
    fn a_room_whose_anchor_moves_on_follows_it() {
        // Bathroom left Bedroom's group for the cast; someone then grouped
        // Bedroom with Living Room, and Bedroom joined the cast too. Putting
        // Bathroom back with Bedroom before Bedroom rejoins Living Room would
        // strand it: Sonos leaves a coordinator's members behind.
        let groups = household(&[&["Living Room"], &["Bathroom"], &["Bedroom"]]);
        let plan = plan_restore(
            &[
                leaving("Bathroom", "Bedroom", &["Bedroom"]),
                leaving("Bedroom", "Living Room", &["Living Room"]),
            ],
            &groups,
            &HashSet::new(),
        );
        assert_eq!(
            rejoins(&plan),
            [
                ("Bathroom".into(), "Living Room".into()),
                ("Bedroom".into(), "Living Room".into())
            ]
        );
    }

    #[test]
    fn a_partner_moved_into_the_cast_from_outside_is_not_followed() {
        // Someone grouped Kitchen into the cast's group: its coordinator is a
        // cast room, so Patio is not sent there.
        let groups = household(&[&["Office", "Kitchen"], &["Patio"]]);
        let plan = plan_restore(
            &[leaving("Patio", "Kitchen", &["Kitchen"])],
            &groups,
            &staying(&["Office"]),
        );
        assert!(plan.is_empty());
    }
}
