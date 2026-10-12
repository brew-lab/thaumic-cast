import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Clacks } from '../Clacks';
import { Icon } from '../Icon';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import { usePress } from '../utils/press';
import styles from './Switch.module.css';

/** Props for {@link Switch}. */
export interface SwitchProps extends DataAttributes {
  /** On or off. */
  checked: boolean;
  /** Called with the new state. */
  onChange: (checked: boolean) => void;
  /** The row's name, e.g. "Sync video". */
  label: string;
  /**
   * A Badge after the name ("In step" on Sync video). The name and the Badge label the
   * switch, so its words are part of the one name; the description and note describe it.
   */
  badge?: ComponentChildren;
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
 * The on-off control (DESIGN.md A-switch), drawn as a row: the name on the track's line,
 * the description and note under it (and in the help track of a wide settings grid). The
 * whole row is the target and one tab stop. Only the thumb reshapes: hover is colour, and
 * focus-visible and a press take the bevel (a press also stretches it inside the track); the
 * ring goes round the track. Off has an outlined track; on, the primary track; the thumb's
 * position is the cue, never the colour alone. The density sets the track's size.
 * @param props - Component props
 * @param props.checked - On or off
 * @param props.onChange - Called with the new state
 * @param props.label - The row's name
 * @param props.badge - A Badge after the name
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
  badge,
  description,
  note,
  disabled = false,
  busy = false,
  error,
  ...rest
}: SwitchProps): JSX.Element {
  const id = useId();
  const press = usePress();
  const described = [description && `${id}-d`, note && `${id}-n`, error && `${id}-e`]
    .filter(Boolean)
    .join(' ');
  return (
    <div
      class={cx(styles.row, error && styles.error)}
      data-setrow=""
      data-tone={error ? 'danger' : undefined}
    >
      <label class={styles.text} for={id}>
        <span id={`${id}-l`} class={styles.head}>
          <span class={styles.label}>{label}</span>
          {badge}
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
        {...press}
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
