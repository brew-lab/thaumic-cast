/**
 * Rooms
 *
 * What the user calls a speaker is a room: "Kitchen", "Living Room". Sonos
 * reports devices in groups, and a room can be several devices (a home
 * theatre's soundbar, sub and surrounds; the two speakers of a stereo pair).
 * The companion sends the groups as they are, marking bonded devices
 * `invisible`; this module folds them into rooms. The popup and the
 * background both derive rooms here, so they always agree.
 *
 * A room is named by its primary's player UUID (`RINCON_…`), which survives
 * an IP change. The group fields say how the room is grouped right now: a
 * companion that regroups pulls a chosen room out of its group for the cast,
 * and an older one casts to the room's whole group.
 */

import type { SonosStateSnapshot, SpeakerAvailability, ZoneGroup } from './sonos.js';
import { getSpeakerAvailability } from './sonos.js';

/** A room's id: its primary's player UUID (`RINCON_…`). */
export type RoomId = string;

/** One room, as the user names it in the Sonos app. */
export interface Room {
  /** The primary's player UUID. */
  id: RoomId;
  /** The room's name (Sonos `zoneName`). */
  name: string;
  /** The primary's IP. */
  ip: string;
  /** The Sonos group the room is in now. */
  groupId: string;
  /** That group's coordinator UUID. */
  coordinatorId: string;
  /** That group's coordinator IP: what a cast to the room goes to with an older companion. */
  coordinatorIp: string;
  /** Whether this room is its group's coordinator. */
  isCoordinator: boolean;
  /** The other rooms in the same Sonos group, by name, sorted; empty when alone. */
  groupedWith: string[];
}

/** What a room's level reads before Cast. */
export interface RoomLevel {
  /** The level now, or undefined while it cannot be known ("…"). */
  now?: number;
  /** Whether the output is fixed (line level): its level is never set. */
  fixed?: boolean;
  /** Whether the room is muted. */
  muted?: boolean;
}

/**
 * Sorts names the way the popup lists them.
 * @param a - One name
 * @param b - The other
 * @returns Negative, zero or positive, as for `Array.prototype.sort`
 */
const byName = (a: string, b: string): number => a.localeCompare(b);

/**
 * Folds Sonos groups into rooms.
 *
 * A member marked `invisible` is a bonded device (a satellite, a stereo
 * partner) and plays as part of its room's primary. An older companion does
 * not send the flag, so members of one group that share a room name are also
 * folded into one room: the coordinator if it is one of them, else the first.
 * That is the rule the companion's start level uses too.
 * @param groups - The zone groups from the companion
 * @returns The rooms, sorted by name
 */
export function roomsOf(groups: readonly ZoneGroup[]): Room[] {
  const rooms: Room[] = [];
  for (const group of groups) {
    const members = [...group.members].sort(
      (a, b) => Number(b.uuid === group.coordinatorUuid) - Number(a.uuid === group.coordinatorUuid),
    );
    const seen = new Set<string>();
    const groupRooms: Room[] = [];
    for (const member of members) {
      if (member.invisible === true || seen.has(member.zoneName)) continue;
      seen.add(member.zoneName);
      groupRooms.push({
        id: member.uuid,
        name: member.zoneName,
        ip: member.ip,
        groupId: group.id,
        coordinatorId: group.coordinatorUuid,
        coordinatorIp: group.coordinatorIp,
        isCoordinator: member.uuid === group.coordinatorUuid,
        groupedWith: [],
      });
    }
    for (const room of groupRooms) {
      room.groupedWith = groupRooms
        .filter((other) => other !== room)
        .map((other) => other.name)
        .sort(byName);
    }
    rooms.push(...groupRooms);
  }
  return rooms.sort((a, b) => byName(a.name, b.name) || byName(a.id, b.id));
}

/**
 * Reads a room's level.
 *
 * Before Cast, a room alone in its Sonos group reads the group's live level,
 * which is the room's own. A room inside a bigger group is read by its own IP
 * only when the companion has a level for that IP that is not a group's (a
 * member that is not the coordinator, followed for a cast played as one
 * group); otherwise it is not known until Cast, when the companion reads it
 * ("…", then the limit if it still cannot be read).
 *
 * A room of a running cast played as one Sonos group is always read by its
 * own IP (`own`): the companion follows each such room's own level, the
 * coordinator's included, so the group's level is never taken for it.
 * @param room - The room
 * @param state - The Sonos state
 * @param own - The room plays in a cast played as one Sonos group
 * @returns What the room's level reads
 */
export function roomLevel(room: Room, state: SonosStateSnapshot, own = false): RoomLevel {
  const alone = room.groupedWith.length === 0;
  if (!own && !alone && room.isCoordinator) return {};
  const ip = own || !alone ? room.ip : room.coordinatorIp;
  const level: RoomLevel = {};
  if (state.groupVolumes[ip] !== undefined) level.now = state.groupVolumes[ip];
  if (state.groupVolumeFixed[ip] !== undefined) level.fixed = state.groupVolumeFixed[ip];
  if (state.groupMutes[ip] !== undefined) level.muted = state.groupMutes[ip];
  return level;
}

/**
 * Whether a room is free, in use, or being cast to. A room plays what its
 * group's coordinator plays, so that is what is asked.
 * @param room - The room
 * @param state - The Sonos state
 * @param castingIps - The speaker IPs this client is casting to
 * @returns The room's availability
 */
export function roomAvailability(
  room: Room,
  state: SonosStateSnapshot,
  castingIps: string[],
): SpeakerAvailability {
  return getSpeakerAvailability(room.coordinatorIp, state, castingIps);
}

/**
 * Finds the room whose primary has a speaker IP: a cast target's own room.
 * @param rooms - The rooms
 * @param ip - A speaker IP
 * @returns The room, or undefined
 */
export function roomByIp(rooms: readonly Room[], ip: string): Room | undefined {
  return rooms.find((room) => room.ip === ip);
}
