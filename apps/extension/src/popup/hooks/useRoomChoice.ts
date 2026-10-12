import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Room, RoomId, SonosStateSnapshot } from '@thaumic-cast/protocol';
import {
  EMPTY_ROOM_SETS,
  ROOM_SETS_KEY,
  choiceOnOpen,
  loadRoomSets,
  parseRoomSets,
  refOf,
  saveRoomSet,
  type RoomSets,
  type SaveSetError,
} from '../../lib/room-sets';
import { canSaveSet, setViews, type SetView } from '../../lib/popup-rooms';
import { useMountedRef } from './useMountedRef';
import { useStorageListener } from './useStorageListener';

/** The inline "Save these rooms as a set" form. */
export interface SaveSetForm {
  /** Offered: two or more rooms chosen that equal no set. */
  shown: boolean;
  /** Open. */
  open: boolean;
  /** The name typed so far. */
  name: string;
  /** The error's key, after a save with no name. */
  error: SaveSetError | null;
  /** Opens the form. */
  onOpen: () => void;
  /** The name is typed. */
  onName: (name: string) => void;
  /** Saves the chosen rooms under the name. */
  onSave: () => void;
  /** Shuts the form. */
  onCancel: () => void;
}

/** What {@link useRoomChoice} returns. */
export interface RoomChoice {
  /** The stored sets have been read (and the choice made). */
  ready: boolean;
  /** The chosen room ids, in the order chosen; a room no longer here is skipped. */
  choice: RoomId[];
  /** The chosen rooms that are here, in the order chosen. */
  chosen: Room[];
  /** Chooses or unchooses a room. */
  toggle: (id: RoomId, on: boolean) => void;
  /** The sets the picker offers. */
  sets: SetView[];
  /** A set was pressed: the choice becomes its rooms that are here. */
  chooseSet: (id: string) => void;
  /** The save form. */
  save: SaveSetForm;
}

/**
 * The rooms chosen in the TabCard (P-picker). When the rooms first arrive, the
 * stored sets are read (the old speaker selection migrates into Last cast
 * once) and the choice starts as Last cast's rooms that are here, or else the
 * first room no other client casts to. The choice is popup state: Last cast
 * is written by the background only when a cast starts. Sets live on this
 * device and are never synced.
 * @param rooms - The rooms here now
 * @param state - The Sonos state
 * @param castingIps - The speakers this browser casts to
 * @returns The choice, the sets and the save form
 */
export function useRoomChoice(
  rooms: readonly Room[],
  state: SonosStateSnapshot,
  castingIps: string[],
): RoomChoice {
  const [sets, setSets] = useState<RoomSets>(EMPTY_ROOM_SETS);
  const [choice, setChoice] = useState<RoomId[]>([]);
  const [ready, setReady] = useState(false);
  const [form, setForm] = useState<{ open: boolean; name: string; error: SaveSetError | null }>({
    open: false,
    name: '',
    error: null,
  });
  const started = useRef(false);
  const mountedRef = useMountedRef();

  useEffect(() => {
    if (started.current || rooms.length === 0) return;
    started.current = true;
    loadRoomSets(rooms).then((stored) => {
      if (!mountedRef.current) return;
      setSets(stored);
      setChoice(choiceOnOpen(stored, rooms, state, castingIps));
      setReady(true);
    });
  }, [rooms]);

  // Another popup or the background (Last cast) changed the sets.
  useStorageListener<unknown>(ROOM_SETS_KEY, (raw) => {
    const parsed = parseRoomSets(raw);
    if (parsed) setSets(parsed);
  });

  const chosen = useMemo(
    () => choice.flatMap((id) => rooms.find((room) => room.id === id) ?? []),
    [choice, rooms],
  );
  const present = useMemo(() => chosen.map((room) => room.id), [chosen]);
  const views = useMemo(() => setViews(sets, rooms, present), [sets, rooms, present]);

  const toggle = useCallback((id: RoomId, on: boolean) => {
    setChoice((prev) =>
      on ? [...prev.filter((x) => x !== id), id] : prev.filter((x) => x !== id),
    );
  }, []);

  const chooseSet = useCallback(
    (id: string) => {
      const view = views.find((v) => v.id === id);
      if (view) setChoice(view.present.map((room) => room.id));
    },
    [views],
  );

  const onSave = useCallback(() => {
    saveRoomSet(form.name, chosen.map(refOf)).then((result) => {
      if (!mountedRef.current) return;
      if ('error' in result) {
        setForm((prev) => ({ ...prev, error: result.error }));
        return;
      }
      setSets((prev) => ({ ...prev, saved: [...prev.saved, result.set] }));
      setForm({ open: false, name: '', error: null });
    });
  }, [form.name, chosen]);

  const save: SaveSetForm = {
    shown: canSaveSet(present, views),
    open: form.open,
    name: form.name,
    error: form.error,
    onOpen: () => setForm({ open: true, name: '', error: null }),
    // The error clears as soon as the value is valid (P-forms).
    onName: (name) =>
      setForm((prev) => ({ ...prev, name, error: name.trim() ? null : prev.error })),
    onSave,
    onCancel: () => setForm({ open: false, name: '', error: null }),
  };

  return { ready, choice: present, chosen, toggle, sets: views, chooseSet, save };
}
