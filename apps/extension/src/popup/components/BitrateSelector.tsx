import { useTranslation } from 'react-i18next';
import { getValidBitrates, type AudioCodec, type Bitrate } from '@thaumic-cast/protocol';
import styles from './BitrateSelector.module.css';

interface BitrateSelectorProps {
  codec: AudioCodec;
  value: Bitrate;
  onChange: (bitrate: Bitrate) => void;
  disabled?: boolean;
}

/**
 * Bitrate selection dropdown filtered by codec capabilities.
 * @param props - Component props
 * @param props.codec - Current audio codec
 * @param props.value - Current bitrate value
 * @param props.onChange - Callback when bitrate changes
 * @param props.disabled - Whether the selector is disabled
 * @returns The rendered BitrateSelector component
 */
export function BitrateSelector({ codec, value, onChange, disabled }: BitrateSelectorProps) {
  const { t } = useTranslation();
  const validBitrates = getValidBitrates(codec);

  if (codec === 'wav') {
    return (
      <div className={styles.field}>
        <label className={styles.label}>{t('bitrate')}</label>
        <p className={styles.info}>{t('bitrate_not_applicable')}</p>
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
        disabled={disabled}
      >
        {validBitrates.map((bitrate) => (
          <option key={bitrate} value={bitrate}>
            {bitrate} kbps
          </option>
        ))}
      </select>
    </div>
  );
}
