import type { ComponentChildren, JSX } from 'preact';
import { dataAttributes, type DataAttributes } from '../utils/cx';
import styles from './Radio.module.css';

/** Props for {@link Radio}. */
export interface RadioProps extends DataAttributes {
  /** The group's name: radios with one name are one group, with one tab stop. */
  name: string;
  /** This option's value. */
  value: string;
  /** Whether this option is the chosen one. */
  checked: boolean;
  /** Called with this option's value when it is chosen. */
  onChange: (value: string) => void;
  /** The option's name. */
  label: ComponentChildren;
  /** A line under the name; it is part of the label. */
  description?: ComponentChildren;
  /** A note under the description, read at full strength (why it is disabled). */
  note?: ComponentChildren;
  /** Disabled. */
  disabled?: boolean;
}

/**
 * One option of a pick-one group (DESIGN.md A-radio): a native radio in a label, so the
 * whole option is one control. It takes the state layer on its 8 px corner and carries the
 * ring, and never reshapes; the radio is round in every state, off a 2 px outline ring, on
 * a primary ring and dot. Native radios give one tab stop on the chosen option and arrow
 * keys that move and choose. In v1 it is used only inside ChoiceGroup (Phase 2).
 * @param props - Component props
 * @param props.name - The group's name
 * @param props.value - This option's value
 * @param props.checked - Chosen
 * @param props.onChange - Called with the value when chosen
 * @param props.label - The option's name
 * @param props.description - A line under the name
 * @param props.note - A note under the description
 * @param props.disabled - Disabled
 * @returns The labelled radio
 */
export function Radio({
  name,
  value,
  checked,
  onChange,
  label,
  description,
  note,
  disabled = false,
  ...rest
}: RadioProps): JSX.Element {
  return (
    <label class={styles.option} {...dataAttributes(rest)}>
      <span class={styles.box}>
        <input
          type="radio"
          class={styles.input}
          name={name}
          value={value}
          checked={checked}
          disabled={disabled}
          onChange={() => onChange(value)}
        />
        <span class={styles.dot} />
      </span>
      <span class={styles.text}>
        <span class={styles.label}>{label}</span>
        {description && <span class={styles.description}>{description}</span>}
        {note && <span class={styles.note}>{note}</span>}
      </span>
    </label>
  );
}
