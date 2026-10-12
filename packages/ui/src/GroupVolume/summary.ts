/**
 * GroupVolume's pure parts (DESIGN.md M-groupvol): the master's level and the fold's summary.
 */

/** What the summary and the master read from each room. */
export interface SummaryRoom {
  /** The room's name. */
  name: string;
  /** Its level, if known. */
  volume?: number;
  /** Muted. */
  muted: boolean;
  /** Joining: added at the end of the summary. */
  joining?: unknown;
  /** A condition word ("May cut out"), which replaces the level and leads the summary. */
  condition?: string;
}

/** The words the summary needs. */
export interface SummaryStrings {
  /** `volume_summary_muted`: "muted". */
  muted: string;
  /** `room_joining`: "{{name}} is joining…". */
  joining: (name: string) => string;
  /** A room's condition in the summary: "Kitchen may cut out". */
  condition: (name: string, word: string) => string;
}

/**
 * The master's level: the mean of the levels that are known, rounded; undefined while none
 * is (the Slider shows "…").
 * @param rooms - The cast's rooms
 * @returns The mean, or undefined
 */
export function meanVolume(rooms: readonly SummaryRoom[]): number | undefined {
  const known = rooms
    .filter((r) => !r.joining)
    .map((r) => r.volume)
    .filter((v): v is number => v !== undefined);
  if (!known.length) return undefined;
  return Math.round(known.reduce((a, v) => a + v, 0) / known.length);
}

/**
 * The master reads muted only when every room is muted.
 * @param rooms - The cast's rooms
 * @returns Whether the master is muted
 */
export function allMuted(rooms: readonly SummaryRoom[]): boolean {
  const playing = rooms.filter((r) => !r.joining);
  return playing.length > 0 && playing.every((r) => r.muted);
}

/**
 * The fold's summary: every room's level ("Kitchen 30 · Living Room muted"), a room's
 * condition in place of its level and first, and a joining room last.
 * @param rooms - The cast's rooms
 * @param strings - The words
 * @returns The summary
 */
export function volumeSummary(rooms: readonly SummaryRoom[], strings: SummaryStrings): string {
  const conditions = rooms
    .filter((r) => r.condition && !r.joining)
    .map((r) => strings.condition(r.name, r.condition as string));
  const levels = rooms
    .filter((r) => !r.condition && !r.joining)
    .map((r) => `${r.name} ${r.muted ? strings.muted : (r.volume ?? '…')}`);
  const joining = rooms.filter((r) => r.joining).map((r) => strings.joining(r.name));
  return [...conditions, ...levels, ...joining].join(' · ');
}
