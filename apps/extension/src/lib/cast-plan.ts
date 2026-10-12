/**
 * Cast Plan
 *
 * Turns the rooms the user chose into the speakers a cast is sent to.
 *
 * Until regrouping lands (pulling a room out of its Sonos group for the cast,
 * and putting it back on Stop), a chosen room casts to its whole Sonos group,
 * through the group's coordinator, exactly as a group row did before rooms.
 * Rooms grouped with a chosen room therefore play too, and the popup says so
 * once. Regrouping will fill `leaving` and empty `extraRooms`.
 *
 * The popup and the background both plan here, from the same rooms, so the
 * line the popup shows and what the background sends always agree.
 */

import type { Room, RoomId } from '@thaumic-cast/protocol';

/** What a cast to the chosen rooms will do. */
export interface CastPlan {
  /** The chosen rooms that are present, in the order chosen. */
  rooms: Room[];
  /** Coordinator IPs, one per Sonos group that holds a chosen room, in the order chosen. */
  targets: string[];
  /** The target each chosen room plays through, keyed by room id. */
  targetOf: Record<RoomId, string>;
  /** Rooms that will play although not chosen (grouped partners), by name. */
  extraRooms: Room[];
  /** Rooms pulled from their Sonos groups for the cast: always empty until regrouping. */
  leaving: Room[];
}

/**
 * Plans a cast to the chosen rooms.
 * @param chosen - The chosen room ids, in order
 * @param rooms - The rooms present now
 * @returns The plan; a chosen room that is not present is left out
 */
export function planCast(chosen: readonly RoomId[], rooms: readonly Room[]): CastPlan {
  const picked: Room[] = [];
  for (const id of chosen) {
    const room = rooms.find((r) => r.id === id);
    if (room && !picked.includes(room)) picked.push(room);
  }
  const targets = [...new Set(picked.map((room) => room.coordinatorIp))];
  const targetOf = Object.fromEntries(picked.map((room) => [room.id, room.coordinatorIp]));
  const groupIds = new Set(picked.map((room) => room.groupId));
  const extraRooms = rooms
    .filter((room) => groupIds.has(room.groupId) && !picked.includes(room))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { rooms: picked, targets, targetOf, extraRooms, leaving: [] };
}

/** The interim line's key: "{{name}} plays too…" / "{{names}} play too…". */
export const PLAYS_TOO_KEY = 'cast_plays_too';

/** The CastBar line saying which unchosen rooms play too, ready for `t`. */
export interface PlaysTooLine {
  /** The string key (a plural, by `count`). */
  key: typeof PLAYS_TOO_KEY;
  /** The values it takes. */
  params: {
    /** How many rooms play too. */
    count: number;
    /** The one room that plays too (singular form). */
    name: string;
    /** The chosen rooms it is grouped with, as a list (singular form). */
    with: string;
    /** Every room that plays too, as a list (plural form). */
    names: string;
  };
}

/**
 * The line that tells the user which rooms play although they did not choose
 * them, or null when the chosen rooms are whole Sonos groups.
 * @param plan - The cast plan
 * @param list - Joins names as a list in the UI language ("Kitchen and Study")
 * @returns The line, or null
 */
export function playsTooLine(
  plan: CastPlan,
  list: (names: string[]) => string,
): PlaysTooLine | null {
  const extra = plan.extraRooms;
  if (extra.length === 0) return null;
  const first = extra[0];
  const grouped = plan.rooms
    .filter((room) => room.groupId === first.groupId)
    .map((room) => room.name)
    .sort((a, b) => a.localeCompare(b));
  return {
    key: PLAYS_TOO_KEY,
    params: {
      count: extra.length,
      name: first.name,
      with: list(grouped),
      names: list(extra.map((room) => room.name)),
    },
  };
}
