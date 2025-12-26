import { useTranslation } from 'react-i18next';
import { CODEC_METADATA, type AudioCodec } from '@thaumic-cast/protocol';
import styles from './CodecSelector.module.css';

interface CodecSelectorProps {
  value: AudioCodec;
  onChange: (codec: AudioCodec) => void;
  disabled?: boolean;
  /** Available codecs to show (from runtime detection) */
  availableCodecs?: AudioCodec[];
}

/**
 * Codec selection dropdown with descriptions.
 * Only shows codecs that are available (supported by both browser and Sonos).
 * @param props - Component props
 * @param props.value - Current codec value
 * @param props.onChange - Callback when codec changes
 * @param props.disabled - Whether the selector is disabled
 * @param props.availableCodecs - Available codecs from runtime detection
 * @returns The rendered CodecSelector component
 */
export function CodecSelector({ value, onChange, disabled, availableCodecs }: CodecSelectorProps) {
  const { t } = useTranslation();

  // Use all codecs if none specified, otherwise filter to available ones
  const codecs = availableCodecs ?? (Object.keys(CODEC_METADATA) as AudioCodec[]);

  // If no codecs available, show a message
  if (codecs.length === 0) {
    return (
      <div className={styles.field}>
        <label className={styles.label}>{t('audio_codec')}</label>
        <p className={styles.error}>{t('no_codecs_available')}</p>
      </div>
    );
  }

  return (
    <div className={styles.field}>
      <label className={styles.label}>{t('audio_codec')}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as AudioCodec)}
        className={styles.select}
        disabled={disabled || codecs.length <= 1}
      >
        {codecs.map((codec) => {
          const meta = CODEC_METADATA[codec];
          return (
            <option key={codec} value={codec}>
              {meta.label}
            </option>
          );
        })}
      </select>
      <p className={styles.description}>{CODEC_METADATA[value]?.description}</p>
    </div>
  );
}
