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
  /** The choice is exactly this set. */
  pressed: boolean;
}

/**
 * The sets the picker offers: Last cast, then the saved sets, then Everywhere
 * from three rooms. A set none of whose rooms is here is left out.
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
  return out;
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

/** One row of a running cast: a target, and the rooms it plays in. */
export interface CastRow {
  /** The target's IP: the Sonos group's coordinator the cast was sent to. */
  ip: string;
  /** Its name: the room, or the rooms of a Sonos group joined by " + ". */
  name: string;
  /** The rooms it plays in now, by id (empty when the rooms are not known). */
  roomIds: RoomId[];
}

/**
 * A running cast's rows: one per target, as the cast was sent (until a cast
 * can regroup the rooms, a target that is a Sonos group of several rooms is
 * one row, named "Kitchen + Patio").
 *
 * Each room belongs to one row: the target that is the room itself, else the
 * target whose Sonos group it is in. So a cast joined into one Sonos group
 * ("Play speakers as one group") keeps one row per room it was sent to,
 * although the topology then reports every joined room under the first.
 * @param cast - The cast
 * @param rooms - The rooms here now
 * @returns The rows, in the cast's order
 */
export function castRows(
  cast: Pick<ActiveCast, 'speakerIps' | 'speakerNames'>,
  rooms: readonly Room[],
): CastRow[] {
  const targets = new Set(cast.speakerIps);
  const ownerOf = (room: Room): string | undefined =>
    targets.has(room.ip)
      ? room.ip
      : targets.has(room.coordinatorIp)
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
 * @returns The levels, by room id
 */
export function undoLevels(
  row: CastRow,
  rooms: readonly Room[],
  state: SonosStateSnapshot,
): Record<RoomId, number> {
  const levels: Record<RoomId, number> = {};
  for (const id of row.roomIds) {
    const room = rooms.find((r) => r.id === id);
    const now = room && roomLevel(room, state).now;
    if (now !== undefined) levels[id] = now;
  }
  return levels;
}

/** Who a cast's master moves. */
export interface MasterTargets {
  /**
   * The targets joined into the first target's Sonos group, the first among them, moved as
   * one by the group's volume; empty when the cast is not joined.
   */
  joined: string[];
  /** The targets that play on their own (a room added to a joined cast), moved one by one. */
  solo: string[];
}

/**
 * Splits a cast's targets for its master. A cast joined into one Sonos group ("Play speakers
 * as one group") is moved by the group's volume, but a room added later plays on its own
 * stream outside that group (the interim add), so it is moved on its own.
 * @param cast - The cast
 * @param rooms - The rooms here now
 * @returns The joined and the solo targets
 */
export function masterTargets(
  cast: Pick<ActiveCast, 'speakerIps' | 'syncSpeakers'>,
  rooms: readonly Room[],
): MasterTargets {
  const [first] = cast.speakerIps;
  if (!cast.syncSpeakers || first === undefined) return { joined: [], solo: [...cast.speakerIps] };
  const joined = cast.speakerIps.filter(
    (ip) => ip === first || rooms.some((room) => room.ip === ip && room.coordinatorIp === first),
  );
  if (joined.length < 2) return { joined: [], solo: [...cast.speakerIps] };
  return { joined, solo: cast.speakerIps.filter((ip) => !joined.includes(ip)) };
}

/**
 * The rooms a running cast could add: every room here that it does not
 * already play in.
 * @param cast - The cast
 * @param rooms - The rooms here now
 * @returns The rooms, by name
 */
export function addableRooms(cast: Pick<ActiveCast, 'speakerIps'>, rooms: readonly Room[]): Room[] {
  return rooms.filter((room) => !cast.speakerIps.includes(room.coordinatorIp));
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
