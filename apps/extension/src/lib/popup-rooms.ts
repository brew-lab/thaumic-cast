/**
 * Popup Rooms
 *
 * The popup's pure rules over rooms: the sets it offers, what the CastBar
 * says about a choice, a running cast's rows, and how a master moves them.
 * The hooks wire these to state and Chrome; nothing here reads either.
 */

import type { ActiveCast, Room, RoomId, SonosStateSnapshot } from '@thaumic-cast/protocol';
import { roomAvailability, roomLevel } from '@thaumic-cast/protocol';
import { choiceIsSet, setRooms, type RoomRef, type RoomSets } from './room-sets';
import type { CastPlan } from './cast-plan';

/** The id of the Last cast set. */
export const LAST_CAST_ID = 'last';

/** The id of the Everywhere set. */
export const EVERYWHERE_ID = 'everywhere';

/** Everywhere is offered from this many rooms. */
export const EVERYWHERE_FROM = 3;

/** One set as the picker shows it, before its words are translated. */
export interface SetView {
  /** Its id: `last`, `everywhere`, or a saved set's. */
  id: string;
  /** last, saved or everywhere. */
  kind: 'last' | 'saved' | 'everywhere';
  /** A saved set's name (Last cast and Everywhere are named by the popup). */
  name?: string;
  /** The rooms it holds that are here now. */
  present: Room[];
  /** The rooms it holds that are not here, by their stored names. */
  missing: RoomRef[];
  /**
   * The set the choice reads as: at most one set is pressed. Of the sets the choice is exactly,
   * Everywhere wins, then the first saved set, then Last cast.
   */
  pressed: boolean;
}

/**
 * The sets the picker offers: Last cast, then the saved sets, then Everywhere
 * from three rooms. A set none of whose rooms is here is left out, and so is
 * Last cast when a saved set or Everywhere holds exactly its rooms: the same
 * rooms twice under two names read as two choices.
 *
 * One set at most reads pressed, although a choice can be exactly several: Last cast is often
 * also a saved set or every room, and two rows selected for one choice read as two choices.
 * The most specific name wins: Everywhere when every room is chosen, else the first saved set
 * of exactly those rooms, else Last cast.
 * @param sets - The stored sets
 * @param rooms - The rooms here now
 * @param choice - The chosen room ids
 * @returns The sets, in order
 */
export function setViews(
  sets: RoomSets,
  rooms: readonly Room[],
  choice: readonly RoomId[],
): SetView[] {
  const out: SetView[] = [];
  const add = (id: string, kind: SetView['kind'], refs: readonly RoomRef[], name?: string) => {
    const { present, missing } = setRooms(refs, rooms);
    if (present.length === 0) return;
    out.push({ id, kind, name, present, missing, pressed: choiceIsSet(choice, refs, rooms) });
  };
  add(LAST_CAST_ID, 'last', sets.lastCast);
  for (const saved of sets.saved) add(saved.id, 'saved', saved.rooms, saved.name);
  if (rooms.length >= EVERYWHERE_FROM) {
    add(
      EVERYWHERE_ID,
      'everywhere',
      rooms.map((room) => ({ id: room.id, name: room.name })),
    );
  }
  const idsOf = (view: SetView) =>
    [...view.present.map((room) => room.id), ...view.missing.map((ref) => ref.id)].sort().join();
  const last = out.find((view) => view.kind === 'last');
  if (last && out.some((view) => view !== last && idsOf(view) === idsOf(last))) {
    out.splice(out.indexOf(last), 1);
  }
  const rank: Record<SetView['kind'], number> = { everywhere: 0, saved: 1, last: 2 };
  const winner = out
    .filter((view) => view.pressed)
    .reduce<
      SetView | undefined
    >((best, view) => (best && rank[best.kind] <= rank[view.kind] ? best : view), undefined);
  return out.map((view) => (view.pressed && view !== winner ? { ...view, pressed: false } : view));
}

/**
 * Whether "Save these rooms as a set" is offered: two or more rooms chosen
 * that equal no set already offered.
 * @param choice - The chosen room ids
 * @param views - The sets offered
 * @returns True to offer it
 */
export function canSaveSet(choice: readonly RoomId[], views: readonly SetView[]): boolean {
  return choice.length >= 2 && !views.some((view) => view.pressed);
}

/** The replace hint's key for a choice, if a chosen room is busy. */
export type ReplaceHint = 'hint_replace_cast' | 'hint_replace_source';

/**
 * Says what a cast to the chosen rooms will interrupt: a cast already on one
 * of them ends, or whatever one of them plays stops. Another client's cast
 * counts as something playing.
 * @param chosen - The chosen rooms that are here
 * @param state - The Sonos state
 * @param castingIps - The speakers this browser casts to
 * @returns The hint's key, or null
 */
export function replaceHint(
  chosen: readonly Room[],
  state: SonosStateSnapshot,
  castingIps: string[],
): ReplaceHint | null {
  const kinds = chosen.map((room) => roomAvailability(room, state, castingIps));
  if (kinds.includes('casting')) return 'hint_replace_cast';
  if (kinds.includes('in_use') || kinds.includes('remote_cast')) return 'hint_replace_source';
  return null;
}

/**
 * The replace hint the CastBar shows beside a plan's lines. When the lines already say that
 * music elsewhere starts again from the top, "Whatever the speaker is playing will stop."
 * would sit right after a room whose music plays on, and "stop" would mean two things, so it
 * is dropped: the leaves line already says the chosen room goes. A cast that ends is still
 * said.
 * @param plan - The cast plan the lines come from
 * @param hint - The choice's replace hint (see {@link replaceHint})
 * @returns The hint to show, or null
 */
export function barReplaceHint(plan: CastPlan, hint: ReplaceHint | null): ReplaceHint | null {
  return hint === 'hint_replace_source' && plan.restarting.length > 0 ? null : hint;
}

/** One row of a running cast: a target, and the rooms it plays in. */
export interface CastRow {
  /** The target's IP: the room's own, or (older companion) its Sonos group's coordinator. */
  ip: string;
  /** Its name: the room, or the rooms of a Sonos group joined by " + ". */
  name: string;
  /** The rooms it plays in now, by id (empty when the rooms are not known). */
  roomIds: RoomId[];
}

/**
 * A running cast's rows: one per target, as the cast was sent. A cast played as one Sonos
 * group by a companion that regroups has one target, so one row, per room. With an older
 * companion a target that is a Sonos group of several rooms is one row, named "Kitchen +
 * Patio".
 *
 * Each room belongs to one row: the target that is the room itself, else the target whose
 * Sonos group it is in. So a cast played as one Sonos group keeps one row per room it was
 * sent to, although the topology then reports every room under its coordinator.
 * @param cast - The cast
 * @param rooms - The rooms here now
 * @returns The rows, in the cast's order
 */
export function castRows(
  cast: Pick<ActiveCast, 'speakerIps' | 'speakerNames'> &
    Partial<Pick<ActiveCast, 'roomIds' | 'syncSpeakers'>>,
  rooms: readonly Room[],
): CastRow[] {
  const targets = new Set(cast.speakerIps);
  // A regrouped cast's targets are its rooms' own IPs: a room the topology still shows in the
  // cast's group after it was removed (until it is put back) belongs to no row.
  const regrouped = cast.syncSpeakers === true && (cast.roomIds?.length ?? 0) > 0;
  const ownerOf = (room: Room): string | undefined =>
    targets.has(room.ip)
      ? room.ip
      : !regrouped && targets.has(room.coordinatorIp)
        ? room.coordinatorIp
        : undefined;
  return cast.speakerIps.map((ip, index) => {
    const held = rooms.filter((room) => ownerOf(room) === ip);
    const ordered = [
      ...held.filter((room) => room.ip === ip),
      ...held.filter((room) => room.ip !== ip && room.isCoordinator),
      ...held.filter((room) => room.ip !== ip && !room.isCoordinator),
    ];
    return {
      ip,
      name:
        ordered.length > 0
          ? ordered.map((room) => room.name).join(' + ')
          : (cast.speakerNames[index] ?? ip),
      roomIds: ordered.map((room) => room.id),
    };
  });
}

/**
 * The levels Undo re-adds a removed row's rooms at: each room's own level as
 * the picker reads it (P-start), so a quiet room is never turned up to its
 * group's level. A room whose own level is not known gets none, and starts by
 * the limit rule.
 * @param row - The removed row
 * @param rooms - The rooms here now
 * @param state - The Sonos state
 * @param own - The cast plays as one Sonos group, so each room's own level is followed
 * @returns The levels, by room id
 */
export function undoLevels(
  row: CastRow,
  rooms: readonly Room[],
  state: SonosStateSnapshot,
  own = false,
): Record<RoomId, number> {
  const levels: Record<RoomId, number> = {};
  for (const id of row.roomIds) {
    const room = rooms.find((r) => r.id === id);
    const now = room && roomLevel(room, state, own).now;
    if (now !== undefined) levels[id] = now;
  }
  return levels;
}

/** Who a cast's master moves. */
export interface MasterTargets {
  /**
   * The targets in the first target's Sonos group, moved as one by the group's volume; empty
   * when the cast does not play as one group.
   */
  joined: string[];
  /** The targets that play on their own, moved one by one. */
  solo: string[];
}

/**
 * Splits a cast's targets for its master. A cast that plays as one Sonos group is moved by
 * the group's volume: with a companion that regroups that is every room, the rooms added
 * later included. A room the topology does not yet show in the group (it is still joining),
 * or a room an older companion added on its own stream, is moved on its own.
 * @param cast - The cast
 * @param rooms - The rooms here now
 * @returns The joined and the solo targets
 */
export function masterTargets(
  cast: Pick<ActiveCast, 'speakerIps' | 'syncSpeakers'>,
  rooms: readonly Room[],
): MasterTargets {
  const [first] = cast.speakerIps;
  const groupOf = (ip: string): string | undefined =>
    rooms.find((room) => room.ip === ip)?.coordinatorIp;
  const group = first === undefined ? undefined : groupOf(first);
  if (!cast.syncSpeakers || group === undefined) return { joined: [], solo: [...cast.speakerIps] };
  const joined = cast.speakerIps.filter((ip) => groupOf(ip) === group);
  if (joined.length < 2) return { joined: [], solo: [...cast.speakerIps] };
  return { joined, solo: cast.speakerIps.filter((ip) => !joined.includes(ip)) };
}

/**
 * Whether a room plays in a running cast. A cast played as one Sonos group names its rooms
 * exactly; with an older companion a room plays in a cast that reaches its Sonos group.
 * @param cast - The cast
 * @param room - The room
 * @returns True when the room plays in the cast
 */
export function inCast(
  cast: Pick<ActiveCast, 'speakerIps' | 'roomIds' | 'syncSpeakers'>,
  room: Room,
): boolean {
  if (cast.syncSpeakers && cast.roomIds.length > 0) return cast.roomIds.includes(room.id);
  return cast.speakerIps.includes(room.coordinatorIp);
}

/**
 * The rooms a running cast could add: every room here that it does not
 * already play in and that is not already joining it. With none, the tile
 * offers no "Add a room".
 * @param cast - The cast
 * @param rooms - The rooms here now
 * @param joining - The rooms on their way into it
 * @returns The rooms, by name
 */
export function addableRooms(
  cast: Pick<ActiveCast, 'speakerIps' | 'roomIds' | 'syncSpeakers'>,
  rooms: readonly Room[],
  joining: readonly RoomId[] = [],
): Room[] {
  return rooms.filter((room) => !inCast(cast, room) && !joining.includes(room.id));
}

/**
 * Moves every row by the same ratio, so a master set to `to` keeps the rooms'
 * balance: each known level is scaled by `to` over their mean. With every
 * level at 0, or none known, each row is set to `to`.
 * @param levels - The rows' levels, undefined where not known
 * @param to - The master's new level
 * @returns Each row's new level, in order
 */
export function scaleLevels(levels: readonly (number | undefined)[], to: number): number[] {
  const known = levels.filter((level): level is number => level !== undefined);
  const mean = known.length ? known.reduce((sum, level) => sum + level, 0) / known.length : 0;
  return levels.map((level) => {
    if (level === undefined || mean === 0) return to;
    return Math.max(0, Math.min(100, Math.round((level * to) / mean)));
  });
}
