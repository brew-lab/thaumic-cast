/**
 * Audio Quality Presets Module
 *
 * Integrates runtime codec detection with device-tier presets to ensure
 * we only select codec/bitrate combinations that are actually supported
 * by the browser's WebCodecs API.
 */

import type {
  AudioCodec,
  Bitrate,
  EncoderConfig,
  LatencyMode,
  PowerState,
  SupportedCodecsResult,
  SupportedSampleRate,
} from '@thaumic-cast/protocol';
import { getSupportedBitrates, CODEC_METADATA } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import {
  classifyDeviceTier,
  getDeviceCapabilities,
  checkPowerState,
  type DeviceTier,
} from './device-config';
import type { AudioMode, CustomAudioSettings } from './settings';

const log = createLogger('Presets');

// ─────────────────────────────────────────────────────────────────────────────
// Preset Definitions (with fallback chains)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Codec/bitrate preference for a quality preset.
 * Listed in order of preference - first supported option is selected.
 */
interface PresetOption {
  codec: AudioCodec;
  bitrate: Bitrate;
}

/**
 * Full preset definition including audio and latency settings.
 */
interface PresetDefinition {
  /** Codec/bitrate options in order of preference */
  options: PresetOption[];
  /** Default number of channels */
  channels: 1 | 2;
  /** Default sample rate */
  sampleRate: SupportedSampleRate;
  /** Latency mode for encoding */
  latencyMode: LatencyMode;
}

/**
 * Mode preset definitions.
 * Each mode has a priority list of codec/bitrate combinations.
 * The first supported option will be selected.
 */
const MODE_PRESETS: Record<Exclude<AudioMode, 'auto' | 'custom'>, PresetDefinition> = {
  high: {
    options: [
      { codec: 'flac', bitrate: 0 }, // Lossless preferred
      { codec: 'aac-lc', bitrate: 256 },
      { codec: 'vorbis', bitrate: 320 },
      { codec: 'aac-lc', bitrate: 192 }, // Fallback if 256 not supported
    ],
    channels: 2,
    sampleRate: 48000,
    latencyMode: 'quality',
  },
  mid: {
    options: [
      { codec: 'aac-lc', bitrate: 192 },
      { codec: 'vorbis', bitrate: 192 },
      { codec: 'he-aac', bitrate: 128 },
      { codec: 'aac-lc', bitrate: 128 },
    ],
    channels: 2,
    sampleRate: 48000,
    latencyMode: 'quality',
  },
  low: {
    options: [
      { codec: 'he-aac-v2', bitrate: 64 },
      { codec: 'he-aac', bitrate: 64 },
      { codec: 'aac-lc', bitrate: 128 },
      { codec: 'vorbis', bitrate: 128 },
    ],
    channels: 2,
    sampleRate: 44100,
    latencyMode: 'realtime',
  },
};

/**
 * Device tier to mode mapping for auto mode.
 */
const TIER_TO_MODE: Record<DeviceTier, Exclude<AudioMode, 'auto' | 'custom'>> = {
  'high-end': 'high',
  balanced: 'mid',
  'low-end': 'low',
};

// ─────────────────────────────────────────────────────────────────────────────
// Resolution Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if a codec/bitrate combination is supported.
 * @param option - The preset option to check
 * @param codecSupport - Runtime codec support info
 * @returns True if supported
 */
function isOptionSupported(option: PresetOption, codecSupport: SupportedCodecsResult): boolean {
  if (!codecSupport.availableCodecs.includes(option.codec)) {
    return false;
  }
  const supportedBitrates = getSupportedBitrates(option.codec, codecSupport);
  return supportedBitrates.includes(option.bitrate);
}

/**
 * Finds the first supported option from a preset's option list.
 * @param preset - The preset definition
 * @param codecSupport - Runtime codec support info
 * @returns The first supported option, or null if none supported
 */
function findSupportedOption(
  preset: PresetDefinition,
  codecSupport: SupportedCodecsResult,
): PresetOption | null {
  for (const option of preset.options) {
    if (isOptionSupported(option, codecSupport)) {
      return option;
    }
  }
  return null;
}

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
    latencyMode: 'quality',
  };
}

/**
 * Builds an encoder config from a preset option.
 * @param option - The codec/bitrate option
 * @param preset - The preset definition for other settings
 * @returns A complete encoder config
 */
function buildConfig(option: PresetOption, preset: PresetDefinition): EncoderConfig {
  return {
    codec: option.codec,
    bitrate: option.bitrate,
    sampleRate: preset.sampleRate,
    channels: preset.channels,
    latencyMode: preset.latencyMode,
  };
}

/**
 * Resolves an audio mode to an encoder configuration.
 *
 * For named presets (low/mid/high), selects the first supported codec/bitrate
 * combination from the preset's preference list.
 *
 * For 'auto' mode, determines device tier and power state to select
 * the appropriate preset automatically.
 *
 * For 'custom' mode, uses the provided custom settings directly.
 *
 * @param mode - The audio quality mode
 * @param codecSupport - Runtime codec support info from detectSupportedCodecs()
 * @param powerState - Power state from desktop app (for auto mode)
 * @param customSettings - Custom settings (required if mode is 'custom')
 * @returns The resolved encoder configuration
 * @throws Error if no supported codecs are found
 */
export function resolveAudioMode(
  mode: AudioMode,
  codecSupport: SupportedCodecsResult,
  powerState: PowerState | null = null,
  customSettings?: CustomAudioSettings,
): EncoderConfig {
  // Custom mode: use user-provided settings
  if (mode === 'custom' && customSettings) {
    // Validate that custom settings are still supported
    const isSupported = isOptionSupported(
      { codec: customSettings.codec, bitrate: customSettings.bitrate },
      codecSupport,
    );

    if (isSupported) {
      return {
        codec: customSettings.codec,
        bitrate: customSettings.bitrate,
        channels: customSettings.channels,
        sampleRate: customSettings.sampleRate,
        latencyMode: 'quality',
      };
    }

    // Custom settings not supported - fall back to mid preset
    log.warn('Custom audio settings not supported, falling back to mid preset');
    mode = 'mid';
  }

  // Auto mode: determine mode based on device tier and power state
  if (mode === 'auto') {
    const power = checkPowerState(powerState);

    // Force low preset on battery to conserve power
    if (power.onBattery) {
      log.info('On battery power, using low preset');
      mode = 'low';
    } else {
      // Use device tier to select preset
      const caps = getDeviceCapabilities();
      const tier = classifyDeviceTier(caps);
      mode = TIER_TO_MODE[tier];
      log.info(`Device tier: ${tier}, using ${mode} preset`);
    }
  }

  // Resolve named preset (mode is now 'low' | 'mid' | 'high' after handling auto/custom)
  const presetMode = mode as Exclude<AudioMode, 'auto' | 'custom'>;
  const preset = MODE_PRESETS[presetMode];
  const option = findSupportedOption(preset, codecSupport);

  if (option) {
    const config = buildConfig(option, preset);
    log.info(`Resolved ${mode} preset: ${option.codec} @ ${option.bitrate}kbps`);
    return config;
  }

  // No preset option supported - try fallback
  log.warn(`No options supported for ${mode} preset, using fallback`);
  const fallback = getFallbackConfig(codecSupport);

  if (fallback) {
    return fallback;
  }

  throw new Error('No supported audio codecs found on this system');
}

/**
 * Gets the display configuration for a mode (for UI preview).
 * Shows what settings the mode would resolve to WITHOUT applying power state.
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
  if (mode === 'custom' && customSettings) {
    const isSupported = isOptionSupported(
      { codec: customSettings.codec, bitrate: customSettings.bitrate },
      codecSupport,
    );

    if (isSupported) {
      return {
        codec: customSettings.codec,
        bitrate: customSettings.bitrate,
        channels: customSettings.channels,
        sampleRate: customSettings.sampleRate,
        latencyMode: 'quality',
      };
    }
    return null;
  }

  // For auto mode, show the balanced preset as representative
  const resolvedPresetMode: Exclude<AudioMode, 'auto' | 'custom'> =
    mode === 'auto' ? 'mid' : (mode as Exclude<AudioMode, 'auto' | 'custom'>);
  const preset = MODE_PRESETS[resolvedPresetMode];
  const option = findSupportedOption(preset, codecSupport);

  if (option) {
    return buildConfig(option, preset);
  }

  return getFallbackConfig(codecSupport);
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

/**
 * Gets a short label for the current mode and config.
 * Used in popup footer.
 * @param mode - The audio mode
 * @param config - The resolved encoder config
 * @returns A short label like "Auto • AAC-LC 192kbps"
 */
export function getModeLabel(mode: AudioMode, config: EncoderConfig): string {
  const modeLabels: Record<AudioMode, string> = {
    auto: 'Auto',
    low: 'Low',
    mid: 'Balanced',
    high: 'High',
    custom: 'Custom',
  };

  const codecMeta = CODEC_METADATA[config.codec];
  const bitrateStr = config.bitrate === 0 ? 'Lossless' : `${config.bitrate}kbps`;

  return `${modeLabels[mode]} • ${codecMeta.label} ${bitrateStr}`;
}
