import type { JSX } from 'preact';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import {
  Card,
  ChoiceGroup,
  DescriptionList,
  Disclosure,
  Divider,
  Notice,
  Select,
  SettingsRow,
} from '@thaumic-cast/ui';
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
 * size for a PCM tab cast, bit depth where the codec offers a choice, and the
 * fall-behind choice in the one place the resolver names for it. For PCM
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
  const fallBehindPlacement = resolved?.controls.fallBehind ?? null;

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

    // The preset decides this for every codec, PCM included: the relay obeys it too.
    rows.push({
      key: 'latency-mode',
      label: t('audio_latency_mode'),
      value:
        resolvedConfig.latencyMode === 'quality'
          ? t('audio_latency_quality')
          : t('audio_latency_realtime'),
    });

    rows.push({
      key: 'bit-depth',
      label: t('audio_bit_depth'),
      value:
        resolvedConfig.bitsPerSample === 24 ? t('audio_bit_depth_24') : t('audio_bit_depth_16'),
    });

    return [...rows, ...pcmRows];
  }, [resolvedConfig, isPcm, pcmRows, t]);

  // The fall-behind choice, placed once: the resolver says where. Its Select is wider than
  // the wide-control cut-off, so it stacks under the help until the card is wide.
  const fallBehindRow = (
    <SettingsRow
      label={t('audio_latency_mode')}
      controlWidth="wide"
      help={t('audio_latency_mode_hint')}
      control={(a11y) => (
        <Select
          id="audio-latency-mode"
          label={t('audio_latency_mode')}
          hideLabel
          value={settings.customAudioSettings.latencyMode}
          options={[
            { value: 'quality', label: t('audio_latency_quality') },
            { value: 'realtime', label: t('audio_latency_realtime') },
          ]}
          onChange={(mode) => handleLatencyModeChange(mode as LatencyMode)}
          aria-describedby={a11y['aria-describedby']}
        />
      )}
    />
  );

  /**
   * One narrow Select row of the Bespoke settings: the row shows the name.
   * @param props - The row
   * @param props.label - The setting's name
   * @param props.help - What it does
   * @param props.select - The Select, given the row's description
   * @returns The row
   */
  const selectRow = ({
    label,
    help,
    select,
  }: {
    label: string;
    help?: string;
    select: (describedBy?: string) => JSX.Element;
  }): JSX.Element => (
    <SettingsRow label={label} help={help} control={(a11y) => select(a11y['aria-describedby'])} />
  );

  return (
    <Card title={t('audio_section_title')}>
      {/* Loading state */}
      {codecLoading && <p className={styles.hint}>{t('audio_detecting_codecs')}</p>}

      {/* No codecs detected */}
      {!codecLoading && codecSupport.availableCodecs.length === 0 && (
        <Notice tone="danger" text={t('audio_no_codecs_detected')} />
      )}

      {/* Mode selection */}
      {!codecLoading && codecSupport.availableCodecs.length > 0 && (
        <>
          <ChoiceGroup
            legend={t('audio_mode')}
            name="audioMode"
            value={settings.audioMode}
            onChange={handleModeChange}
            options={modeOptions.map((option) => ({
              value: option.value,
              label: option.label,
              description: option.desc,
            }))}
          />

          {/* Browser-wide capture decides the format, so say the choice above waits */}
          {resolved?.formatForced && <Notice tone="info" text={t('audio_browser_capture_note')} />}

          <Divider />

          {/* Resolved/Custom settings */}
          <p className={styles.label}>
            {isCustomMode ? t('audio_settings') : t('audio_resolved_settings')}
          </p>

          {isCustomMode ? (
            /* Custom mode: editable settings */
            <>
              {selectRow({
                label: t('audio_codec'),
                select: (describedBy) => (
                  <Select
                    id="audio-codec"
                    label={t('audio_codec')}
                    hideLabel
                    value={settings.customAudioSettings.codec}
                    options={codecSupport.availableCodecs.map((codec) => ({
                      value: codec,
                      label: CODEC_METADATA[codec].label,
                    }))}
                    onChange={(codec) => handleCodecChange(codec as AudioCodec)}
                    aria-describedby={describedBy}
                  />
                ),
              })}

              {/* Bitrate - only show if codec has bitrate options */}
              {availableBitrates.length > 0 &&
                selectRow({
                  label: t('audio_bitrate'),
                  select: (describedBy) => (
                    <Select
                      id="audio-bitrate"
                      label={t('audio_bitrate')}
                      hideLabel
                      value={settings.customAudioSettings.bitrate}
                      options={availableBitrates.map((bitrate) => ({
                        value: bitrate,
                        label: `${bitrate} kbps`,
                      }))}
                      onChange={(bitrate) => handleBitrateChange(bitrate as Bitrate)}
                      aria-describedby={describedBy}
                    />
                  ),
                })}

              {selectRow({
                label: t('audio_channels'),
                select: (describedBy) => (
                  <Select
                    id="audio-channels"
                    label={t('audio_channels')}
                    hideLabel
                    value={settings.customAudioSettings.channels}
                    options={[
                      { value: 2, label: t('audio_channels_stereo') },
                      { value: 1, label: t('audio_channels_mono') },
                    ]}
                    onChange={(channels) => handleChannelsChange(channels as 1 | 2)}
                    aria-describedby={describedBy}
                  />
                ),
              })}

              {/* Sample Rate - PCM follows the capture device, so only for compressed codecs */}
              {settings.customAudioSettings.codec !== 'pcm' &&
                availableSampleRates.length > 0 &&
                selectRow({
                  label: t('audio_sample_rate'),
                  select: (describedBy) => (
                    <Select
                      id="audio-sample-rate"
                      label={t('audio_sample_rate')}
                      hideLabel
                      value={settings.customAudioSettings.sampleRate}
                      options={availableSampleRates.map((rate) => ({
                        value: rate,
                        label: `${rate / 1000} kHz`,
                      }))}
                      onChange={(rate) => handleSampleRateChange(rate as SupportedSampleRate)}
                      aria-describedby={describedBy}
                    />
                  ),
                })}

              {/* Falling behind - here for the codecs the browser encodes */}
              {fallBehindPlacement === 'format' && fallBehindRow}

              {/* Bit Depth - only where the codec offers a choice */}
              {showBitDepth &&
                selectRow({
                  label: t('audio_bit_depth'),
                  select: (describedBy) => (
                    <Select
                      id="audio-bit-depth"
                      label={t('audio_bit_depth')}
                      hideLabel
                      value={settings.customAudioSettings.bitsPerSample}
                      options={getSupportedBitDepths(settings.customAudioSettings.codec).map(
                        (depth) => ({
                          value: depth,
                          label: depth === 16 ? t('audio_bit_depth_16') : t('audio_bit_depth_24'),
                        }),
                      )}
                      onChange={(depth) => handleBitDepthChange(depth as BitDepth)}
                      aria-describedby={describedBy}
                    />
                  ),
                })}

              {/* PCM summary: sample rate, smoothing, head start, added delay */}
              {pcmRows.length > 0 && (
                <DescriptionList
                  kind="readout"
                  rows={pcmRows.map((row) => ({ key: row.key, term: row.label, value: row.value }))}
                />
              )}
            </>
          ) : (
            /* Non-custom mode: read-only display */
            resolvedConfig && (
              <DescriptionList
                kind="readout"
                rows={resolvedRows.map((row) => ({
                  key: row.key,
                  term: row.label,
                  value: row.value,
                }))}
              />
            )
          )}

          {isPcm && <p className={styles.hint}>{t('audio_sample_rate_follows_capture_hint')}</p>}

          {/* The browser refuses this exact combination: say so before cast time */}
          {combinationSupported === false && (
            <Notice
              tone="warning"
              text={
                isCustomMode
                  ? t('audio_combination_unsupported_custom')
                  : t('audio_combination_unsupported_preset')
              }
            />
          )}

          {showSmoothing && settings.smoothingMigrationNotice && (
            <Notice
              tone="info"
              text={t('audio_smoothing_migrated', settings.smoothingMigrationNotice)}
              onDismiss={handleDismissMigration}
              dismissLabel={t('dismiss')}
            />
          )}

          {/* Advanced: smoothing for any PCM cast; frame size and, in Bespoke, falling behind for a PCM tab cast */}
          {showSmoothing && (
            <div ref={advancedRef} className={styles.advancedAnchor}>
              <Disclosure
                id="audio-advanced"
                label={t('audio_advanced')}
                open={advancedOpen}
                onOpenChange={setAdvancedOpen}
              >
                {selectRow({
                  label: t('audio_smoothing'),
                  help: t('audio_smoothing_hint'),
                  select: (describedBy) => (
                    <Select
                      id="audio-smoothing"
                      label={t('audio_smoothing')}
                      hideLabel
                      value={settings.pcmSmoothingMs}
                      options={PCM_SMOOTHING_OPTIONS.map((ms) => ({
                        value: ms,
                        label: optionLabel(ms, PCM_SMOOTHING_DEFAULT_MS),
                      }))}
                      onChange={(ms) => handleSmoothingChange(ms as PcmSmoothingMs)}
                      aria-describedby={describedBy}
                    />
                  ),
                })}

                {showFrameSize &&
                  selectRow({
                    label: t('audio_frame_size'),
                    help: t('audio_frame_size_hint'),
                    select: (describedBy) => (
                      <Select
                        id="audio-frame-size"
                        label={t('audio_frame_size')}
                        hideLabel
                        value={settings.pcmFrameDurationMs}
                        options={FRAME_DURATIONS.map((ms) => ({
                          value: ms,
                          label: optionLabel(ms, FRAME_DURATION_MS_DEFAULT),
                        }))}
                        onChange={(ms) => handleFrameDurationChange(ms as FrameDurationMs)}
                        aria-describedby={describedBy}
                      />
                    ),
                  })}

                {/* Falling behind - here for Bespoke PCM on a tab cast */}
                {fallBehindPlacement === 'advanced' && fallBehindRow}
              </Disclosure>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
