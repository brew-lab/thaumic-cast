import { useState, useRef } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Button, TextInput } from '@thaumic-cast/ui';
import { useAddManualSpeaker, getSpeakerErrorMessage } from '../hooks/useAddManualSpeaker';
import styles from './ManualSpeakerForm.module.css';

interface ManualSpeakerFormProps {
  /** Button variant */
  buttonVariant?: 'primary' | 'secondary';
  /** Optional id for the input element (for label association) */
  inputId?: string;
  /** Callback when speaker is successfully added */
  onSuccess?: (ip: string) => void;
}

/**
 * Form for manually adding a Sonos speaker by IP address.
 *
 * Handles input, validation, probing, and error display.
 *
 * @param props - Component props
 * @param props.buttonVariant - Button style variant
 * @param props.inputId - Optional id for the input element
 * @param props.onSuccess - Callback when speaker is successfully added
 * @returns The rendered ManualSpeakerForm component
 */
export function ManualSpeakerForm({
  buttonVariant = 'primary',
  inputId,
  onSuccess,
}: ManualSpeakerFormProps): preact.JSX.Element {
  const { t } = useTranslation();
  const [ipInput, setIpInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const { isTesting, error, addSpeaker, clearError } = useAddManualSpeaker({
    onSuccess: (ip) => {
      setIpInput('');
      // Keep focus on input for adding more speakers
      inputRef.current?.focus();
      onSuccess?.(ip);
    },
  });

  const handleInputChange = (value: string) => {
    setIpInput(value);
    if (error) clearError();
  };

  const handleSubmit = async () => {
    await addSpeaker(ipInput);
  };

  return (
    <>
      <div className={styles.form}>
        <div className={styles.input}>
          <TextInput
            ref={inputRef}
            id={inputId}
            kind="address"
            inputMode="decimal"
            value={ipInput}
            onInput={handleInputChange}
            onKeyDown={(e) => e.key === 'Enter' && !isTesting && ipInput.trim() && handleSubmit()}
            placeholder={t('onboarding.speakers.manual_ip_placeholder')}
            aria-label={inputId ? undefined : t('onboarding.speakers.manual_toggle')}
            invalid={!!error}
            readOnly={isTesting}
          />
        </div>
        <Button
          kind={buttonVariant === 'primary' ? 'filled' : 'tonal'}
          onAction={handleSubmit}
          labels={{ busy: t('onboarding.speakers.manual_testing') }}
          disabled={!ipInput.trim()}
        >
          {t('onboarding.speakers.manual_add')}
        </Button>
      </div>
      {error && <div className={styles.error}>{getSpeakerErrorMessage(error, t)}</div>}
    </>
  );
}
