import { useTranslation } from 'react-i18next';
import { getValidBitrates, type AudioCodec, type Bitrate } from '@thaumic-cast/protocol';
import styles from './BitrateSelector.module.css';

interface BitrateSelectorProps {
  codec: AudioCodec;
  value: Bitrate;
  onChange: (bitrate: Bitrate) => void;
  disabled?: boolean;
  /** Available bitrates from runtime detection (optional override) */
  availableBitrates?: Bitrate[];
}

/**
 * Bitrate selection dropdown filtered by codec capabilities.
 * @param props - Component props
 * @param props.codec - Current audio codec
 * @param props.value - Current bitrate value
 * @param props.onChange - Callback when bitrate changes
 * @param props.disabled - Whether the selector is disabled
 * @param props.availableBitrates - Available bitrates from runtime detection
 * @returns The rendered BitrateSelector component
 */
export function BitrateSelector({
  codec,
  value,
  onChange,
  disabled,
  availableBitrates,
}: BitrateSelectorProps) {
  const { t } = useTranslation();

  // Use provided available bitrates or fall back to valid bitrates for codec
  const bitrates = availableBitrates ?? getValidBitrates(codec);

  if (bitrates.length === 0) {
    return (
      <div className={styles.field}>
        <label className={styles.label}>{t('bitrate')}</label>
        <p className={styles.info}>{t('no_bitrates_available')}</p>
      </div>
    );
  }

  return (
    <div className={styles.field}>
      <label className={styles.label}>{t('bitrate')}</label>
      <select
        value={value}
        onChange={(e) => onChange(Number(e.currentTarget.value) as Bitrate)}
        className={styles.select}
        disabled={disabled || bitrates.length <= 1}
      >
        {bitrates.map((bitrate) => (
          <option key={bitrate} value={bitrate}>
            {bitrate === 0 ? t('lossless') : `${bitrate} kbps`}
          </option>
        ))}
      </select>
    </div>
  );
}
