import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Clacks } from '../Clacks';
import { Icon } from '../Icon';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import styles from './Switch.module.css';

/** Props for {@link Switch}. */
export interface SwitchProps extends DataAttributes {
  /** On or off. */
  checked: boolean;
  /** Called with the new state. */
  onChange: (checked: boolean) => void;
  /** The row's name, e.g. "Sync video". */
  label: string;
  /** A line under the label. */
  description?: ComponentChildren;
  /** A note under the description, read at full strength (why it is locked, when it applies). */
  note?: ComponentChildren;
  /** Disabled (for example, locked by an environment variable). */
  disabled?: boolean;
  /** Busy, for a change the OS applies (Launch at login): the Clacks on the thumb. */
  busy?: boolean;
  /** The row's error, after the switch slid back: "The settings were not saved. Try again." */
  error?: string;
}

/**
 * The on-off control (DESIGN.md A-switch), drawn as a row: the label and description at the
 * start and the track at the end. The whole row is the target and one tab stop. Only the
 * thumb reshapes (a bevel on hover and focus, a squarer corner pressed), and the ring goes
 * round the track. Off has an outlined track; on, the primary track; the thumb's position
 * is the cue, never the colour alone. The density sets the track's size.
 * @param props - Component props
 * @param props.checked - On or off
 * @param props.onChange - Called with the new state
 * @param props.label - The row's name
 * @param props.description - A line under the label
 * @param props.note - A note under the description
 * @param props.disabled - Disabled
 * @param props.busy - Busy
 * @param props.error - The row's error
 * @returns The switch row
 */
export function Switch({
  checked,
  onChange,
  label,
  description,
  note,
  disabled = false,
  busy = false,
  error,
  ...rest
}: SwitchProps): JSX.Element {
  const id = useId();
  const described = [description && `${id}-d`, note && `${id}-n`, error && `${id}-e`]
    .filter(Boolean)
    .join(' ');
  return (
    <div class={cx(styles.row, disabled && styles.disabled, error && styles.error)}>
      <label class={styles.text} for={id}>
        <span id={`${id}-l`} class={styles.label}>
          {label}
        </span>
        {description && (
          <span id={`${id}-d`} class={styles.description}>
            {description}
          </span>
        )}
        {note && (
          <span id={`${id}-n`} class={styles.note}>
            {note}
          </span>
        )}
      </label>
      <button
        id={id}
        type="button"
        role="switch"
        class={styles.track}
        aria-checked={checked}
        aria-labelledby={`${id}-l`}
        aria-describedby={described || undefined}
        aria-busy={busy ? 'true' : undefined}
        aria-disabled={busy ? 'true' : undefined}
        disabled={disabled}
        onClick={() => {
          if (!busy) onChange(!checked);
        }}
        {...dataAttributes(rest)}
      >
        <span class={styles.thumb}>{busy && <Clacks size="sm" />}</span>
      </button>
      {error && (
        <p id={`${id}-e`} class={styles.message}>
          <Icon glyph="danger" />
          <span>{error}</span>
        </p>
      )}
    </div>
  );
}
