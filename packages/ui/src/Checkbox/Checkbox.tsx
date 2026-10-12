import type { ComponentChildren, JSX } from 'preact';
import { Icon } from '../Icon';
import { dataAttributes, type DataAttributes } from '../utils/cx';
import { usePress } from '../utils/press';
import styles from './Checkbox.module.css';

/** Props for {@link Checkbox}. */
export interface CheckboxProps extends DataAttributes {
  /** Ticked or not. There is no mixed state in v1. */
  checked: boolean;
  /** Called with the new state. */
  onChange: (checked: boolean) => void;
  /** The label: the row is the target (RoomRow `pick` puts the room's lines here). */
  label: ComponentChildren;
  /** A line under the label. */
  description?: ComponentChildren;
  /** Disabled: the ring stays at 38 %. */
  disabled?: boolean;
  /** Ties a note to the box. */
  'aria-describedby'?: string;
}

/**
 * The tick box (DESIGN.md A-check): a native checkbox in a label, so the row is the target
 * and takes the state layer on its corner (it never reshapes). The box rests at
 * `--radius-pressed`; hover is colour, focus-visible and a press take the small bevel, nothing
 * scales, and checking fades the check in. Off is a 2 px outline ring; on is a flat primary
 * fill with the check. The density sets the box's size.
 * @param props - Component props
 * @param props.checked - Ticked
 * @param props.onChange - Called with the new state
 * @param props.label - The label
 * @param props.description - A line under the label
 * @param props.disabled - Disabled
 * @returns The labelled checkbox
 */
export function Checkbox({
  checked,
  onChange,
  label,
  description,
  disabled = false,
  ...rest
}: CheckboxProps): JSX.Element {
  const press = usePress(['space']);
  return (
    <label class={styles.row} {...press} {...dataAttributes(rest)}>
      <span class={styles.box}>
        <input
          type="checkbox"
          class={styles.input}
          checked={checked}
          disabled={disabled}
          aria-describedby={rest['aria-describedby']}
          onChange={(event) => onChange((event.currentTarget as HTMLInputElement).checked)}
        />
        <span class={styles.mark}>
          <Icon glyph="check" />
        </span>
      </span>
      <span class={styles.text}>
        <span class={styles.label}>{label}</span>
        {description && <span class={styles.description}>{description}</span>}
      </span>
    </label>
  );
}
