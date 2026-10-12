import type { JSX } from 'preact';
import { Icon } from '../Icon';
import { percentOf } from '../Slider/geometry';
import { cx } from '../utils/cx';
import styles from './Meter.module.css';

/** Props for {@link Meter}. */
export interface MeterProps {
  /** The visible name, e.g. the room: "Kitchen". */
  name: string;
  /** The accessible name: "{{name}} reserve". */
  label: string;
  /** The reading, in ms. */
  value: number;
  /** The top of the scale, in ms. */
  max: number;
  /** At or under this the reading is low: the warning fill and glyph. */
  low: number;
  /** The reading in words, in its `--ch-ms` box: "1240 ms". */
  valueText: string;
}

/**
 * Whether a reading is low.
 * @param value - The reading
 * @param low - The low mark
 * @returns True at or under the low mark
 */
export function isLow(value: number, low: number): boolean {
  return value <= low;
}

/**
 * A speaker's reserve, a desktop diagnostic shown only with diagnostics on (DESIGN.md
 * A-meter): a native `<meter>` on a `--size-track` track with the reading in a `--ch-ms`
 * box. Normal is the primary fill; low shows the warning fill and the `warning` glyph, two
 * cues. A tick marks the low point.
 * @param props - Component props
 * @param props.name - The visible name
 * @param props.label - The accessible name
 * @param props.value - The reading, in ms
 * @param props.max - The top of the scale
 * @param props.low - The low mark
 * @param props.valueText - The reading in words
 * @returns The meter row
 */
export function Meter({ name, label, value, max, low, valueText }: MeterProps): JSX.Element {
  const lowNow = isLow(value, low);
  return (
    <div
      class={cx(styles.row, lowNow && styles.low)}
      style={{ '--meter-low': percentOf(low, 0, max) }}
    >
      <span class={styles.glyph}>{lowNow && <Icon glyph="warning" />}</span>
      <span class={styles.name} aria-hidden="true">
        {name}
      </span>
      <meter
        class={styles.meter}
        min={0}
        max={max}
        low={low}
        optimum={max}
        value={value}
        aria-label={label}
        aria-valuetext={valueText}
      />
      <span class={cx(styles.value, 'num')} aria-hidden="true">
        {valueText}
      </span>
    </div>
  );
}
