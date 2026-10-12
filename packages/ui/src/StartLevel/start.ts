/**
 * The start level's pure rules (DESIGN.md P-start, annex 2 §4): which level a room starts at,
 * and the words each situation shows and says. The component draws them; nothing here reads
 * a speaker or sends anything.
 */

/** What is known about a room's level before Cast. */
export interface StartLevelLevel {
  /** The room's level read before casting; undefined while it is not known. */
  now?: number;
  /** A level set by hand for this cast (popup state only). */
  set?: number;
  /** A fixed output (line level): the level is never set. */
  fixed?: boolean;
}

/** The start level a room shows. */
export type StartShown =
  /** A fixed output: "Fixed", never set. */
  | { kind: 'fixed' }
  /** Not known yet: "…"; at Cast the room is read, or starts at the limit. */
  | { kind: 'unknown'; limit: number | null }
  /**
   * A level. `why` is `plain` when it is the room's level now (at or under the limit, or the
   * limit off, or set by hand to the level it is at), `capped` when the limit turned it down,
   * and `set` when it was set by hand to another level.
   */
  | { kind: 'level'; start: number; now?: number; why: 'plain' | 'capped' | 'set' };

/**
 * The level a room starts at: min(now, limit), a level set by hand winning for this cast
 * (with no warning, higher or lower), "…" while unknown and "Fixed" for a fixed output.
 * @param level - What is known about the room's level
 * @param limit - "Start no louder than", or null when it is off
 * @returns What the room shows
 */
export function startShown(level: StartLevelLevel, limit: number | null): StartShown {
  if (level.fixed) return { kind: 'fixed' };
  if (level.set !== undefined) {
    const differs = level.now !== undefined && level.now !== level.set;
    return { kind: 'level', start: level.set, now: level.now, why: differs ? 'set' : 'plain' };
  }
  if (level.now === undefined) return { kind: 'unknown', limit };
  if (limit !== null && level.now > limit) {
    return { kind: 'level', start: limit, now: level.now, why: 'capped' };
  }
  return { kind: 'level', start: level.now, now: level.now, why: 'plain' };
}

/**
 * Whether a start level can be set by hand: any level, and "…" while the limit is on (its
 * StartLine starts at the limit). "Fixed" never can, and neither can "…" with the limit off,
 * which has no number to start the slider from.
 * @param shown - The start level, from {@link startShown}
 * @returns True when a chosen room shows the LevelButton
 */
export function startSettable(shown: StartShown): boolean {
  return shown.kind === 'level' || (shown.kind === 'unknown' && shown.limit !== null);
}

/**
 * The words the start level needs, from the app's locale (the UI package holds none). Keys
 * are the extension's (annex 2 §4, plan §5).
 */
export interface StartLevelStrings {
  /** `start_level_speaker`: "{{name}} start level", the slider's and the button's name. */
  label: (name: string) => string;
  /** `start_level_caption`: "Now {{now}}; starts at {{start}}", for a level set by hand. */
  caption: (now: number, start: number) => string;
  /** `start_level_capped`: "Now {{now}}; starts at your limit of {{limit}}". */
  capped: (now: number, limit: number) => string;
  /** `start_level_capped_from`: "capped from {{now}}", spoken. */
  cappedFrom: (now: number) => string;
  /** `start_level_now_short`: "now {{now}}", spoken. */
  nowShort: (now: number) => string;
  /** `room_level_now`: "at {{level}} now", the room's sub line. */
  levelNow: (now: number) => string;
  /** `start_level_starts_at`: "starts at {{start}}", spoken after an unchosen room's name. */
  startsAt: (start: number) => string;
  /**
   * `start_level_unknown`: "not known yet; starts no louder than {{limit}}", spoken; with
   * the limit off it says only that the level is not known yet.
   */
  unknown: (limit: number | null) => string;
  /** `volume_fixed`: "Fixed". */
  fixed: string;
  /** `volume_fixed_hint`: "fixed level; turn the amplifier instead", spoken. */
  fixedSpoken: string;
}

/** The words for one start level, worked out from {@link startShown}. */
export interface StartWords {
  /** What is shown: the number, "…" or "Fixed". */
  text: string;
  /**
   * Spoken after the room's name where the start is plain text (an unchosen row, "…",
   * "Fixed"): ", starts at 18". The sub line already says the level now.
   */
  spoken: string;
  /** The room's sub line when the start differs from the level now: "at 72 now". */
  sub?: string;
  /** The open StartLine's caption: "Now 72; starts at your limit of 30". */
  caption?: string;
  /** The LevelButton's name: "Living Room start level, 30, capped from 72". */
  name?: string;
  /** The slider's `aria-valuetext`: "30, capped from 72". */
  valueText?: string;
}

/**
 * The words for a start level, row by row as annex 2 §4's table has them.
 * @param shown - The start level, from {@link startShown}
 * @param roomName - The room's name
 * @param strings - The words, from the app's locale
 * @returns What to show and say
 */
export function startWords(
  shown: StartShown,
  roomName: string,
  strings: StartLevelStrings,
): StartWords {
  if (shown.kind === 'fixed') {
    return { text: strings.fixed, spoken: `, ${strings.fixedSpoken}` };
  }
  if (shown.kind === 'unknown') {
    return { text: '…', spoken: `, ${strings.unknown(shown.limit)}` };
  }
  const { start, now, why } = shown;
  const text = String(start);
  const label = strings.label(roomName);
  const spoken = `, ${strings.startsAt(start)}`;
  if (why === 'plain' || now === undefined) {
    return { text, spoken, name: `${label}, ${text}`, valueText: text };
  }
  const reason = why === 'capped' ? strings.cappedFrom(now) : strings.nowShort(now);
  return {
    text,
    spoken,
    sub: strings.levelNow(now),
    caption: why === 'capped' ? strings.capped(now, start) : strings.caption(now, start),
    name: `${label}, ${text}, ${reason}`,
    valueText: `${text}, ${reason}`,
  };
}
