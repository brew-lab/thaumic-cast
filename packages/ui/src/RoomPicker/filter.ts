/**
 * RoomPicker's search (DESIGN.md C-picker, P-picker): it filters what is shown and never
 * unticks a room, and it counts the chosen rooms it hides.
 */

/** What the search needs of a room. */
export interface FilterRoom {
  /** The room. */
  room: { id: string; name: string };
  /** Chosen. */
  checked: boolean;
}

/**
 * Filters the rooms by a query: a room is shown when its name holds the query, ignoring case
 * and accents. An empty query shows every room. The choice is never changed.
 * @param rooms - Every room, in order
 * @param query - What was typed
 * @returns The rooms shown, in order, and how many chosen rooms the query hides
 */
export function filterRooms<T extends FilterRoom>(
  rooms: readonly T[],
  query: string,
): { shown: T[]; hiddenChosen: number } {
  const fold = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLocaleLowerCase();
  const q = fold(query.trim());
  if (!q) return { shown: [...rooms], hiddenChosen: 0 };
  const shown = rooms.filter((r) => fold(r.room.name).includes(q));
  const hiddenChosen = rooms.filter((r) => r.checked && !shown.includes(r)).length;
  return { shown, hiddenChosen };
}
