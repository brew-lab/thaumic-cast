import { z } from 'zod';

import {
  type AudioCodec,
  AudioCodecSchema,
  type BitDepth,
  BitDepthSchema,
  type Bitrate,
  BitrateSchema,
  FRAME_DURATION_MS_DEFAULT,
  FRAME_DURATION_MS_MAX,
  FRAME_DURATION_MS_MIN,
  type LatencyMode,
  LatencyModeSchema,
  SampleRateSchema,
  STREAMING_BUFFER_MS_DEFAULT,
  STREAMING_BUFFER_MS_MAX,
  STREAMING_BUFFER_MS_MIN,
  type SupportedSampleRate,
} from './audio.js';

/**
 * Metadata about a codec for UI display and validation.
 */
export interface CodecMetadata {
  label: string;
  description: string;
  validBitrates: readonly Bitrate[];
  defaultBitrate: Bitrate;
  webCodecsId: string | null;
  /**
   * Efficiency multiplier for quality scoring.
   * Higher values mean the codec achieves better quality at the same bitrate.
   * AAC-LC is the baseline at 1.0.
   * Example: HE-AAC at 64kbps ≈ AAC-LC at 96kbps (efficiency = 1.5)
   */
  efficiency: number;
  /**
   * Supported bit depths for this codec.
   * Most codecs only support 16-bit, FLAC supports both 16 and 24-bit.
   */
  supportedBitDepths: readonly BitDepth[];
}

/**
 * Codecs that have encoder implementations in the extension.
 * When adding a new encoder, add the codec here to enable it in the UI.
 */
export const IMPLEMENTED_CODECS: ReadonlySet<AudioCodec> = new Set([
  'pcm',
  'aac-lc',
  'he-aac',
  'he-aac-v2',
  'flac',
  'vorbis',
]);

/**
 * Checks if we have an encoder implementation for the given codec.
 * @param codec - The codec to check
 * @returns True if we have an encoder for this codec
 */
export function hasEncoderImplementation(codec: AudioCodec): boolean {
  return IMPLEMENTED_CODECS.has(codec);
}

/**
 * Metadata about each codec for UI display and validation.
 * Codecs are listed in order of preference for the UI.
 */
export const CODEC_METADATA: Record<AudioCodec, CodecMetadata> = {
  pcm: {
    label: 'PCM',
    description: 'Uncompressed lossless audio',
    validBitrates: [] as const,
    defaultBitrate: 0, // 0 indicates lossless/variable bitrate
    webCodecsId: null, // No WebCodecs - raw PCM passthrough
    efficiency: 10.0, // Lossless - uncompressed
    supportedBitDepths: [16] as const,
  },
  'aac-lc': {
    label: 'AAC-LC',
    description: 'Balanced quality and efficiency',
    validBitrates: [128, 192, 256] as const,
    defaultBitrate: 192,
    webCodecsId: 'mp4a.40.2',
    efficiency: 1.0, // Baseline
    supportedBitDepths: [16] as const,
  },
  'he-aac': {
    label: 'HE-AAC',
    description: 'High efficiency, best for low bandwidth',
    validBitrates: [64, 96, 128] as const,
    defaultBitrate: 96,
    webCodecsId: 'mp4a.40.5',
    efficiency: 1.5, // ~50% more efficient than AAC-LC
    supportedBitDepths: [16] as const,
  },
  'he-aac-v2': {
    label: 'HE-AAC v2',
    description: 'Best for very low bandwidth stereo',
    validBitrates: [64, 96] as const,
    defaultBitrate: 64,
    webCodecsId: 'mp4a.40.29',
    efficiency: 2.0, // ~100% more efficient (uses Parametric Stereo)
    supportedBitDepths: [16] as const,
  },
  flac: {
    label: 'FLAC',
    description: 'Lossless audio, highest quality',
    validBitrates: [0] as const,
    defaultBitrate: 0,
    webCodecsId: 'flac',
    efficiency: 10.0, // Lossless - highest possible quality
    supportedBitDepths: [16, 24] as const,
  },
  vorbis: {
    label: 'Ogg Vorbis',
    description: 'Open source, good quality',
    validBitrates: [128, 160, 192, 256, 320] as const,
    defaultBitrate: 192,
    webCodecsId: 'vorbis',
    efficiency: 1.1, // Slightly better than AAC-LC
    supportedBitDepths: [16] as const,
  },
} as const;

/**
 * Returns valid bitrates for a given codec.
 * @param codec - The audio codec to get bitrates for
 * @returns Array of valid bitrates for the codec
 */
export function getValidBitrates(codec: AudioCodec): readonly Bitrate[] {
  return CODEC_METADATA[codec].validBitrates;
}

/**
 * Returns the default bitrate for a codec.
 * @param codec - The audio codec
 * @returns The default bitrate for the codec
 */
export function getDefaultBitrate(codec: AudioCodec): Bitrate {
  return CODEC_METADATA[codec].defaultBitrate;
}

/**
 * Validates that a bitrate is valid for a codec.
 * @param codec - The audio codec
 * @param bitrate - The bitrate to validate
 * @returns True if the bitrate is valid for the codec
 */
export function isValidBitrateForCodec(codec: AudioCodec, bitrate: Bitrate): boolean {
  return CODEC_METADATA[codec].validBitrates.includes(bitrate);
}

/**
 * Returns supported bit depths for a given codec.
 * @param codec - The audio codec
 * @returns Array of supported bit depths for the codec
 */
export function getSupportedBitDepths(codec: AudioCodec): readonly BitDepth[] {
  return CODEC_METADATA[codec].supportedBitDepths;
}

/**
 * Validates that a bit depth is valid for a codec.
 * @param codec - The audio codec
 * @param bitDepth - The bit depth to validate
 * @returns True if the bit depth is valid for the codec
 */
export function isValidBitDepthForCodec(codec: AudioCodec, bitDepth: BitDepth): boolean {
  return CODEC_METADATA[codec].supportedBitDepths.includes(bitDepth);
}

/**
 * Complete encoder configuration passed from UI to offscreen.
 */
export const EncoderConfigSchema = z
  .object({
    codec: AudioCodecSchema,
    bitrate: BitrateSchema,
    sampleRate: SampleRateSchema.default(48000),
    channels: z.union([z.literal(1), z.literal(2)]).default(2),
    /**
     * Bit depth for audio encoding.
     * 24-bit is only supported for FLAC codec on Sonos S2 speakers.
     */
    bitsPerSample: BitDepthSchema.default(16),
    latencyMode: LatencyModeSchema.default('quality'),
    /** Buffer size for PCM streaming in milliseconds. */
    streamingBufferMs: z
      .number()
      .min(STREAMING_BUFFER_MS_MIN)
      .max(STREAMING_BUFFER_MS_MAX)
      .default(STREAMING_BUFFER_MS_DEFAULT),
    /** Frame duration in milliseconds. Affects backend cadence timing. */
    frameDurationMs: z
      .number()
      .min(FRAME_DURATION_MS_MIN)
      .max(FRAME_DURATION_MS_MAX)
      .default(FRAME_DURATION_MS_DEFAULT),
  })
  .refine((c) => CODEC_METADATA[c.codec].supportedBitDepths.includes(c.bitsPerSample), {
    message: 'Bit depth not supported for this codec',
  });
export type EncoderConfig = z.infer<typeof EncoderConfigSchema>;

/**
 * Options for creating an encoder configuration.
 */
export interface CreateEncoderConfigOptions {
  codec: AudioCodec;
  bitrate?: Bitrate;
  sampleRate?: SupportedSampleRate;
  channels?: 1 | 2;
  /** Bit depth (16 or 24). 24-bit only supported for FLAC. */
  bitsPerSample?: BitDepth;
  latencyMode?: LatencyMode;
  /** Buffer size for PCM streaming in milliseconds (100-1000). */
  streamingBufferMs?: number;
  /** Frame duration in milliseconds (5-150). Affects backend cadence timing. */
  frameDurationMs?: number;
}

/**
 * Creates a validated encoder config, applying defaults and constraints.
 * @param options - Configuration options
 * @returns A validated encoder configuration
 */
export function createEncoderConfig(options: CreateEncoderConfigOptions): EncoderConfig {
  const {
    codec,
    bitrate,
    sampleRate = 48000,
    channels = 2,
    bitsPerSample = 16,
    latencyMode = 'quality',
    streamingBufferMs = STREAMING_BUFFER_MS_DEFAULT,
    frameDurationMs = FRAME_DURATION_MS_DEFAULT,
  } = options;
  const effectiveBitrate =
    bitrate && isValidBitrateForCodec(codec, bitrate) ? bitrate : getDefaultBitrate(codec);

  // Validate bitsPerSample against codec support
  const effectiveBitsPerSample = isValidBitDepthForCodec(codec, bitsPerSample) ? bitsPerSample : 16;

  return {
    codec,
    bitrate: effectiveBitrate,
    sampleRate,
    channels,
    bitsPerSample: effectiveBitsPerSample,
    latencyMode,
    streamingBufferMs,
    frameDurationMs,
  };
}
