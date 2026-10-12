import type { JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Icon } from '../Icon';
import type { GlyphName } from '../Icon/glyphs';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import styles from './SegmentedControl.module.css';

/** One segment. */
export interface SegmentOption<T extends string> {
  /** The value. */
  value: T;
  /** The words. */
  label: string;
  /** A glyph beside the words; the chosen segment shows the check in its place. */
  glyph?: GlyphName;
}

/** Props for {@link SegmentedControl}. */
export interface SegmentedControlProps<T extends string> extends DataAttributes {
  /** The group's name, e.g. "Theme". */
  label: string;
  /** Hide the name visually, when the row beside it already shows it. */
  hideLabel?: boolean;
  /** The chosen value. */
  value: T;
  /** Called with the chosen value. It applies at once. */
  onChange: (value: T) => void;
  /** Two or three segments. */
  options: readonly SegmentOption<T>[];
  /** Disabled. */
  disabled?: boolean;
}

/**
 * A pick-one row of two or three segments (DESIGN.md A-segment), for Appearance (Auto,
 * Light, Dark). It is a radiogroup of native radios: one tab stop, and the arrow keys move
 * and choose. The chosen segment has the primary fill, the strong weight and the check:
 * three cues, so never colour alone. Each segment follows the grammar; the ring goes round
 * the track.
 * @param props - Component props
 * @param props.label - The group's name
 * @param props.hideLabel - Hide the name visually
 * @param props.value - The chosen value
 * @param props.onChange - Called with the chosen value
 * @param props.options - The segments
 * @param props.disabled - Disabled
 * @returns The control
 */
export function SegmentedControl<T extends string>({
  label,
  hideLabel = false,
  value,
  onChange,
  options,
  disabled = false,
  ...rest
}: SegmentedControlProps<T>): JSX.Element {
  const name = useId();
  return (
    <fieldset
      class={cx(styles.group, disabled && styles.disabled)}
      role="radiogroup"
      disabled={disabled}
    >
      <legend class={hideLabel ? 'visually-hidden' : styles.legend}>{label}</legend>
      <span class={styles.track} {...dataAttributes(rest)}>
        {options.map((option) => {
          const chosen = option.value === value;
          const glyph = chosen ? 'check' : option.glyph;
          return (
            <label key={option.value} class={styles.segment}>
              <input
                type="radio"
                class={styles.input}
                name={name}
                value={option.value}
                checked={chosen}
                onChange={() => onChange(option.value)}
              />
              {glyph && <Icon glyph={glyph} />}
              <span class={styles.label}>{option.label}</span>
            </label>
          );
        })}
      </span>
    </fieldset>
  );
}
