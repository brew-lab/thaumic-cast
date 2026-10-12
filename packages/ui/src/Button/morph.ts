/*
 * The pure parts of a Button's change of state (DESIGN.md A-button, "Changing state"): the
 * timing of the words and where the words it leaves are held. Button.tsx measures and runs
 * the animations; these take numbers in and give numbers out, so they are unit tested.
 */

/**
 * The share of `--dur-change` over which the words a Button leaves fade out, from the start.
 * The words it goes to fade in over the second half, so the two never show at once.
 */
export const OUT_END = 0.4;

/** The share of `--dur-change` at which the words a Button goes to start to fade in. */
export const IN_START = 0.5;

/**
 * Reads a CSS time ("268ms", "0.268s", "0s") as milliseconds.
 * @param value - A resolved CSS time, such as the computed `--dur-change`
 * @returns The time in ms; 0 when it is empty or not a time
 */
export function parseTime(value: string): number {
  const match = /^\s*(-?[\d.]+)(ms|s)\s*$/.exec(value);
  if (!match) return 0;
  const n = Number(match[1]) * (match[2] === 's' ? 1000 : 1);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A box along the inline axis: where it starts and ends, in the inline direction. */
export interface Span {
  /** The start edge. */
  start: number;
  /** The end edge. */
  end: number;
}

/**
 * A rectangle's span along the inline axis, measured in the inline direction, so the start
 * edge is the smaller number in both directions.
 * @param left - Its left edge
 * @param right - Its right edge
 * @param rtl - Whether the inline direction runs right to left
 * @returns Its start and end
 */
export function inlineSpan(left: number, right: number, rtl: boolean): Span {
  return rtl ? { start: -right, end: -left } : { start: left, end: right };
}

/** Which edge of a Button stays still while its width changes. */
export type Anchor = 'start' | 'end' | 'center';

/** How close two edges must be to count as the same place, in px. */
const SAME = 0.5;

/**
 * Which edge of the Button stays put across a change: the layout decides. A Button with a
 * free end keeps its start, an end-aligned one keeps its end, and one that is centred, or
 * whose both edges move, keeps its centre. A width that holds keeps its start.
 * @param from - The Button before the change
 * @param to - The Button after it
 * @returns The edge that stays
 */
export function anchorOf(from: Span, to: Span): Anchor {
  if (Math.abs(from.start - to.start) < SAME) return 'start';
  if (Math.abs(from.end - to.end) < SAME) return 'end';
  return 'center';
}

/**
 * Where the words a Button leaves are held while they fade: their old place, measured from
 * the edge that stays, as an `inset-inline-start` in the Button's padding box. They never
 * move with the edge that moves.
 * @param anchor - The edge that stays
 * @param box - The Button before the change (its border box)
 * @param unit - The words and glyph before the change
 * @param border - The Button's inline border widths
 * @param border.start - The start border
 * @param border.end - The end border
 * @returns A CSS length for `inset-inline-start`
 */
export function heldAt(
  anchor: Anchor,
  box: Span,
  unit: Span,
  border: { start: number; end: number },
): string {
  const px = (n: number): string => `${Number(n.toFixed(2))}px`;
  if (anchor === 'start') return px(unit.start - box.start - border.start);
  if (anchor === 'end') return `calc(100% - ${px(box.end - border.end - unit.start)})`;
  return `calc(50% - ${px((box.start + box.end) / 2 - unit.start)})`;
}
