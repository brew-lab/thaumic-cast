import type { JSX } from 'preact';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import { fillRange, pageStep, percentOf } from './geometry';
import styles from './Slider.module.css';

/** Props for {@link Slider}. */
export interface SliderProps extends DataAttributes {
  /** The accessible name, e.g. "Kitchen volume". The row around it shows the words. */
  label: string;
  /** The low end. Defaults to 0. */
  min?: number;
  /** The high end. Defaults to 100. */
  max?: number;
  /** One step. Defaults to 1. */
  step?: number;
  /**
   * The value, or undefined while it is not known yet (a speaker that has not reported its
   * level): the handle and the fill are hidden, the slider is inert, and `unknownText` is
   * read in place of a number. A made-up level is never shown.
   */
  value: number | undefined;
  /** Words for the value, read as `aria-valuetext`: "30", "+120 ms". */
  format?: (value: number) => string;
  /** Read in place of the value while it is not known ("Not known yet"). */
  unknownText?: string;
  /** A centre value (trim: 0): the fill runs from it, and a mark shows it. */
  centre?: number;
  /** Disabled, e.g. a row that is joining. */
  disabled?: boolean;
  /** Called as the value changes, on every step of a drag, a click or a key. */
  onChange: (value: number) => void;
  /** Called once when a change is committed (the pointer is released, or a key is let go). */
  onCommit?: (value: number) => void;
  /** Called when the pointer goes down on the slider (a drag begins). */
  onPointerDown?: () => void;
  /** Called when the pointer is released or the gesture is cancelled. */
  onPointerUp?: () => void;
  /** The element id. */
  id?: string;
  /** Ties a caption to the slider. */
  'aria-describedby'?: string;
}

/**
 * The range control (DESIGN.md A-slider), for volume (0–100), the start level and trim
 * (±500 ms, centred on 0). It is a native range: a click anywhere on the track sets the
 * value, so no drag is needed (WCAG 2.5.7), Page Up and Page Down move ten steps, and
 * `aria-valuetext` reads the formatted value. The hit box is `--control-md` tall across the
 * whole track; the handle is a 4 × 28 bar with `--ring-gap` gaps, and it narrows when
 * pressed.
 * @param props - Component props
 * @param props.label - The accessible name
 * @param props.min - The low end
 * @param props.max - The high end
 * @param props.step - One step
 * @param props.value - The value, or undefined while unknown
 * @param props.format - Words for the value
 * @param props.unknownText - Read while the value is unknown
 * @param props.centre - A centre value
 * @param props.disabled - Disabled
 * @param props.onChange - Called as the value changes
 * @param props.onCommit - Called when a change is committed
 * @param props.onPointerDown - Called when a drag begins
 * @param props.onPointerUp - Called when a drag ends
 * @param props.id - The element id
 * @returns The slider
 */
export function Slider({
  label,
  min = 0,
  max = 100,
  step = 1,
  value,
  format = String,
  unknownText = '…',
  centre,
  disabled = false,
  onChange,
  onCommit,
  onPointerDown,
  onPointerUp,
  id,
  ...rest
}: SliderProps): JSX.Element {
  const unknown = value === undefined;
  const shown = unknown ? (centre ?? min) : value;
  const fill = unknown ? { start: -100, end: -100 } : fillRange(shown, min, max, centre);
  const read = (event: Event): number => Number((event.currentTarget as HTMLInputElement).value);

  return (
    <span
      class={cx(styles.slider, unknown && styles.unknown, disabled && styles.disabled)}
      style={{
        '--fill-start': fill.start,
        '--fill-end': fill.end,
        '--centre': centre === undefined ? -100 : percentOf(centre, min, max),
      }}
      {...dataAttributes(rest)}
    >
      <input
        id={id}
        type="range"
        class={styles.input}
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled || unknown}
        aria-label={label}
        aria-valuetext={unknown ? unknownText : format(shown)}
        aria-describedby={rest['aria-describedby']}
        onInput={(event) => onChange(read(event))}
        onChange={(event) => onCommit?.(read(event))}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={(event) => {
          if (event.key !== 'PageUp' && event.key !== 'PageDown') return;
          event.preventDefault();
          const next = pageStep(shown, step, event.key === 'PageUp' ? 1 : -1, min, max);
          if (next !== shown) {
            onChange(next);
            onCommit?.(next);
          }
        }}
      />
    </span>
  );
}
