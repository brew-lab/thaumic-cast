import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  EMPTY_ROOM_SETS,
  ROOM_SETS_KEY,
  loadRoomSets,
  parseRoomSets,
  removeRoomSet,
  renameRoomSet,
  restoreRoomSet,
  type RemovedSet,
  type RoomSets,
  type SaveSetError,
} from '../../lib/room-sets';
import { useStorageListener } from '../../popup/hooks/useStorageListener';

/** The saved sets and what Settings can do to them. */
export interface SavedSetsResult {
  /** Every set as stored. */
  sets: RoomSets;
  /** Renames a set; resolves to the error key when the name is empty. */
  rename: (id: string, name: string) => Promise<SaveSetError | undefined>;
  /** Removes a set at once; resolves to it and its place, for Undo. */
  remove: (id: string) => Promise<RemovedSet | null>;
  /** Puts a removed set back at its place. */
  restore: (removed: RemovedSet) => Promise<void>;
}

/**
 * The saved sets for Settings › Saved sets: read once, then kept as stored, so a set saved in
 * the popup while the page is open turns up here too. Each change shows the sets as written.
 * @returns The sets and their actions
 */
export function useSavedSets(): SavedSetsResult {
  const [sets, setSets] = useState<RoomSets>(EMPTY_ROOM_SETS);

  useEffect(() => {
    void loadRoomSets([]).then(setSets);
  }, []);

  useStorageListener<unknown>(ROOM_SETS_KEY, (value) => {
    const parsed = parseRoomSets(value);
    if (parsed) setSets(parsed);
  });

  const rename = useCallback(async (id: string, name: string) => {
    const result = await renameRoomSet(id, name);
    if ('error' in result) return result.error;
    setSets(result.sets);
    return undefined;
  }, []);

  const remove = useCallback(async (id: string) => {
    const { removed, sets: next } = await removeRoomSet(id);
    setSets(next);
    return removed;
  }, []);

  const restore = useCallback(async (removed: RemovedSet) => {
    setSets(await restoreRoomSet(removed));
  }, []);

  return { sets, rename, remove, restore };
}
