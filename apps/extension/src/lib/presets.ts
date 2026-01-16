/**
 * Audio Quality Presets Module
 *
 * Uses dynamic preset generation based on runtime codec detection to ensure
 * meaningful quality tiers (high/mid/low) that differ based on actual device
 * capabilities rather than hardcoded codec preferences.
 */

import type {
  EncoderConfig,
  LatencyMode,
  SupportedCodecsResult,
  DynamicPresets,
  ScoredCodecOption,
} from '@thaumic-cast/protocol';
import {
  CODEC_METADATA,
  DEFAULT_BITS_PER_SAMPLE,
  generateDynamicPresets,
  getSupportedSampleRates,
  STREAMING_BUFFER_MS_DEFAULT,
} from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import type { AudioMode, CustomAudioSettings } from './settings';

const log = createLogger('Presets');

// ─────────────────────────────────────────────────────────────────────────────
// Helper Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Builds an encoder config from custom audio settings.
 * Applies defaults for optional fields (bitsPerSample, streamingBufferMs).
 * @param customSettings - The custom audio settings from user preferences
 * @returns A complete encoder config
 */
function buildConfigFromCustomSettings(customSettings: CustomAudioSettings): EncoderConfig {
  return {
    codec: customSettings.codec,
    bitrate: customSettings.bitrate,
    channels: customSettings.channels,
    sampleRate: customSettings.sampleRate,
    bitsPerSample: customSettings.bitsPerSample ?? DEFAULT_BITS_PER_SAMPLE,
    latencyMode: customSettings.latencyMode,
    streamingBufferMs: customSettings.streamingBufferMs ?? STREAMING_BUFFER_MS_DEFAULT,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolution Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gets the ultimate fallback configuration using any available codec.
 * @param codecSupport - Runtime codec support info
 * @returns A fallback encoder config, or null if no codecs available
 */
function getFallbackConfig(codecSupport: SupportedCodecsResult): EncoderConfig | null {
  if (!codecSupport.defaultCodec || codecSupport.defaultBitrate === null) {
    return null;
  }

  return {
    codec: codecSupport.defaultCodec,
    bitrate: codecSupport.defaultBitrate,
    sampleRate: 48000,
    channels: 2,
    bitsPerSample: DEFAULT_BITS_PER_SAMPLE,
    latencyMode: 'quality',
    streamingBufferMs: STREAMING_BUFFER_MS_DEFAULT,
  };
}

/**
 * Picks the best sample rate for a codec based on tier preference.
 * - High/Balanced: prefer 48kHz (best quality)
 * - Low: prefer 44.1kHz (lower bandwidth)
 *
 * @param codec - The audio codec
 * @param codecSupport - Runtime codec support info
 * @param preferLower - Whether to prefer lower sample rate (for Low tier)
 * @returns The best available sample rate
 */
function pickSampleRate(
  codec: ScoredCodecOption['codec'],
  codecSupport: SupportedCodecsResult,
  preferLower: boolean = false,
): 48000 | 44100 {
  const supported = getSupportedSampleRates(codec, codecSupport);

  if (supported.length === 0) {
    // No sample rate info available, default to 48kHz
    return 48000;
  }

  if (preferLower) {
    // Low tier: prefer 44.1kHz if available
    if (supported.includes(44100)) return 44100;
    if (supported.includes(48000)) return 48000;
  } else {
    // High/Balanced: prefer 48kHz
    if (supported.includes(48000)) return 48000;
    if (supported.includes(44100)) return 44100;
  }

  // Fallback to first available
  return supported[0] as 48000 | 44100;
}

/**
 * Builds an encoder config from a scored codec option.
 * @param option - The scored codec option from dynamic presets
 * @param codecSupport - Runtime codec support info
 * @param tier - The quality tier (affects sample rate and channel selection)
 * @param latencyMode - The latency mode to use
 * @returns A complete encoder config
 */
function buildConfigFromOption(
  option: ScoredCodecOption,
  codecSupport: SupportedCodecsResult,
  tier: 'high' | 'mid' | 'low',
  latencyMode: LatencyMode = 'quality',
): EncoderConfig {
  const sampleRate = pickSampleRate(option.codec, codecSupport, tier === 'low');
  // Low tier uses mono for bandwidth savings
  const channels: 1 | 2 = tier === 'low' ? 1 : 2;

  return {
    codec: option.codec,
    bitrate: option.bitrate,
    sampleRate,
    channels,
    bitsPerSample: DEFAULT_BITS_PER_SAMPLE,
    latencyMode,
    streamingBufferMs: STREAMING_BUFFER_MS_DEFAULT,
  };
}

/**
 * Gets the preset option for a given mode from dynamic presets.
 * @param mode - The audio mode (high/mid/low)
 * @param dynamicPresets - The generated dynamic presets
 * @returns The scored option for that tier, or null
 */
function getPresetForMode(
  mode: Exclude<AudioMode, 'custom'>,
  dynamicPresets: DynamicPresets,
): ScoredCodecOption | null {
  return dynamicPresets[mode];
}

/**
 * Resolves an audio mode to an encoder configuration.
 *
 * For named presets (low/mid/high), uses dynamically generated presets based
 * on actual device codec support to ensure meaningful quality differentiation.
 *
 * For 'custom' mode, uses the provided custom settings directly.
 *
 * @param mode - The audio quality mode
 * @param codecSupport - Runtime codec support info from detectSupportedCodecs()
 * @param customSettings - Custom settings (required if mode is 'custom')
 * @returns The resolved encoder configuration
 * @throws Error if no supported codecs are found
 */
export function resolveAudioMode(
  mode: AudioMode,
  codecSupport: SupportedCodecsResult,
  customSettings?: CustomAudioSettings,
): EncoderConfig {
  // Custom mode: use user-provided settings
  if (mode === 'custom' && customSettings) {
    // Validate that custom settings are still supported
    const dynamicPresets = generateDynamicPresets(codecSupport);
    const isSupported = dynamicPresets.allOptions.some(
      (opt) => opt.codec === customSettings.codec && opt.bitrate === customSettings.bitrate,
    );

    if (isSupported) {
      return buildConfigFromCustomSettings(customSettings);
    }

    // Custom settings not supported - fall back to mid preset
    log.warn('Custom audio settings not supported, falling back to mid preset');
    mode = 'mid';
  }

  // Generate dynamic presets based on device capabilities
  const dynamicPresets = generateDynamicPresets(codecSupport);

  // Resolve named preset
  const presetMode = mode as Exclude<AudioMode, 'custom'>;
  const option = getPresetForMode(presetMode, dynamicPresets);

  if (option) {
    // Use realtime latency for low preset
    const latencyMode: LatencyMode = presetMode === 'low' ? 'realtime' : 'quality';
    const config = buildConfigFromOption(option, codecSupport, presetMode, latencyMode);
    log.info(
      `Resolved ${mode} preset: ${option.codec} @ ${option.bitrate}kbps @ ${config.sampleRate}Hz (score: ${option.score})`,
    );
    return config;
  }

  // No preset option available - try fallback
  log.warn(`No options available for ${mode} preset, using fallback`);
  const fallback = getFallbackConfig(codecSupport);

  if (fallback) {
    return fallback;
  }

  throw new Error('No supported audio codecs found on this system');
}

/**
 * Gets the display configuration for a mode (for UI preview).
 *
 * @param mode - The audio quality mode
 * @param codecSupport - Runtime codec support info
 * @param customSettings - Custom settings (for custom mode)
 * @returns The resolved encoder config for display purposes
 */
export function getResolvedConfigForDisplay(
  mode: AudioMode,
  codecSupport: SupportedCodecsResult,
  customSettings?: CustomAudioSettings,
): EncoderConfig | null {
  const dynamicPresets = generateDynamicPresets(codecSupport);

  if (mode === 'custom' && customSettings) {
    const isSupported = dynamicPresets.allOptions.some(
      (opt) => opt.codec === customSettings.codec && opt.bitrate === customSettings.bitrate,
    );

    if (isSupported) {
      return buildConfigFromCustomSettings(customSettings);
    }
    return null;
  }

  const presetMode = mode as Exclude<AudioMode, 'custom'>;
  const option = getPresetForMode(presetMode, dynamicPresets);

  if (option) {
    const latencyMode: LatencyMode = presetMode === 'low' ? 'realtime' : 'quality';
    return buildConfigFromOption(option, codecSupport, presetMode, latencyMode);
  }

  return getFallbackConfig(codecSupport);
}

/**
 * Gets dynamic presets for the current device capabilities.
 * Used by UI to show what each quality tier resolves to.
 *
 * @param codecSupport - Runtime codec support info
 * @returns Dynamic presets with scored options for each tier
 */
export function getDynamicPresets(codecSupport: SupportedCodecsResult): DynamicPresets {
  return generateDynamicPresets(codecSupport);
}

/**
 * Gets a human-readable description of an encoder config.
 * @param config - The encoder configuration
 * @returns A description string
 */
export function describeEncoderConfig(config: EncoderConfig): string {
  const codecMeta = CODEC_METADATA[config.codec];
  const channelStr = config.channels === 1 ? 'Mono' : 'Stereo';
  const bitrateStr = config.bitrate === 0 ? 'Lossless' : `${config.bitrate} kbps`;

  return `${codecMeta.label} • ${bitrateStr} • ${channelStr} • ${config.sampleRate / 1000}kHz`;
}
