import type { JSX } from 'preact';

/** The broadcast arcs at radius 6 and 10 on the 24-unit grid. */
const ARCS = [
  'M16.24 7.76A6 6 0 0 1 16.24 16.24',
  'M7.76 7.76A6 6 0 0 0 7.76 16.24',
  'M19.07 4.93A10 10 0 0 1 19.07 19.07',
  'M4.93 4.93A10 10 0 0 0 4.93 19.07',
];

/**
 * A vertex-up octagon round the centre of the 24-unit grid.
 * @param r - Its circumradius, in grid units
 * @returns The polygon's points
 */
export function octagonPoints(r: number): string {
  return Array.from({ length: 8 }, (_, k) => {
    const a = -Math.PI / 2 + (k * Math.PI) / 4;
    const x = Math.round((12 + r * Math.cos(a)) * 100) / 100;
    const y = Math.round((12 + r * Math.sin(a)) * 100) / 100;
    return `${x},${y}`;
  }).join(' ');
}

/** Props for {@link Mark}. */
export interface MarkProps {
  /** Casting: the octagon is filled in the mark's own ink (never magenta). */
  lit?: boolean;
}

/**
 * The product mark, 1b (DESIGN.md F-mark): the broadcast arcs round an octagon outline;
 * while casting the octagon is lit, filled in the same ink. Drawn for 20 px and up, in
 * currentColor; the tray and toolbar icons are drawn natively at their own sizes.
 * @param props - Component props
 * @param props.lit - Casting
 * @returns The mark, decorative
 */
export function Mark({ lit = false }: MarkProps): JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {ARCS.map((d) => (
        <path
          key={d}
          d={d}
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        />
      ))}
      {lit ? (
        <polygon
          points={octagonPoints(3)}
          fill="currentColor"
          stroke="currentColor"
          stroke-width="0.8"
          stroke-linejoin="round"
        />
      ) : (
        <polygon
          points={octagonPoints(2.7)}
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linejoin="miter"
        />
      )}
    </svg>
  );
}
