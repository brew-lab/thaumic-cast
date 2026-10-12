import { createElement, type JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Clacks } from '../Clacks';
import { Icon } from '../Icon';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import styles from './Select.module.css';

/** One choice. */
export interface SelectOption<T extends string | number> {
  /** The value. */
  value: T;
  /** The words. */
  label: string;
  /** A second line, shown in the listbox where the browser draws a customisable one. */
  description?: string;
}

/** Props for {@link Select}. */
export interface SelectProps<T extends string | number> extends DataAttributes {
  /** The name, shown above the trigger unless hidden. */
  label: string;
  /** Hide the name visually, when the row beside it already shows it. */
  hideLabel?: boolean;
  /** The chosen value. */
  value: T;
  /** The choices. */
  options: readonly SelectOption<T>[];
  /** Called with the chosen value. */
  onChange: (value: T) => void;
  /**
   * sm (the default) is 32 on every surface; md is 36 in the popup and 44 in a window
   * (F-size). On a window the <select> is the 44 hit area, inside the drawn box.
   */
  size?: 'sm' | 'md';
  /** Invalid: a 2 px danger edge and `aria-invalid`. The message is the caller's. */
  error?: boolean;
  /** Busy, only while a choice is being applied: the Clacks in the trigger. */
  busy?: boolean;
  /** Disabled. */
  disabled?: boolean;
  /** The element id, for a `<label for>` elsewhere; one is made when omitted. */
  id?: string;
  /** Ties the help or the error to the trigger. */
  'aria-describedby'?: string;
}

/** Whether the browser draws a customisable select (`appearance: base-select`). */
export const customizableSelect =
  typeof CSS !== 'undefined' && typeof CSS.supports === 'function'
    ? CSS.supports('appearance', 'base-select')
    : false;

/**
 * The pick-one-of-many control (DESIGN.md A-select). It is a real `<select>`: where the
 * browser supports `appearance: base-select` the listbox is a styled popover with the overlay
 * shadow and the chosen option takes the primary container and the check; elsewhere it is the
 * native list behind the same trigger. The trigger follows the button grammar with the wide
 * press; open shows a 2 px primary edge, an error a 2 px danger edge.
 * @param props - Component props
 * @param props.label - The name
 * @param props.hideLabel - Hide the name visually
 * @param props.value - The chosen value
 * @param props.options - The choices
 * @param props.onChange - Called with the chosen value
 * @param props.size - sm or md
 * @param props.error - Invalid
 * @param props.busy - Busy
 * @param props.disabled - Disabled
 * @param props.id - The element id
 * @returns The labelled select
 */
export function Select<T extends string | number>({
  label,
  hideLabel = false,
  value,
  options,
  onChange,
  size = 'sm',
  error = false,
  busy = false,
  disabled = false,
  id,
  ...rest
}: SelectProps<T>): JSX.Element {
  const ownId = useId();
  const selectId = id ?? ownId;
  return (
    <span class={styles.field}>
      <label for={selectId} class={hideLabel ? 'visually-hidden' : styles.label}>
        {label}
      </label>
      <span class={cx(styles.control, styles[size], error && styles.invalid)} data-size={size}>
        <select
          id={selectId}
          class={styles.select}
          value={String(value)}
          disabled={disabled}
          aria-invalid={error ? 'true' : undefined}
          aria-busy={busy ? 'true' : undefined}
          aria-describedby={rest['aria-describedby']}
          onChange={(event) => {
            const chosen = options[(event.currentTarget as HTMLSelectElement).selectedIndex];
            if (chosen) onChange(chosen.value);
          }}
          {...dataAttributes(rest)}
        >
          {customizableSelect && (
            <button type="button" class={styles.trigger} tabIndex={-1}>
              {createElement('selectedcontent', {})}
            </button>
          )}
          {options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {customizableSelect && option.description ? (
                <span class={styles.optionText}>
                  <span>{option.label}</span>
                  <span class={styles.optionDescription}>{option.description}</span>
                </span>
              ) : (
                option.label
              )}
            </option>
          ))}
        </select>
        <span class={styles.trail}>
          {busy ? <Clacks size="sm" /> : <Icon glyph="chevron-down" />}
        </span>
      </span>
    </span>
  );
}
