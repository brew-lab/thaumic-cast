import type { JSX, Ref } from 'preact';
import { forwardRef } from 'preact/compat';
import { useId, useRef } from 'preact/hooks';
import { Icon } from '../Icon';
import { IconButton } from '../IconButton';
import { cx, dataAttributes, type DataAttributes } from '../utils/cx';
import styles from './TextInput.module.css';

/** Props for {@link TextInput}. */
export interface TextInputProps extends DataAttributes {
  /**
   * text: the plain field; address: machine text (`.mono`, left to right, no spellcheck);
   * search: a leading glyph, a Clear button while it has a value, Esc clears, and a
   * visually hidden label.
   */
  kind?: 'text' | 'address' | 'search';
  /** The value. */
  value: string;
  /** Called with the new value as the user types. */
  onInput: (value: string) => void;
  /** The density sets the height: sm `--control-sm`, md `--control-md`. Search defaults to sm. */
  size?: 'sm' | 'md';
  /** A hint of the form; never the label. */
  placeholder?: string;
  /** Read-only: selectable and focusable, on the container fill. */
  readOnly?: boolean;
  /** Disabled. */
  disabled?: boolean;
  /** Invalid, after blur or submit (P-forms): a 2 px danger edge and `aria-invalid`. */
  invalid?: boolean;
  /** The keyboard: `url` for a server address, `decimal` for an IP. */
  inputMode?: 'url' | 'decimal';
  /** Search: clears the field (Esc and the Clear button). */
  onClear?: () => void;
  /** Search: the Clear button's name ("Clear search"). */
  clearLabel?: string;
  /** Search: the visually hidden label ("Find a room"). Other kinds take a `<label for>`. */
  label?: string;
  /** The id a `<label for>` points at. */
  id?: string;
  /** The form field name. */
  name?: string;
  /** Autofill hint. */
  autoComplete?: string;
  /** An accessible name, when no visible label points at the field. */
  'aria-label'?: string;
  /** The error first, then the help (Field does this in Phase 2). */
  'aria-describedby'?: string;
  /** Called when the field loses focus. */
  onBlur?: (event: FocusEvent) => void;
  /** Called when the field gains focus. */
  onFocus?: (event: FocusEvent) => void;
  /** Keyboard handling, e.g. Enter to submit. */
  onKeyDown?: (event: KeyboardEvent) => void;
}

/**
 * The one typed control (DESIGN.md A-text). It absorbs Input, the raw URL input, FindField
 * and the number and IP inputs. The edge belongs to the control, not the `<input>`, so the
 * glyph and the Clear button sit inside one outline. It never reshapes: hover darkens the
 * edge, focus is a 2 px primary edge plus the ring, invalid a 2 px danger edge.
 * @param props - Component props
 * @param props.kind - text, address or search
 * @param props.value - The value
 * @param props.onInput - Called with the new value
 * @param props.size - sm or md
 * @param props.placeholder - A hint of the form
 * @param props.readOnly - Read-only
 * @param props.disabled - Disabled
 * @param props.invalid - Invalid
 * @param props.inputMode - The keyboard
 * @param props.onClear - Search: clears the field
 * @param props.clearLabel - Search: the Clear button's name
 * @param props.label - Search: the hidden label
 * @param ref - The `<input>`
 * @returns The field
 */
export const TextInput = forwardRef<HTMLInputElement, TextInputProps>(function TextInput(
  {
    kind = 'text',
    value,
    onInput,
    size,
    placeholder,
    readOnly = false,
    disabled = false,
    invalid = false,
    inputMode,
    onClear,
    clearLabel,
    label,
    id,
    name,
    autoComplete,
    onBlur,
    onFocus,
    onKeyDown,
    ...rest
  }: TextInputProps,
  ref: Ref<HTMLInputElement>,
): JSX.Element {
  const ownId = useId();
  const inputId = id ?? ownId;
  const inner = useRef<HTMLInputElement | null>(null);
  const search = kind === 'search';
  const address = kind === 'address';
  const clear = (): void => {
    onInput('');
    onClear?.();
    inner.current?.focus();
  };

  const setRefs = (el: HTMLInputElement | null): void => {
    inner.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };

  return (
    <span
      class={cx(
        styles.control,
        styles[size ?? (search ? 'sm' : 'md')],
        readOnly && styles.readOnly,
        disabled && styles.disabled,
        invalid && styles.invalid,
      )}
      {...dataAttributes(rest)}
    >
      {search && label && (
        <label for={inputId} class="visually-hidden">
          {label}
        </label>
      )}
      {search && (
        <span class={styles.lead}>
          <Icon glyph="search" />
        </span>
      )}
      <input
        ref={setRefs}
        id={inputId}
        name={name}
        class={cx(styles.input, address && 'mono')}
        type={search ? 'search' : 'text'}
        value={value}
        placeholder={placeholder}
        readOnly={readOnly}
        disabled={disabled}
        inputMode={inputMode}
        dir={address ? 'ltr' : undefined}
        spellcheck={address ? false : undefined}
        autoCapitalize={address ? 'off' : undefined}
        autoComplete={autoComplete ?? (address ? 'off' : undefined)}
        aria-invalid={invalid ? 'true' : undefined}
        aria-label={rest['aria-label']}
        aria-describedby={rest['aria-describedby']}
        onInput={(event) => onInput((event.currentTarget as HTMLInputElement).value)}
        onBlur={onBlur}
        onFocus={onFocus}
        onKeyDown={(event) => {
          if (search && event.key === 'Escape' && value) {
            event.preventDefault();
            clear();
          }
          onKeyDown?.(event);
        }}
      />
      {search && value && clearLabel && (
        <span class={styles.trail}>
          <IconButton glyph="x" label={clearLabel} size="sm" onPress={clear} />
        </span>
      )}
    </span>
  );
});
