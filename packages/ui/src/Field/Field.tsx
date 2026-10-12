import type { ComponentChildren, JSX } from 'preact';
import { useId } from 'preact/hooks';
import { Icon } from '../Icon';
import { cx } from '../utils/cx';
import { fieldMessage } from './message';
import styles from './Field.module.css';

/** What a Field hands its control, so the label and the message are tied to it. */
export interface FieldControl {
  /** The control's id, which the Field's `<label for>` points at. */
  id: string;
  /** The message slot's id while it holds something: the error, else the status or help. */
  'aria-describedby'?: string;
}

/** Props for {@link Field}. */
export interface FieldProps {
  /** The field's name, always visible above the control. */
  label: string;
  /** Hide the label visually, when a heading or a term beside it already shows it. */
  hideLabel?: boolean;
  /** One line under the control on what to enter. */
  help?: ComponentChildren;
  /** A result that takes the help's place, such as "Thaumic Cast answered". */
  status?: ComponentChildren;
  /**
   * The error, after blur or submit (P-forms), or a failed request. It replaces the help and
   * the status in the same slot, with the danger glyph. The caller decides `aria-invalid`:
   * a failed request is not a validation error.
   */
  error?: string;
  /** The word that marks an optional field ("Optional"). Required fields are not marked. */
  optional?: string;
  /** The control's id; one is made when omitted. */
  id?: string;
  /** Disabled: the label at 38 %, the help still readable. */
  disabled?: boolean;
  /** The control, given its id and description. */
  children: (control: FieldControl) => ComponentChildren;
}

/**
 * A label, a control and one message slot (DESIGN.md M-field), round a TextInput, a Select
 * or a Slider. The label is always above the control. The slot under it holds the help, a
 * status that replaces the help, or the error, which replaces both and comes first in
 * `aria-describedby`; it keeps its place, so nothing moves when one replaces another
 * (F-shift). The slot is never a live region: focus landing on the control reads it.
 * @param props - Component props
 * @param props.label - The field's name
 * @param props.hideLabel - Hide the label visually
 * @param props.help - The help line
 * @param props.status - A result in the help's place
 * @param props.error - The error
 * @param props.optional - The word that marks an optional field
 * @param props.id - The control's id
 * @param props.disabled - Disabled
 * @param props.children - The control, given its id and description
 * @returns The field
 */
export function Field({
  label,
  hideLabel = false,
  help,
  status,
  error,
  optional,
  id,
  disabled = false,
  children,
}: FieldProps): JSX.Element {
  const ownId = useId();
  const controlId = id ?? ownId;
  const messageId = `${controlId}-message`;
  const message = fieldMessage({ help, status, error });

  return (
    <div class={cx(styles.field, disabled && styles.disabled)}>
      <label for={controlId} class={hideLabel ? 'visually-hidden' : styles.label}>
        {label}
        {optional && <span class={styles.optional}>{optional}</span>}
      </label>
      {children({
        id: controlId,
        'aria-describedby': message ? messageId : undefined,
      })}
      {message && (
        <p
          id={messageId}
          class={cx(styles.message, message === 'error' && styles.error)}
          data-kind={message}
          data-tone={message === 'error' ? 'danger' : undefined}
        >
          {message === 'error' && (
            <span class={styles.glyph}>
              <Icon glyph="danger" />
            </span>
          )}
          <span class={styles.words}>
            {message === 'error' ? error : message === 'status' ? status : help}
          </span>
        </p>
      )}
    </div>
  );
}
