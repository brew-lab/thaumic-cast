import { useCallback, useState } from 'preact/hooks';
import type { RoomId } from '@thaumic-cast/protocol';
import { pendingStartsFor, withPendingStart } from '../../lib/start-level';

/** What {@link useStartLevels} returns. */
export interface StartLevels {
  /** The levels set by hand, by room id. */
  levels: Readonly<Record<RoomId, number>>;
  /** Sets a room's start level by hand, for the next cast or add only. */
  set: (id: RoomId, level: number) => void;
  /** The hand-set levels of these rooms, for START_CAST or ADD_ROOMS. */
  levelsFor: (ids: readonly RoomId[]) => Record<RoomId, number>;
  /** Forgets these rooms' levels once they were sent. */
  clear: (ids: readonly RoomId[]) => void;
  /** Whether a room's StartLine is open. */
  isOpen: (id: RoomId) => boolean;
  /** Opens or shuts a room's StartLine. */
  setOpen: (id: RoomId, open: boolean) => void;
}

/**
 * The start levels set by hand before Cast (P-start). They stay in the popup:
 * nothing is sent to a speaker until Cast (or Add), and each is for that cast
 * only. Nothing is remembered per room.
 * @returns The levels and their StartLines
 */
export function useStartLevels(): StartLevels {
  const [levels, setLevels] = useState<Record<RoomId, number>>({});
  const [open, setOpenMap] = useState<Record<RoomId, boolean>>({});

  const set = useCallback((id: RoomId, level: number) => {
    setLevels((prev) => withPendingStart(prev, id, level));
  }, []);

  const levelsFor = useCallback(
    (ids: readonly RoomId[]) => pendingStartsFor([...ids], levels),
    [levels],
  );

  const clear = useCallback((ids: readonly RoomId[]) => {
    setLevels((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => !ids.includes(id))),
    );
    setOpenMap((prev) =>
      Object.fromEntries(Object.entries(prev).filter(([id]) => !ids.includes(id))),
    );
  }, []);

  const isOpen = useCallback((id: RoomId) => open[id] === true, [open]);
  const setOpen = useCallback((id: RoomId, value: boolean) => {
    setOpenMap((prev) => ({ ...prev, [id]: value }));
  }, []);

  return { levels, set, levelsFor, clear, isOpen, setOpen };
}
