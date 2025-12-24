import { useTranslation } from 'react-i18next';
import { CODEC_METADATA, type AudioCodec } from '@thaumic-cast/protocol';
import styles from './CodecSelector.module.css';

interface CodecSelectorProps {
  value: AudioCodec;
  onChange: (codec: AudioCodec) => void;
  disabled?: boolean;
}

const CODEC_ORDER: AudioCodec[] = ['aac-lc', 'he-aac', 'mp3', 'wav'];

/**
 * Codec selection dropdown with descriptions.
 * @param props - Component props
 * @param props.value - Current codec value
 * @param props.onChange - Callback when codec changes
 * @param props.disabled - Whether the selector is disabled
 * @returns The rendered CodecSelector component
 */
export function CodecSelector({ value, onChange, disabled }: CodecSelectorProps) {
  const { t } = useTranslation();

  return (
    <div className={styles.field}>
      <label className={styles.label}>{t('audio_codec')}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as AudioCodec)}
        className={styles.select}
        disabled={disabled}
      >
        {CODEC_ORDER.map((codec) => {
          const meta = CODEC_METADATA[codec];
          return (
            <option key={codec} value={codec}>
              {meta.label}
            </option>
          );
        })}
      </select>
      <p className={styles.description}>{CODEC_METADATA[value].description}</p>
    </div>
  );
}
