import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { Alert, Card, Disclosure } from '@thaumic-cast/ui';
import type {
  AudioCodec,
  BitDepth,
  Bitrate,
  FrameDurationMs,
  LatencyMode,
  PcmSmoothingMs,
  SupportedCodecsResult,
  SupportedSampleRate,
} from '@thaumic-cast/protocol';
import {
  CODEC_METADATA,
  FRAME_DURATIONS,
  FRAME_DURATION_MS_DEFAULT,
  PCM_SMOOTHING_DEFAULT_MS,
  PCM_SMOOTHING_OPTIONS,
  getPreferredBitrate,
  getSupportedBitrates,
  getSupportedSampleRates,
  getSupportedBitDepths,
  isValidBitDepthForCodec,
} from '@thaumic-cast/protocol';
import type { ExtensionSettings, AudioMode } from '../../lib/settings';
import { getDynamicPresets } from '../../lib/presets';
import { resolveAudio, type CompanionCapability } from '../../lib/audio-resolver';
import { pcmAudioRows, type PcmRowsContext } from '../../lib/pcm-audio-rows';
import { useCombinationSupport } from '../hooks/useCombinationSupport';
import styles from '../Options.module.css';

/** Fragment the popup links to so the advanced options open in view. */
const ADVANCED_HASH = '#audio-advanced';

interface AudioSectionProps {
  settings: ExtensionSettings;
  onUpdate: (partial: Partial<ExtensionSettings>) => Promise<void>;
  codecSupport: SupportedCodecsResult;
  codecLoading: boolean;
  /** The companion's speaker-side settings and type, for the head start rows. */
  companion: PcmRowsContext;
  /** What the connected companion can do, passed to the resolver as a cast passes it. */
  capability: CompanionCapability;
}

/**
 * Audio quality settings section.
 * Allows user to select quality mode and custom settings. Which controls show
 * comes from the same resolver the cast uses: smoothing for any PCM cast, frame
 * size for a PCM tab cast, bit depth where the codec offers a choice. For PCM
 * the summary shows the speaker head start the companion adds and the delay
 * the two add together.
 * @param root0
 * @param root0.settings
 * @param root0.onUpdate
 * @param root0.codecSupport
 * @param root0.codecLoading
 * @param root0.companion
 * @param root0.capability
 * @returns The audio section element
 */
export function AudioSection({
  settings,
  onUpdate,
  codecSupport,
  codecLoading,
  companion,
  capability,
}: AudioSectionProps): JSX.Element {
  const { t } = useTranslation();
  const [advancedOpen, setAdvancedOpen] = useState(() => location.hash === ADVANCED_HASH);
  const advancedRef = useRef<HTMLDivElement>(null);

  // Resolve the settings exactly as a cast would
  const resolved = useMemo(() => {
    if (codecLoading || codecSupport.availableCodecs.length === 0) {
      return null;
    }
    try {
      return resolveAudio(
        {
          audioMode: settings.audioMode,
          customAudioSettings: settings.customAudioSettings,
          pcmSmoothingMs: settings.pcmSmoothingMs,
          pcmFrameDurationMs: settings.pcmFrameDurationMs,
          captureMode: settings.captureMode,
        },
        codecSupport,
        capability,
      );
    } catch {
      return null;
    }
  }, [
    settings.audioMode,
    settings.customAudioSettings,
    settings.pcmSmoothingMs,
    settings.pcmFrameDurationMs,
    settings.captureMode,
    codecSupport,
    codecLoading,
    capability,
  ]);

  // The summary describes the Quality choice, which is what a tab cast sends.
  const resolvedConfig = resolved?.tabConfig ?? null;
  const isPcm = resolvedConfig?.codec === 'pcm';
  const showSmoothing = resolved?.controls.smoothing ?? false;
  const showFrameSize = resolved?.controls.frameSize ?? false;
  const showBitDepth = resolved?.controls.bitDepth ?? false;

  // Ask the browser about the exact combination a tab cast would encode.
  const combinationSupported = useCombinationSupport(resolvedConfig);

  // Opened from the popup's smoothing advice: expand Advanced and bring it
  // into view once it exists (it waits for codec detection).
  useEffect(() => {
    /** Expands and scrolls to Advanced when the fragment asks for it. */
    const reveal = (): void => {
      if (location.hash !== ADVANCED_HASH) return;
      setAdvancedOpen(true);
      advancedRef.current?.scrollIntoView({ block: 'start' });
    };
    if (showSmoothing) reveal();
    window.addEventListener('hashchange', reveal);
    return () => window.removeEventListener('hashchange', reveal);
  }, [showSmoothing]);

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
      const defaultBitrate = getPreferredBitrate(codec, codecSupport);

      const sampleRates = getSupportedSampleRates(codec, codecSupport);
      const currentSampleRate = settings.customAudioSettings.sampleRate;
      const sampleRate = sampleRates.includes(currentSampleRate)
        ? currentSampleRate
        : (sampleRates[0] ?? 48000);

      // Reset bit depth to 16 if current bit depth is not supported by new codec
      const currentBitDepth = settings.customAudioSettings.bitsPerSample;
      const bitsPerSample = isValidBitDepthForCodec(codec, currentBitDepth) ? currentBitDepth : 16;

      await onUpdate({
        customAudioSettings: {
          ...settings.customAudioSettings,
          codec,
          bitrate: defaultBitrate,
          sampleRate,
          bitsPerSample,
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

  /**
   * Handles custom latency mode change.
   */
  const handleLatencyModeChange = useCallback(
    async (latencyMode: LatencyMode) => {
      await onUpdate({
        customAudioSettings: {
          ...settings.customAudioSettings,
          latencyMode,
        },
      });
    },
    [settings.customAudioSettings, onUpdate],
  );

  /**
   * Handles smoothing change (PCM, every mode).
   */
  const handleSmoothingChange = useCallback(
    async (pcmSmoothingMs: PcmSmoothingMs) => {
      await onUpdate({ pcmSmoothingMs });
    },
    [onUpdate],
  );

  /**
   * Dismisses the one-time line saying the migration changed smoothing.
   */
  const handleDismissMigration = useCallback(async () => {
    await onUpdate({ smoothingMigrationNotice: null });
  }, [onUpdate]);

  /**
   * Handles bit depth change.
   */
  const handleBitDepthChange = useCallback(
    async (bitsPerSample: BitDepth) => {
      await onUpdate({
        customAudioSettings: {
          ...settings.customAudioSettings,
          bitsPerSample,
        },
      });
    },
    [settings.customAudioSettings, onUpdate],
  );

  /**
   * Handles frame size change (PCM, every mode).
   */
  const handleFrameDurationChange = useCallback(
    async (pcmFrameDurationMs: FrameDurationMs) => {
      await onUpdate({ pcmFrameDurationMs });
    },
    [onUpdate],
  );

  /**
   * Labels an option in ms, marking the default.
   * @param value - The option, in ms
   * @param defaultValue - The default option, in ms
   * @returns The option label
   */
  const optionLabel = useCallback(
    (value: number, defaultValue: number): string => {
      const ms = t('audio_option_ms', { value });
      return value === defaultValue ? t('audio_option_default', { value: ms }) : ms;
    },
    [t],
  );

  // Get available bitrates for current codec (excluding 0 = lossless)
  const availableBitrates = useMemo(() => {
    if (codecLoading) return [];
    return getSupportedBitrates(settings.customAudioSettings.codec, codecSupport).filter(
      (b) => b !== 0,
    );
  }, [settings.customAudioSettings.codec, codecSupport, codecLoading]);

  // Get available sample rates for current codec
  const availableSampleRates = useMemo(() => {
    if (codecLoading) return [];
    return getSupportedSampleRates(settings.customAudioSettings.codec, codecSupport);
  }, [settings.customAudioSettings.codec, codecSupport, codecLoading]);

  const isCustomMode = settings.audioMode === 'custom';

  // PCM rows: sample rate follows capture, then smoothing, head start and delay.
  const pcmRows = useMemo(() => {
    if (!isPcm || !resolvedConfig) return [];
    return pcmAudioRows(resolvedConfig.jitterBufferMs, companion).map((row) => ({
      key: row.key,
      label: t(row.labelKey),
      value: t(row.value.key, row.value.params),
    }));
  }, [isPcm, resolvedConfig, companion, t]);

  const resolvedRows = useMemo(() => {
    if (!resolvedConfig) return [];
    const rows: { key: string; label: string; value: string }[] = [
      {
        key: 'codec',
        label: t('audio_codec'),
        value: CODEC_METADATA[resolvedConfig.codec].label,
      },
      {
        key: 'bitrate',
        label: t('audio_bitrate'),
        value: resolvedConfig.bitrate === 0 ? t('lossless') : `${resolvedConfig.bitrate} kbps`,
      },
      {
        key: 'channels',
        label: t('audio_channels'),
        value:
          resolvedConfig.channels === 2 ? t('audio_channels_stereo') : t('audio_channels_mono'),
      },
    ];

    if (!isPcm) {
      rows.push({
        key: 'sample-rate',
        label: t('audio_sample_rate'),
        value: `${resolvedConfig.sampleRate / 1000} kHz`,
      });
    }

    if (CODEC_METADATA[resolvedConfig.codec].webCodecsId !== null) {
      rows.push({
        key: 'latency-mode',
        label: t('audio_latency_mode'),
        value:
          resolvedConfig.latencyMode === 'quality'
            ? t('audio_latency_quality')
            : t('audio_latency_realtime'),
      });
    }

    rows.push({
      key: 'bit-depth',
      label: t('audio_bit_depth'),
      value:
        resolvedConfig.bitsPerSample === 24 ? t('audio_bit_depth_24') : t('audio_bit_depth_16'),
    });

    return [...rows, ...pcmRows];
  }, [resolvedConfig, isPcm, pcmRows, t]);

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

            {/* Browser-wide capture decides the format, so say the choice above waits */}
            {resolved?.formatForced && (
              <Alert variant="info">{t('audio_browser_capture_note')}</Alert>
            )}

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

                  {/* Sample Rate - PCM follows the capture device, so only for compressed codecs */}
                  {settings.customAudioSettings.codec !== 'pcm' &&
                    availableSampleRates.length > 0 && (
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

                  {/* Latency Mode - only show for codecs that use WebCodecs encoding */}
                  {CODEC_METADATA[settings.customAudioSettings.codec].webCodecsId !== null && (
                    <div className={styles.field}>
                      <label htmlFor="audio-latency-mode" className={styles.label}>
                        {t('audio_latency_mode')}
                      </label>
                      <select
                        id="audio-latency-mode"
                        className={styles.select}
                        value={settings.customAudioSettings.latencyMode}
                        onChange={(e) =>
                          handleLatencyModeChange(
                            (e.target as HTMLSelectElement).value as LatencyMode,
                          )
                        }
                      >
                        <option value="quality">{t('audio_latency_quality')}</option>
                        <option value="realtime">{t('audio_latency_realtime')}</option>
                      </select>
                    </div>
                  )}

                  {/* Bit Depth - only where the codec offers a choice */}
                  {showBitDepth && (
                    <div className={styles.field}>
                      <label htmlFor="audio-bit-depth" className={styles.label}>
                        {t('audio_bit_depth')}
                      </label>
                      <select
                        id="audio-bit-depth"
                        className={styles.select}
                        value={settings.customAudioSettings.bitsPerSample}
                        onChange={(e) =>
                          handleBitDepthChange(
                            Number((e.target as HTMLSelectElement).value) as BitDepth,
                          )
                        }
                      >
                        {getSupportedBitDepths(settings.customAudioSettings.codec).map((depth) => (
                          <option key={depth} value={depth}>
                            {depth === 16 ? t('audio_bit_depth_16') : t('audio_bit_depth_24')}
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* PCM summary: sample rate, smoothing, head start, added delay */}
                  {pcmRows.length > 0 && (
                    <div className={styles.resolvedSettings}>
                      {pcmRows.map((row) => (
                        <div key={row.key} className={styles.resolvedRow}>
                          <span className={styles.resolvedLabel}>{row.label}</span>
                          <span className={styles.resolvedValue}>{row.value}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                /* Non-custom mode: read-only display */
                resolvedConfig && (
                  <div className={styles.resolvedSettings}>
                    {resolvedRows.map((row) => (
                      <div key={row.key} className={styles.resolvedRow}>
                        <span className={styles.resolvedLabel}>{row.label}</span>
                        <span className={styles.resolvedValue}>{row.value}</span>
                      </div>
                    ))}
                  </div>
                )
              )}
            </div>

            {isPcm && (
              <span className={styles.hint}>{t('audio_sample_rate_follows_capture_hint')}</span>
            )}

            {/* The browser refuses this exact combination: say so before cast time */}
            {combinationSupported === false && (
              <Alert variant="warning">
                {isCustomMode
                  ? t('audio_combination_unsupported_custom')
                  : t('audio_combination_unsupported_preset')}
              </Alert>
            )}

            {showSmoothing && settings.smoothingMigrationNotice && (
              <Alert variant="info" onDismiss={handleDismissMigration} dismissLabel={t('dismiss')}>
                {t('audio_smoothing_migrated', settings.smoothingMigrationNotice)}
              </Alert>
            )}

            {/* Advanced: smoothing for any PCM cast, frame size for a PCM tab cast */}
            {showSmoothing && (
              <div id="audio-advanced" ref={advancedRef} className={styles.advancedAnchor}>
                <Disclosure
                  label={t('audio_advanced')}
                  expanded={advancedOpen}
                  onExpandedChange={setAdvancedOpen}
                >
                  <div className={styles.cardContent}>
                    <div className={styles.field}>
                      <label htmlFor="audio-smoothing" className={styles.label}>
                        {t('audio_smoothing')}
                      </label>
                      <select
                        id="audio-smoothing"
                        className={styles.select}
                        value={settings.pcmSmoothingMs}
                        onChange={(e) =>
                          handleSmoothingChange(
                            Number((e.target as HTMLSelectElement).value) as PcmSmoothingMs,
                          )
                        }
                      >
                        {PCM_SMOOTHING_OPTIONS.map((ms) => (
                          <option key={ms} value={ms}>
                            {optionLabel(ms, PCM_SMOOTHING_DEFAULT_MS)}
                          </option>
                        ))}
                      </select>
                      <span className={styles.hint}>{t('audio_smoothing_hint')}</span>
                    </div>

                    {showFrameSize && (
                      <div className={styles.field}>
                        <label htmlFor="audio-frame-size" className={styles.label}>
                          {t('audio_frame_size')}
                        </label>
                        <select
                          id="audio-frame-size"
                          className={styles.select}
                          value={settings.pcmFrameDurationMs}
                          onChange={(e) =>
                            handleFrameDurationChange(
                              Number((e.target as HTMLSelectElement).value) as FrameDurationMs,
                            )
                          }
                        >
                          {FRAME_DURATIONS.map((ms) => (
                            <option key={ms} value={ms}>
                              {optionLabel(ms, FRAME_DURATION_MS_DEFAULT)}
                            </option>
                          ))}
                        </select>
                        <span className={styles.hint}>{t('audio_frame_size_hint')}</span>
                      </div>
                    )}
                  </div>
                </Disclosure>
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
