import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useAnnouncer } from '../Announcer';
import { Button } from '../Button';
import { Chip } from '../Chip';
import { Cluster } from '../Cluster';
import { Field } from '../Field';
import { StatusDot } from '../StatusDot';
import { TextInput } from '../TextInput';
import { cx } from '../utils/cx';
import { shownError, type AddressResult } from './state';
import styles from './AddressField.module.css';

export type { AddressResult } from './state';

/** The action's words: at rest, while testing, and after a failed request. */
export interface AddressActionLabels {
  /** "Connect" or "Add speaker". */
  idle: string;
  /** "Connecting…" or "Knocking politely…". Also said by the Announcer. */
  busy: string;
  /** "Try again". */
  failed: string;
}

/** Props for {@link AddressField}. */
export interface AddressFieldProps {
  /**
   * server: a companion's URL, with a result line (StatusDot, words, latency). speaker: a
   * Sonos speaker's IP; on success the address is cleared and becomes the last Chip.
   */
  kind: 'server' | 'speaker';
  /** The field's name: "Server address", "Add a speaker by IP address". */
  label: string;
  /** The typed address. */
  value: string;
  /** Called with the new address as the user types. */
  onChange: (value: string) => void;
  /** The action's words. */
  action: AddressActionLabels;
  /** Tests the address. It resolves with the result; a failure resolves `{ ok: false }`. */
  onTest: (value: string) => Promise<AddressResult>;
  /**
   * Checks the address before any request (P-forms). It returns the message for an address
   * that cannot be right, or nothing when it may be. Shown on blur or on submit.
   */
  validate?: (value: string) => string | undefined;
  /** The help under the line. */
  help?: string;
  /** A hint of the form. */
  placeholder?: string;
  /** Speaker kind: the addresses already added, drawn as Chips above the field. */
  list?: readonly string[];
  /** Speaker kind: the Chips' group name ("Added by IP address"). */
  listLabel?: string;
  /** Speaker kind: names a Chip's remove button ("Remove 192.168.1.47"). */
  removeLabel?: (address: string) => string;
  /** Speaker kind: removes an address. */
  onRemove?: (address: string) => void;
  /** Speaker kind: an address is being removed, so the Chips wait. */
  removing?: boolean;
  /**
   * sm (the default, 32) in settings; md (36 in the popup, 44 in a window) where the field
   * is what its step exists for, as in onboarding (F-size).
   */
  size?: 'sm' | 'md';
  /** Called when the field loses focus (the options page forgets a cleared address). */
  onBlur?: () => void;
  /** Disabled, e.g. while its ChoiceGroup option is not chosen. */
  disabled?: boolean;
  /** The input's id; one is made when omitted. */
  id?: string;
}

/**
 * Types an address, tests it and says what happened (DESIGN.md M-address): one molecule for
 * the popup onboarding, Options › Companion and Desktop Settings › Speakers. One request at
 * a time, and only the Button shows busy; the value stays visible (`readonly`) while it runs.
 * A failed request turns the Button to "Try again" and puts the answer in the message slot,
 * with no `aria-invalid` (the address may be right and the speaker off). An address that
 * cannot be right is invalid (P-forms): a 2 px danger edge and the message, on blur or
 * submit, clearing as soon as it is valid, and no request is made. Enter runs the action.
 * Each outcome is said once by the surface's Announcer; the result line is not a live region.
 * Under 25rem the action goes full width under the field; from 25rem it sits beside it.
 * @param props - Component props
 * @param props.kind - server or speaker
 * @param props.label - The field's name
 * @param props.value - The typed address
 * @param props.onChange - Called with the new address
 * @param props.action - The action's words
 * @param props.onTest - Tests the address
 * @param props.validate - Checks the address before any request
 * @param props.help - The help line
 * @param props.placeholder - A hint of the form
 * @param props.list - Speaker kind: the added addresses
 * @param props.listLabel - Speaker kind: the Chips' group name
 * @param props.removeLabel - Speaker kind: names a Chip's remove button
 * @param props.onRemove - Speaker kind: removes an address
 * @param props.removing - Speaker kind: a removal is in flight
 * @param props.size - sm or md
 * @param props.onBlur - Called when the field loses focus
 * @param props.disabled - Disabled
 * @param props.id - The input's id
 * @returns The field
 */
export function AddressField({
  kind,
  label,
  value,
  onChange,
  action,
  onTest,
  validate,
  help,
  placeholder,
  list,
  listLabel,
  removeLabel,
  onRemove,
  removing = false,
  size = 'sm',
  onBlur,
  disabled = false,
  id,
}: AddressFieldProps): JSX.Element {
  const input = useRef<HTMLInputElement>(null);
  const [testing, setTesting] = useState(false);
  const [touched, setTouched] = useState(false);
  const [result, setResult] = useState<AddressResult | null>(null);
  const { say } = useAnnouncer();
  const live = useRef(true);
  useEffect(
    () => () => {
      live.current = false;
    },
    [],
  );

  const invalid = touched && value.trim() ? validate?.(value.trim()) : undefined;
  const error = shownError(invalid, result);

  const handleInput = (next: string): void => {
    setResult(null);
    onChange(next);
  };

  // Enter in the field and the Button both submit; an invalid address makes no request.
  const check = (event: MouseEvent): void => {
    const address = value.trim();
    if (!address) {
      event.preventDefault();
      return;
    }
    if (validate?.(address)) {
      event.preventDefault();
      setTouched(true);
      input.current?.focus();
    }
  };

  const test = async (): Promise<void> => {
    const address = value.trim();
    setResult(null);
    setTesting(true);
    say(action.busy);
    let outcome: AddressResult;
    try {
      outcome = await onTest(address);
    } finally {
      if (live.current) setTesting(false);
    }
    if (!live.current) return;
    setResult(outcome);
    if (outcome.ok) {
      setTouched(false);
      if (outcome.said) say(outcome.said);
      if (kind === 'speaker') {
        onChange('');
        input.current?.focus();
      }
      return;
    }
    say(outcome.error);
    throw new Error(outcome.error);
  };

  const success = result?.ok && kind === 'server' ? result : null;

  return (
    <form
      class={cx(styles.address, styles[kind])}
      onSubmit={(event) => event.preventDefault()}
      noValidate
    >
      {kind === 'speaker' && list && list.length > 0 && onRemove && (
        <div class={styles.list} role="group" aria-label={listLabel}>
          {listLabel && (
            <p class={styles.listLabel} aria-hidden="true">
              {listLabel}
            </p>
          )}
          <Cluster as="ul" gap="3">
            {list.map((address) => (
              <li key={address}>
                <Chip
                  label={address}
                  mono
                  removeLabel={removeLabel?.(address) ?? address}
                  onRemove={() => onRemove(address)}
                  disabled={removing}
                />
              </li>
            ))}
          </Cluster>
        </div>
      )}
      <Field
        label={label}
        id={id}
        help={help}
        error={error}
        disabled={disabled}
        status={
          success && (
            <span class={styles.result}>
              <StatusDot state="connected" />
              <span>{success.message}</span>
              {success.detail && <span class={cx(styles.detail, 'num')}>{success.detail}</span>}
            </span>
          )
        }
      >
        {(control) => (
          <div class={styles.line}>
            <TextInput
              ref={input}
              {...control}
              kind="address"
              size={size}
              grow={kind === 'speaker'}
              inputMode={kind === 'server' ? 'url' : 'decimal'}
              autoComplete={kind === 'server' ? 'url' : 'off'}
              placeholder={placeholder}
              value={value}
              onInput={handleInput}
              onBlur={() => {
                setTouched(true);
                onBlur?.();
              }}
              readOnly={testing}
              disabled={disabled}
              invalid={!!invalid}
            />
            <Button
              size={size}
              type="submit"
              onClick={check}
              onAction={test}
              labels={{ busy: action.busy, failed: action.failed }}
              resetKey={value}
              disabled={disabled || !value.trim()}
            >
              {action.idle}
            </Button>
          </div>
        )}
      </Field>
    </form>
  );
}
