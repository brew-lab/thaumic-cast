/**
 * Cast Plan
 *
 * Turns the rooms the user chose into the speakers a cast is sent to.
 *
 * A companion that regroups (`/health` says `regroup`) plays exactly the
 * chosen rooms as one Sonos group: each room is named by its own IP and UUID,
 * a room in a group that also holds unchosen rooms leaves that group until
 * the cast stops, and the companion puts it back. The plan names those rooms
 * (`leaving`), and the unchosen rooms whose music starts again from the top
 * because their group's coordinator leaves (`restarting`).
 *
 * An older companion cannot regroup, so a chosen room casts to its whole
 * Sonos group, through the group's coordinator, as a group row did before
 * rooms. Rooms grouped with a chosen room then play too (`extraRooms`), and
 * the popup says so once. This fallback goes once the extension requires a
 * companion that regroups.
 *
 * The popup and the background both plan here, from the same rooms, so the
 * line the popup shows and what the background sends always agree.
 */

import type { Room, RoomId, TransportState } from '@thaumic-cast/protocol';
import type { PlaybackRequest } from './messages';

/** What a cast to the chosen rooms will do. */
export interface CastPlan {
  /** The chosen rooms that are present, in the order chosen. */
  rooms: Room[];
  /**
   * The speakers the cast is sent to, in the order chosen: each room's own IP when the
   * companion regroups, else one coordinator IP per Sonos group that holds a chosen room.
   */
  targets: string[];
  /** The target each chosen room plays through, keyed by room id. */
  targetOf: Record<RoomId, string>;
  /** Rooms that will play although not chosen (grouped partners, older companion), by name. */
  extraRooms: Room[];
  /** Chosen rooms pulled from their Sonos groups for the cast, by name. */
  leaving: Room[];
  /** Unchosen rooms whose music starts again from the top as their coordinator leaves, by name. */
  restarting: Room[];
}

/** How a cast is planned. */
export interface PlanOptions {
  /** The companion plays the chosen rooms as one Sonos group (`/health` `regroup`). */
  regroup?: boolean;
  /** Each Sonos group's transport state, keyed by coordinator IP. */
  transport?: Readonly<Record<string, TransportState>>;
}

/**
 * Sorts rooms the way the lines name them.
 * @param a - One room
 * @param b - The other
 * @returns Negative, zero or positive, as for `Array.prototype.sort`
 */
const byName = (a: Room, b: Room): number => a.name.localeCompare(b.name);

/**
 * Plans a cast to the chosen rooms.
 * @param chosen - The chosen room ids, in order
 * @param rooms - The rooms present now
 * @param options - Whether the companion regroups, and what each group plays
 * @returns The plan; a chosen room that is not present is left out
 */
export function planCast(
  chosen: readonly RoomId[],
  rooms: readonly Room[],
  options: PlanOptions = {},
): CastPlan {
  const picked: Room[] = [];
  for (const id of chosen) {
    const room = rooms.find((r) => r.id === id);
    if (room && !picked.includes(room)) picked.push(room);
  }
  const unchosenIn = (groupId: string): Room[] =>
    rooms.filter((room) => room.groupId === groupId && !picked.includes(room));

  if (options.regroup) {
    const leaving = picked.filter((room) => unchosenIn(room.groupId).length > 0).sort(byName);
    // A chosen coordinator leaves its group, so the rooms left behind are promoted, and Sonos
    // starts their music again from the top. A group that is not playing has nothing to restart.
    const restarting = picked
      .filter((room) => room.isCoordinator && options.transport?.[room.coordinatorIp] === 'Playing')
      .flatMap((room) => unchosenIn(room.groupId))
      .sort(byName);
    return {
      rooms: picked,
      targets: picked.map((room) => room.ip),
      targetOf: Object.fromEntries(picked.map((room) => [room.id, room.ip])),
      extraRooms: [],
      leaving,
      restarting,
    };
  }

  const targets = [...new Set(picked.map((room) => room.coordinatorIp))];
  const targetOf = Object.fromEntries(picked.map((room) => [room.id, room.coordinatorIp]));
  const groupIds = new Set(picked.map((room) => room.groupId));
  const extraRooms = rooms
    .filter((room) => groupIds.has(room.groupId) && !picked.includes(room))
    .sort(byName);
  return { rooms: picked, targets, targetOf, extraRooms, leaving: [], restarting: [] };
}

/**
 * Who a START_PLAYBACK for a plan names. A companion that regroups gets the rooms (player
 * UUIDs) with each room's own IP in the same order, and plays them as one Sonos group. An
 * older companion gets the coordinators only, each playing the stream on its own.
 * @param plan - The cast plan (made with the same `regroup`)
 * @param regroup - The companion regroups
 * @returns The request's speakers and rooms
 */
export function playbackTargets(
  plan: CastPlan,
  regroup: boolean,
): Pick<PlaybackRequest, 'speakerIps' | 'rooms'> {
  return regroup
    ? { speakerIps: plan.targets, rooms: plan.rooms.map((room) => room.id) }
    : { speakerIps: plan.targets };
}

/** One CastBar line, ready for `t`. */
export interface CastLine {
  /** The string key (a plural when `params.count` is set). */
  key: 'cast_leaves_group' | 'cast_music_restarts' | 'cast_plays_too';
  /** The values it takes. */
  params: Record<string, string | number>;
}

/**
 * The CastBar's lines about Sonos groups, in order: which chosen rooms leave their groups
 * ("Kitchen leaves its Sonos group until you stop."), then whose music starts again ("Music
 * in Patio starts again from the top."). With an older companion, the one line instead says
 * which unchosen rooms play too. None when the chosen rooms are exactly Sonos groups.
 * @param plan - The cast plan
 * @param list - Joins names as a list in the UI language ("Kitchen and Study")
 * @returns The lines, at most two
 */
export function castBarLines(plan: CastPlan, list: (names: string[]) => string): CastLine[] {
  const lines: CastLine[] = [];
  const names = (rooms: Room[]): string => list(rooms.map((room) => room.name));
  if (plan.leaving.length > 0) {
    lines.push({
      key: 'cast_leaves_group',
      params: {
        count: plan.leaving.length,
        name: plan.leaving[0].name,
        names: names(plan.leaving),
      },
    });
  }
  if (plan.restarting.length > 0) {
    lines.push({ key: 'cast_music_restarts', params: { names: names(plan.restarting) } });
  }
  const extra = plan.extraRooms;
  if (extra.length > 0) {
    const first = extra[0];
    const grouped = plan.rooms.filter((room) => room.groupId === first.groupId).sort(byName);
    lines.push({
      key: 'cast_plays_too',
      params: { count: extra.length, name: first.name, with: names(grouped), names: names(extra) },
    });
  }
  return lines;
}
