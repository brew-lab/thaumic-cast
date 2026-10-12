/**
 * Room Sets
 *
 * The rooms a cast went to last ("Last cast") and the sets the user saved, by
 * room id. They live in `chrome.storage.local`: speakers are on this network,
 * so nothing is synced to the user's other browsers.
 *
 * Each room is kept with its name as it was when stored, so a set whose room
 * no longer answers can still say which room is missing.
 *
 * Responsibilities:
 * - Read and write the stored sets, tolerating a damaged entry
 * - Move the old speaker selection (by IP) into Last cast, once
 * - Decide which rooms are chosen when the popup opens
 *
 * Non-responsibilities:
 * - Renaming and removing sets (SetList, Phase 4)
 */

import { z } from 'zod';
import { createLogger } from '@thaumic-cast/shared';
import type { Room, RoomId, SonosStateSnapshot } from '@thaumic-cast/protocol';
import { roomAvailability } from '@thaumic-cast/protocol';

const log = createLogger('RoomSets');

/** The storage key of the sets. */
export const ROOM_SETS_KEY = 'roomSets';

/** The old selection, by speaker IP, migrated into Last cast once. */
export const LEGACY_SELECTION_KEY = 'speakerSelection';

/** A room as a set keeps it: its id, and its name when it was stored. */
export const RoomRefSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
});
export type RoomRef = z.infer<typeof RoomRefSchema>;

/** A set the user saved. */
export const SavedSetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rooms: z.array(RoomRefSchema),
});
export type SavedSet = z.infer<typeof SavedSetSchema>;

/** Everything stored. */
export interface RoomSets {
  /** The stored shape's version. */
  version: 1;
  /** The rooms the last cast went to, in order. */
  lastCast: RoomRef[];
  /** The saved sets, oldest first. */
  saved: SavedSet[];
}

/** No sets at all. */
export const EMPTY_ROOM_SETS: RoomSets = { version: 1, lastCast: [], saved: [] };

/**
 * Reads the stored sets. Damaged rooms and sets are dropped one by one, so
 * one bad entry never loses the rest.
 * @param raw - The stored value
 * @returns The sets, or null when nothing (usable) is stored
 */
export function parseRoomSets(raw: unknown): RoomSets | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1) return null;
  const refs = (value: unknown): RoomRef[] =>
    Array.isArray(value)
      ? value.flatMap((item) => {
          const parsed = RoomRefSchema.safeParse(item);
          return parsed.success ? [parsed.data] : [];
        })
      : [];
  const saved = Array.isArray(record.saved)
    ? record.saved.flatMap((item) => {
        const parsed = SavedSetSchema.safeParse(
          typeof item === 'object' && item !== null
            ? { ...item, rooms: refs((item as Record<string, unknown>).rooms) }
            : item,
        );
        return parsed.success ? [parsed.data] : [];
      })
    : [];
  return { version: 1, lastCast: refs(record.lastCast), saved };
}

/**
 * Names a room for a set.
 * @param room - The room
 * @returns Its id and name
 */
export function refOf(room: Pick<Room, 'id' | 'name'>): RoomRef {
  return { id: room.id, name: room.name };
}

/**
 * Maps the old selection (group coordinator IPs) to rooms: each IP to the room
 * whose primary has it. IPs that match no room are dropped.
 * @param selectedIps - The old selection
 * @param rooms - The rooms present now
 * @returns The rooms, in the old order, without repeats
 */
export function migrateSelection(
  selectedIps: readonly string[],
  rooms: readonly Room[],
): RoomRef[] {
  const out: RoomRef[] = [];
  for (const ip of selectedIps) {
    const room = rooms.find((r) => r.ip === ip);
    if (room && !out.some((ref) => ref.id === room.id)) out.push(refOf(room));
  }
  return out;
}

/**
 * Loads the sets. The first time rooms are known and no sets are stored, the
 * old speaker selection becomes Last cast and is removed.
 * @param rooms - The rooms present now; with none, nothing is migrated yet
 * @returns The sets
 */
export async function loadRoomSets(rooms: readonly Room[]): Promise<RoomSets> {
  try {
    const stored = await chrome.storage.local.get([ROOM_SETS_KEY, LEGACY_SELECTION_KEY]);
    const sets = parseRoomSets(stored[ROOM_SETS_KEY]);
    if (sets) return sets;
    if (rooms.length === 0) return EMPTY_ROOM_SETS;

    const legacy = stored[LEGACY_SELECTION_KEY] as { selectedIps?: unknown } | undefined;
    const ips = Array.isArray(legacy?.selectedIps)
      ? legacy.selectedIps.filter((ip): ip is string => typeof ip === 'string')
      : [];
    const migrated: RoomSets = { ...EMPTY_ROOM_SETS, lastCast: migrateSelection(ips, rooms) };
    await chrome.storage.local.set({ [ROOM_SETS_KEY]: migrated });
    await chrome.storage.local.remove(LEGACY_SELECTION_KEY);
    return migrated;
  } catch (err) {
    log.error('Failed to load the room sets:', err);
    return EMPTY_ROOM_SETS;
  }
}

/**
 * Changes the stored sets, reading them fresh so two writers do not undo each
 * other's change.
 * @param change - Builds the new sets from the stored ones
 * @returns The sets written
 */
async function updateRoomSets(change: (sets: RoomSets) => RoomSets): Promise<RoomSets> {
  const stored = await chrome.storage.local.get(ROOM_SETS_KEY);
  const next = change(parseRoomSets(stored[ROOM_SETS_KEY]) ?? EMPTY_ROOM_SETS);
  await chrome.storage.local.set({ [ROOM_SETS_KEY]: next });
  return next;
}

/**
 * Records the rooms a cast started on as Last cast. Called only once a cast
 * has started, never when the choice changes.
 * @param rooms - The rooms, in order
 * @returns Resolves when stored
 */
export async function recordLastCast(rooms: readonly RoomRef[]): Promise<void> {
  if (rooms.length === 0) return;
  try {
    await updateRoomSets((sets) => ({ ...sets, lastCast: [...rooms] }));
  } catch (err) {
    log.error('Failed to record the last cast:', err);
  }
}

/** Why a set could not be saved: the string key the save form shows. */
export type SaveSetError = 'set_name_required';

/**
 * Checks a set's name.
 * @param name - The name typed
 * @returns The trimmed name, or the error
 */
export function checkSetName(name: string): { name: string } | { error: SaveSetError } {
  const trimmed = name.trim();
  return trimmed ? { name: trimmed } : { error: 'set_name_required' };
}

/**
 * Saves the chosen rooms as a set.
 * @param name - The set's name
 * @param rooms - The rooms, in order
 * @returns The new set, or the reason it was not saved
 */
export async function saveRoomSet(
  name: string,
  rooms: readonly RoomRef[],
): Promise<{ set: SavedSet } | { error: SaveSetError }> {
  const checked = checkSetName(name);
  if ('error' in checked) return checked;
  const set: SavedSet = { id: crypto.randomUUID(), name: checked.name, rooms: [...rooms] };
  await updateRoomSets((sets) => ({ ...sets, saved: [...sets.saved, set] }));
  return { set };
}

/** A set's rooms, split by whether they are here now. */
export interface SetRooms {
  /** The rooms present, in the set's order. */
  present: Room[];
  /** The rooms not present, with their stored names. */
  missing: RoomRef[];
}

/**
 * Splits a set's rooms into those present now and those missing.
 * @param refs - The set's rooms
 * @param rooms - The rooms present now
 * @returns The present and missing rooms
 */
export function setRooms(refs: readonly RoomRef[], rooms: readonly Room[]): SetRooms {
  const present: Room[] = [];
  const missing: RoomRef[] = [];
  for (const ref of refs) {
    const room = rooms.find((r) => r.id === ref.id);
    if (room) present.push(room);
    else missing.push(ref);
  }
  return { present, missing };
}

/**
 * Whether a choice is exactly a set's present rooms, so the set reads pressed.
 * @param choice - The chosen room ids
 * @param refs - The set's rooms
 * @param rooms - The rooms present now
 * @returns True when they are the same rooms, in any order
 */
export function choiceIsSet(
  choice: readonly RoomId[],
  refs: readonly RoomRef[],
  rooms: readonly Room[],
): boolean {
  const { present } = setRooms(refs, rooms);
  if (present.length === 0 || present.length !== new Set(choice).size) return false;
  return present.every((room) => choice.includes(room.id));
}

/**
 * The rooms chosen when the popup opens: Last cast's rooms that are present;
 * with none, the first room no other client is casting to (else the first
 * room). The choice is not stored until a cast starts.
 * @param sets - The stored sets
 * @param rooms - The rooms present now, sorted
 * @param state - The Sonos state, for who is casting where
 * @param castingIps - The speaker IPs this client is casting to
 * @returns The chosen room ids
 */
export function choiceOnOpen(
  sets: RoomSets,
  rooms: readonly Room[],
  state: SonosStateSnapshot,
  castingIps: string[],
): RoomId[] {
  const last = setRooms(sets.lastCast, rooms).present;
  if (last.length > 0) return last.map((room) => room.id);
  const free = rooms.find((room) => roomAvailability(room, state, castingIps) !== 'remote_cast');
  const first = free ?? rooms[0];
  return first ? [first.id] : [];
}
