/**
 * The snake path of the Clacks (DESIGN.md A-clacks): the shutters are four by two in reading
 * order, and the path runs along the top row and back along the bottom one (cells 0 1 2 3,
 * then 7 6 5 4). Each entry is a cell's place on the path, so cell 4 (bottom left) is last.
 */
export const CLACKS_PATH: readonly number[] = [0, 1, 2, 3, 7, 6, 5, 4];

/** How many shutters are open at once while working. */
export const CLACKS_OPEN = 3;

/**
 * The cells open at one step of the walk: the head and the two behind it on the path.
 * @param step - The step, counted from 0; it wraps every eight
 * @returns The open cells, in reading order
 */
export function openCells(step: number): number[] {
  const n = CLACKS_PATH.length;
  const places = Array.from({ length: CLACKS_OPEN }, (_, k) => (((step - k) % n) + n) % n);
  return CLACKS_PATH.map((place, cell) => (places.includes(place) ? cell : -1))
    .filter((cell) => cell >= 0)
    .sort((a, b) => a - b);
}
