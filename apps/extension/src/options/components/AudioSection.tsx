import type { JSX } from 'preact';
import { useCallback, useMemo } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Card } from '@thaumic-cast/ui';
import type {
  AudioCodec,
  Bitrate,
  SupportedCodecsResult,
  SupportedSampleRate,
} from '@thaumic-cast/protocol';
import {
  CODEC_METADATA,
  getSupportedBitrates,
  getSupportedSampleRates,
} from '@thaumic-cast/protocol';
import type { ExtensionSettings, AudioMode } from '../../lib/settings';
import { getResolvedConfigForDisplay, getDynamicPresets } from '../../lib/presets';
import styles from '../Options.module.css';

interface AudioSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
  codecSupport: SupportedCodecsResult;
  codecLoading: boolean;
}

/**
 * Audio quality settings section.
 * Allows user to select quality mode and custom settings.
 * @param root0
 * @param root0.settings
 * @param root0.onUpdate
 * @param root0.codecSupport
 * @param root0.codecLoading
 * @returns The audio section element
 */
export function AudioSection({
  settings,
  onUpdate,
  codecSupport,
  codecLoading,
}: AudioSectionProps): JSX.Element {
  const { t } = useTranslation();

  // Get resolved config for display
  const resolvedConfig = useMemo(() => {
    if (codecLoading || codecSupport.availableCodecs.length === 0) {
      return null;
    }
    return getResolvedConfigForDisplay(
      settings.audioMode,
      codecSupport,
      settings.customAudioSettings,
    );
  }, [settings.audioMode, settings.customAudioSettings, codecSupport, codecLoading]);

  // Get dynamic presets for showing resolved codec/bitrate per tier
  const dynamicPresets = useMemo(() => {
    if (codecLoading || codecSupport.availableCodecs.length === 0) {
      return null;
    }
    return getDynamicPresets(codecSupport);
  }, [codecSupport, codecLoading]);

  // Mode options with dynamic labels showing what each tier resolves to
  const modeOptions: { value: AudioMode; label: string; desc: string }[] = useMemo(() => {
    const presetLabel = (tier: 'high' | 'mid' | 'low'): string => {
      const option = dynamicPresets?.[tier];
      if (!option) return '';
      return ` (${option.label})`;
    };

    return [
      {
        value: 'high',
        label: t('audio_mode_high') + presetLabel('high'),
        desc: t('audio_mode_high_desc'),
      },
      {
        value: 'mid',
        label: t('audio_mode_mid') + presetLabel('mid'),
        desc: t('audio_mode_mid_desc'),
      },
      {
        value: 'low',
        label: t('audio_mode_low') + presetLabel('low'),
        desc: t('audio_mode_low_desc'),
      },
      { value: 'custom', label: t('audio_mode_custom'), desc: t('audio_mode_custom_desc') },
    ];
  }, [t, dynamicPresets]);

  /**
   * Handles mode change.
   */
  const handleModeChange = useCallback(
    async (mode: AudioMode) => {
      await onUpdate({ audioMode: mode });
    },
    [onUpdate],
  );

  /**
   * Handles custom codec change.
   */
  const handleCodecChange = useCallback(
    async (codec: AudioCodec) => {
      const bitrates = getSupportedBitrates(codec, codecSupport);
      const defaultBitrate = bitrates[0] ?? CODEC_METADATA[codec].defaultBitrate;

      const sampleRates = getSupportedSampleRates(codec, codecSupport);
      const currentSampleRate = settings.customAudioSettings.sampleRate;
      const sampleRate = sampleRates.includes(currentSampleRate)
        ? currentSampleRate
        : (sampleRates[0] ?? 48000);

      await onUpdate({
        customAudioSettings: {
          ...settings.customAudioSettings,
          codec,
          bitrate: defaultBitrate,
          sampleRate,
        },
      });
    },
    [settings.customAudioSettings, codecSupport, onUpdate],
  );

  /**
   * Handles custom bitrate change.
   */
  const handleBitrateChange = useCallback(
    async (bitrate: Bitrate) => {
      await onUpdate({
        customAudioSettings: {
          ...settings.customAudioSettings,
          bitrate,
        },
      });
    },
    [settings.customAudioSettings, onUpdate],
  );

  /**
   * Handles custom channels change.
   */
  const handleChannelsChange = useCallback(
    async (channels: 1 | 2) => {
      await onUpdate({
        customAudioSettings: {
          ...settings.customAudioSettings,
          channels,
        },
      });
    },
    [settings.customAudioSettings, onUpdate],
  );

  /**
   * Handles custom sample rate change.
   */
  const handleSampleRateChange = useCallback(
    async (sampleRate: SupportedSampleRate) => {
      await onUpdate({
        customAudioSettings: {
          ...settings.customAudioSettings,
          sampleRate,
        },
      });
    },
    [settings.customAudioSettings, onUpdate],
  );

  // Get available bitrates for current codec
  const availableBitrates = useMemo(() => {
    if (codecLoading) return [];
    return getSupportedBitrates(settings.customAudioSettings.codec, codecSupport);
  }, [settings.customAudioSettings.codec, codecSupport, codecLoading]);

  // Get available sample rates for current codec
  const availableSampleRates = useMemo(() => {
    if (codecLoading) return [];
    return getSupportedSampleRates(settings.customAudioSettings.codec, codecSupport);
  }, [settings.customAudioSettings.codec, codecSupport, codecLoading]);

  const isCustomMode = settings.audioMode === 'custom';

  return (
    <Card title={t('audio_section_title')}>
      <div className={styles.cardContent}>
        {/* Loading state */}
        {codecLoading && <div className={styles.hint}>{t('audio_detecting_codecs')}</div>}

        {/* No codecs detected */}
        {!codecLoading && codecSupport.availableCodecs.length === 0 && (
          <div className={styles.hint} style={{ color: 'var(--color-error)' }}>
            {t('audio_no_codecs_detected')}
          </div>
        )}

        {/* Mode selection */}
        {!codecLoading && codecSupport.availableCodecs.length > 0 && (
          <>
            <div className={styles.field}>
              <span id="audio-mode-label" className={styles.label}>
                {t('audio_mode')}
              </span>
              <div
                className={styles.radioGroup}
                role="radiogroup"
                aria-labelledby="audio-mode-label"
              >
                {modeOptions.map((option) => (
                  <label key={option.value} className={styles.radioOption}>
                    <input
                      type="radio"
                      name="audioMode"
                      className={styles.radioInput}
                      checked={settings.audioMode === option.value}
                      onChange={() => handleModeChange(option.value)}
                    />
                    <div className={styles.radioContent}>
                      <span className={styles.radioLabel}>{option.label}</span>
                      <span className={styles.radioDesc}>{option.desc}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>

            <div className={styles.divider} />

            {/* Resolved/Custom settings */}
            <div className={styles.field}>
              <label className={styles.label}>
                {isCustomMode ? t('audio_settings') : t('audio_resolved_settings')}
              </label>

              {isCustomMode ? (
                /* Custom mode: editable settings */
                <div className={styles.cardContent}>
                  {/* Codec */}
                  <div className={styles.field}>
                    <label htmlFor="audio-codec" className={styles.label}>
                      {t('audio_codec')}
                    </label>
                    <select
                      id="audio-codec"
                      className={styles.select}
                      value={settings.customAudioSettings.codec}
                      onChange={(e) =>
                        handleCodecChange((e.target as HTMLSelectElement).value as AudioCodec)
                      }
                    >
                      {codecSupport.availableCodecs.map((codec) => (
                        <option key={codec} value={codec}>
                          {CODEC_METADATA[codec].label}
                        </option>
                      ))}
                    </select>
                  </div>

                  {/* Bitrate - only show if codec has bitrate options */}
                  {availableBitrates.length > 0 && (
                    <div className={styles.field}>
                      <label htmlFor="audio-bitrate" className={styles.label}>
                        {t('audio_bitrate')}
                      </label>
                      <select
                        id="audio-bitrate"
                        className={styles.select}
                        value={settings.customAudioSettings.bitrate}
                        onChange={(e) =>
                          handleBitrateChange(
                            Number((e.target as HTMLSelectElement).value) as Bitrate,
                          )
                        }
                      >
                        {availableBitrates.map((bitrate) => (
                          <option key={bitrate} value={bitrate}>
                            {bitrate} kbps
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Channels */}
                  <div className={styles.field}>
                    <label htmlFor="audio-channels" className={styles.label}>
                      {t('audio_channels')}
                    </label>
                    <select
                      id="audio-channels"
                      className={styles.select}
                      value={settings.customAudioSettings.channels}
                      onChange={(e) =>
                        handleChannelsChange(Number((e.target as HTMLSelectElement).value) as 1 | 2)
                      }
                    >
                      <option value={2}>{t('audio_channels_stereo')}</option>
                      <option value={1}>{t('audio_channels_mono')}</option>
                    </select>
                  </div>

                  {/* Sample Rate - only show if codec supports multiple rates */}
                  {availableSampleRates.length > 0 && (
                    <div className={styles.field}>
                      <label htmlFor="audio-sample-rate" className={styles.label}>
                        {t('audio_sample_rate')}
                      </label>
                      <select
                        id="audio-sample-rate"
                        className={styles.select}
                        value={settings.customAudioSettings.sampleRate}
                        onChange={(e) =>
                          handleSampleRateChange(
                            Number((e.target as HTMLSelectElement).value) as SupportedSampleRate,
                          )
                        }
                      >
                        {availableSampleRates.map((rate) => (
                          <option key={rate} value={rate}>
                            {rate / 1000} kHz
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                </div>
              ) : (
                /* Non-custom mode: read-only display */
                resolvedConfig && (
                  <div className={styles.resolvedSettings}>
                    <div className={styles.resolvedRow}>
                      <span className={styles.resolvedLabel}>{t('audio_codec')}</span>
                      <span className={styles.resolvedValue}>
                        {CODEC_METADATA[resolvedConfig.codec].label}
                      </span>
                    </div>
                    <div className={styles.resolvedRow}>
                      <span className={styles.resolvedLabel}>{t('audio_bitrate')}</span>
                      <span className={styles.resolvedValue}>
                        {resolvedConfig.bitrate === 0
                          ? t('lossless')
                          : `${resolvedConfig.bitrate} kbps`}
                      </span>
                    </div>
                    <div className={styles.resolvedRow}>
                      <span className={styles.resolvedLabel}>{t('audio_channels')}</span>
                      <span className={styles.resolvedValue}>
                        {resolvedConfig.channels === 2
                          ? t('audio_channels_stereo')
                          : t('audio_channels_mono')}
                      </span>
                    </div>
                    <div className={styles.resolvedRow}>
                      <span className={styles.resolvedLabel}>{t('audio_sample_rate')}</span>
                      <span className={styles.resolvedValue}>
                        {resolvedConfig.sampleRate / 1000} kHz
                      </span>
                    </div>
                  </div>
                )
              )}
            </div>
          </>
        )}
      </div>
    </Card>
  );
}
