import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Icon } from '../Icon';
import { cx } from '../utils/cx';
import styles from './SettingsRow.module.css';

/** What a SettingsRow hands its control, so it is named and described by the row. */
export interface SettingsRowControl {
  /** The id of the row's visible name, for `aria-labelledby` on a control without a label. */
  labelId: string;
  /** The help, then the note, then the error. */
  'aria-describedby'?: string;
}

/** Props for {@link SettingsRow}. */
export interface SettingsRowProps {
  /**
   * The setting's name. Leave it out when the control is a Switch: a Switch is drawn as a
   * row and carries its own name and description, and the SettingsRow then adds only the
   * note, the error and the detail slot.
   */
  label?: string;
  /** One or two lines on what the setting does. */
  help?: ComponentChildren;
  /** A note read at full strength: what it needs, or what locks it. */
  note?: ComponentChildren;
  /** The control, or a function that is given the row's label id and description. */
  control: ComponentChildren | ((a11y: SettingsRowControl) => ComponentChildren);
  /**
   * How much room the control needs. narrow: a Switch, a Select of 15rem or less, the
   * SegmentedControl; wide: anything wider, which stacks under the help below 45rem;
   * action: a Button, centred against the label and the help.
   */
  controlWidth?: 'narrow' | 'wide' | 'action';
  /** A dependent control under the row, shown by the caller while the row's Switch is on. */
  detail?: ComponentChildren;
  /** Needs another setting: the name and help at 38 %, the note at full strength. */
  disabled?: boolean;
  /** Set by an environment variable: the info glyph on the note, the name at full strength. */
  locked?: boolean;
  /** The row's error, after a save failed: "The settings were not saved. Try again." */
  error?: string;
}

/**
 * One setting (DESIGN.md M-setrow): a name, help, an optional note and the control. It is a
 * `card` container's child, so its layout follows the card: under 25rem the help runs under
 * the name and the control, from 25rem the help keeps out of the control's column, and from
 * 45rem it sits in a third column. A wide control stacks under the help until 45rem. The row
 * never tints: hover, focus and press belong to the control. A named row is a group named
 * by its label, marked `aria-disabled` while it needs another setting.
 * @param props - Component props
 * @param props.label - The setting's name
 * @param props.help - What it does
 * @param props.note - What it needs, or what locks it
 * @param props.control - The control
 * @param props.controlWidth - narrow, wide or action
 * @param props.detail - A dependent control under the row
 * @param props.disabled - Needs another setting
 * @param props.locked - Set by an environment variable
 * @param props.error - The row's error
 * @returns The row
 */
export function SettingsRow({
  label,
  help,
  note,
  control,
  controlWidth = 'narrow',
  detail,
  disabled = false,
  locked = false,
  error,
}: SettingsRowProps): JSX.Element {
  const id = useId();
  const labelId = `${id}-label`;
  const described = [help && `${id}-help`, note && `${id}-note`, error && `${id}-error`]
    .filter(Boolean)
    .join(' ');
  const a11y: SettingsRowControl = { labelId, 'aria-describedby': described || undefined };

  return (
    <div
      class={cx(
        styles.row,
        !label && styles.bare,
        disabled && styles.disabled,
        locked && styles.locked,
      )}
      data-width={controlWidth}
      role={label ? 'group' : undefined}
      aria-labelledby={label ? labelId : undefined}
      aria-disabled={label && disabled ? 'true' : undefined}
    >
      {label && (
        <p id={labelId} class={styles.label}>
          {label}
        </p>
      )}
      <div class={styles.control}>{typeof control === 'function' ? control(a11y) : control}</div>
      {help && (
        <p id={`${id}-help`} class={styles.help}>
          {help}
        </p>
      )}
      {note && (
        <p id={`${id}-note`} class={styles.note}>
          {locked && (
            <span class={styles.glyph}>
              <Icon glyph="info" />
            </span>
          )}
          <span>{note}</span>
        </p>
      )}
      {error && (
        <p id={`${id}-error`} class={styles.error}>
          <span class={styles.glyph}>
            <Icon glyph="danger" />
          </span>
          <span>{error}</span>
        </p>
      )}
      {detail && <div class={styles.detail}>{detail}</div>}
    </div>
  );
}
