import {
  type AudioCodec,
  type Bitrate,
  SUPPORTED_SAMPLE_RATES,
  type SupportedSampleRate,
} from './audio.js';
import { CODEC_METADATA, hasEncoderImplementation } from './encoder.js';

/**
 * Result of checking codec support for a specific configuration.
 */
export interface CodecSupportInfo {
  codec: AudioCodec;
  bitrate: Bitrate;
  supported: boolean;
}

/**
 * Sample rate support information for a codec.
 */
export interface SampleRateSupportInfo {
  codec: AudioCodec;
  sampleRate: SupportedSampleRate;
  supported: boolean;
}

/**
 * Result of detecting all supported codecs.
 */
export interface SupportedCodecsResult {
  /** All supported codec/bitrate combinations */
  supported: CodecSupportInfo[];
  /** Sample rate support per codec */
  sampleRateSupport: SampleRateSupportInfo[];
  /** Codecs that have at least one supported bitrate */
  availableCodecs: AudioCodec[];
  /** The recommended default codec (first available) */
  defaultCodec: AudioCodec | null;
  /** The recommended default bitrate for the default codec */
  defaultBitrate: Bitrate | null;
}

/**
 * Checks if a specific codec/bitrate combination is supported.
 *
 * For PCM: Always returns true (no WebCodecs dependency - raw passthrough).
 * For others: Checks WebCodecs AudioEncoder.isConfigSupported().
 *
 * @param codec - The audio codec to check
 * @param bitrate - The bitrate in kbps
 * @param sampleRate - Sample rate (default 48000)
 * @param channels - Number of channels (default 2)
 * @returns Promise resolving to true if supported
 */
export async function isCodecSupported(
  codec: AudioCodec,
  bitrate: Bitrate,
  sampleRate = 48000,
  channels = 2,
): Promise<boolean> {
  const webCodecsId = CODEC_METADATA[codec]?.webCodecsId;

  // PCM is always supported - no WebCodecs dependency
  if (webCodecsId === null) {
    return true;
  }

  if (typeof AudioEncoder === 'undefined') {
    return false;
  }

  try {
    const result = await AudioEncoder.isConfigSupported({
      codec: webCodecsId,
      sampleRate,
      numberOfChannels: channels,
      bitrate: bitrate * 1000,
    });
    return result.supported === true;
  } catch {
    return false;
  }
}

/**
 * Detects all supported codec/bitrate/sampleRate combinations.
 * Only checks codecs that have encoder implementations, then verifies WebCodecs support.
 * @returns Promise resolving to supported codecs information
 */
export async function detectSupportedCodecs(): Promise<SupportedCodecsResult> {
  // Only check codecs we have encoder implementations for
  const codecs = (Object.keys(CODEC_METADATA) as AudioCodec[]).filter(hasEncoderImplementation);
  const supported: CodecSupportInfo[] = [];
  const sampleRateSupport: SampleRateSupportInfo[] = [];
  const availableCodecs: AudioCodec[] = [];

  for (const codec of codecs) {
    const bitrates = CODEC_METADATA[codec].validBitrates;
    const defaultBitrateForCodec = CODEC_METADATA[codec].defaultBitrate;
    let codecHasSupport = false;

    if (bitrates.length === 0) {
      // Lossless codec with no bitrate options (e.g., PCM)
      // Check if codec itself is supported using default bitrate
      codecHasSupport = await isCodecSupported(codec, defaultBitrateForCodec);
      if (codecHasSupport) {
        // Add to supported array so it appears in dynamic presets
        supported.push({ codec, bitrate: defaultBitrateForCodec, supported: true });
      }
    } else {
      // Test bitrate support (using default 48kHz)
      for (const bitrate of bitrates) {
        const isSupported = await isCodecSupported(codec, bitrate);
        supported.push({ codec, bitrate, supported: isSupported });

        if (isSupported) {
          codecHasSupport = true;
        }
      }
    }

    // Test sample rate support (using default bitrate for the codec)
    if (codecHasSupport) {
      availableCodecs.push(codec);

      for (const sampleRate of SUPPORTED_SAMPLE_RATES) {
        const isSupported = await isCodecSupported(codec, defaultBitrateForCodec, sampleRate);
        sampleRateSupport.push({ codec, sampleRate, supported: isSupported });
      }
    }
  }

  // Default to first available codec with its default bitrate
  const defaultCodec = availableCodecs[0] ?? null;
  const defaultBitrate = defaultCodec ? CODEC_METADATA[defaultCodec].defaultBitrate : null;

  return {
    supported,
    sampleRateSupport,
    availableCodecs,
    defaultCodec,
    defaultBitrate,
  };
}

/**
 * Gets supported bitrates for a codec based on runtime detection.
 * @param codec - The audio codec
 * @param supportInfo - Previously detected support info
 * @returns Array of supported bitrates for the codec
 */
export function getSupportedBitrates(
  codec: AudioCodec,
  supportInfo: SupportedCodecsResult,
): Bitrate[] {
  return supportInfo.supported
    .filter((s) => s.codec === codec && s.supported)
    .map((s) => s.bitrate);
}

/**
 * Gets supported sample rates for a codec based on runtime detection.
 * @param codec - The audio codec
 * @param supportInfo - Previously detected support info
 * @returns Array of supported sample rates for the codec
 */
export function getSupportedSampleRates(
  codec: AudioCodec,
  supportInfo: SupportedCodecsResult,
): SupportedSampleRate[] {
  return supportInfo.sampleRateSupport
    .filter((s) => s.codec === codec && s.supported)
    .map((s) => s.sampleRate);
}

/**
 * A scored codec/bitrate option for dynamic preset generation.
 */
export interface ScoredCodecOption {
  codec: AudioCodec;
  bitrate: Bitrate;
  /** Quality score: higher = better perceived quality */
  score: number;
  /** Human-readable label for UI display */
  label: string;
}

/**
 * Dynamic presets generated based on device capabilities.
 */
export interface DynamicPresets {
  /** Highest quality option available */
  high: ScoredCodecOption | null;
  /** Middle-tier quality option */
  mid: ScoredCodecOption | null;
  /** Lowest bandwidth/power option */
  low: ScoredCodecOption | null;
  /** All scored options sorted by quality (highest first) */
  allOptions: ScoredCodecOption[];
}

/**
 * Calculates a quality score for a codec/bitrate combination.
 * Score = bitrate * efficiency (with special handling for lossless).
 * @param codec - The audio codec
 * @param bitrate - The bitrate in kbps
 * @returns Quality score (higher = better)
 */
export function calculateQualityScore(codec: AudioCodec, bitrate: Bitrate): number {
  const meta = CODEC_METADATA[codec];
  // FLAC is lossless, give it a very high score
  if (bitrate === 0) {
    return 1000;
  }
  return bitrate * meta.efficiency;
}

/**
 * Creates a human-readable label for a codec/bitrate combination.
 * @param codec - The audio codec
 * @param bitrate - The bitrate in kbps
 * @returns Label like "AAC-LC 192kbps" or "FLAC Lossless"
 */
export function getCodecBitrateLabel(codec: AudioCodec, bitrate: Bitrate): string {
  const meta = CODEC_METADATA[codec];
  if (bitrate === 0) {
    return `${meta.label} Lossless`;
  }
  return `${meta.label} ${bitrate}kbps`;
}

/**
 * Generates dynamic quality presets based on device capabilities.
 * Analyzes all supported codec/bitrate combinations and creates
 * meaningful high/mid/low tiers.
 *
 * Tier selection logic:
 * - HIGH: Best quality → highest bitrate (FLAC preferred if available)
 * - LOW: Lowest bandwidth → lowest bitrate with efficient codec
 * - BALANCED: Middle ground → moderate bitrate with good efficiency
 *
 * @param supportInfo - Runtime codec support detection results
 * @returns Dynamic presets with scored options
 */
export function generateDynamicPresets(supportInfo: SupportedCodecsResult): DynamicPresets {
  // Collect all supported codec+bitrate combinations with scores
  const allOptions: ScoredCodecOption[] = [];

  for (const info of supportInfo.supported) {
    if (!info.supported) continue;

    const score = calculateQualityScore(info.codec, info.bitrate);
    allOptions.push({
      codec: info.codec,
      bitrate: info.bitrate,
      score,
      label: getCodecBitrateLabel(info.codec, info.bitrate),
    });
  }

  // If no options, return empty presets
  if (allOptions.length === 0) {
    return { high: null, mid: null, low: null, allOptions: [] };
  }

  // Sort by score descending for the allOptions list (used for display)
  allOptions.sort((a, b) => b.score - a.score);

  // === HIGH TIER: Best quality (highest bitrate, prefer lossless) ===
  // Sort by: lossless first (pcm/flac), then by bitrate descending
  const isLossless = (codec: AudioCodec) => codec === 'pcm' || codec === 'flac';
  const highSorted = [...allOptions].sort((a, b) => {
    // Lossless codecs (pcm, flac) always win
    if (isLossless(a.codec) && !isLossless(b.codec)) return -1;
    if (isLossless(b.codec) && !isLossless(a.codec)) return 1;
    // Otherwise, highest bitrate wins
    return b.bitrate - a.bitrate;
  });
  const high = highSorted[0] ?? null;

  // === LOW TIER: Lowest bandwidth (lowest bitrate, prefer efficient codecs) ===
  // Filter out lossless options (bitrate 0) - they use MORE bandwidth, not less
  // Sort by: bitrate ascending, then by efficiency descending (for ties)
  const lowSorted = [...allOptions]
    .filter((opt) => opt.bitrate > 0)
    .sort((a, b) => {
      // Lowest bitrate first
      if (a.bitrate !== b.bitrate) return a.bitrate - b.bitrate;
      // For same bitrate, prefer more efficient codec
      const effA = CODEC_METADATA[a.codec].efficiency;
      const effB = CODEC_METADATA[b.codec].efficiency;
      return effB - effA;
    });
  // Pick the lowest bitrate option, but not the same as high
  let low: ScoredCodecOption | null = null;
  for (const opt of lowSorted) {
    if (opt.codec !== high?.codec || opt.bitrate !== high?.bitrate) {
      low = opt;
      break;
    }
  }

  // === BALANCED TIER: Middle ground ===
  // Find an option that's different from both high and low
  // Prefer efficient codecs (HE-AAC family) at moderate bitrates
  let mid: ScoredCodecOption | null = null;

  // First, try to find an option with a different codec than high and low
  for (const opt of allOptions) {
    const isHigh = opt.codec === high?.codec && opt.bitrate === high?.bitrate;
    const isLow = opt.codec === low?.codec && opt.bitrate === low?.bitrate;
    if (!isHigh && !isLow) {
      mid = opt;
      break;
    }
  }

  // If no distinct option found and we have at least 2 options, use a fallback
  if (!mid && allOptions.length >= 2) {
    // Use the second-best by score that isn't low
    for (const opt of allOptions) {
      const isHigh = opt.codec === high?.codec && opt.bitrate === high?.bitrate;
      const isLow = opt.codec === low?.codec && opt.bitrate === low?.bitrate;
      if (!isHigh && !isLow) {
        mid = opt;
        break;
      }
    }
  }

  return { high, mid, low, allOptions };
}
