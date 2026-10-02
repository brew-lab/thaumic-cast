import { z } from 'zod';

import {
  type AudioCodec,
  AudioCodecSchema,
  type BitDepth,
  BitDepthSchema,
  type Bitrate,
  BitrateSchema,
  FRAME_DURATION_MS_DEFAULT,
  type FrameDurationMs,
  FrameDurationMsSchema,
  FRAME_SIZE_SAMPLES_MAX,
  FRAME_SIZE_SAMPLES_MIN,
  type LatencyMode,
  LatencyModeSchema,
  SampleRateSchema,
  JITTER_BUFFER_MS_DEFAULT,
  JITTER_BUFFER_MS_MAX,
  JITTER_BUFFER_MS_MIN,
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
   * Supported bit depths for this codec.
   * Most codecs only support 16-bit, FLAC supports both 16 and 24-bit.
   */
  supportedBitDepths: readonly BitDepth[];
}

/**
 * Codecs that have encoder implementations in the extension.
 * When adding a new encoder, add the codec here to enable it in the UI.
 *
 * This is what the extension can offer in a handshake, so the companion must
 * have a stream for every entry: `fixtures/codecs.json` pins this list, and a
 * thaumic-core test resolves each name in it.
 */
export const IMPLEMENTED_CODECS: ReadonlySet<AudioCodec> = new Set(['pcm', 'aac-lc', 'flac']);

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
    supportedBitDepths: [16] as const,
  },
  'aac-lc': {
    label: 'AAC-LC',
    description: 'Balanced quality and efficiency',
    // Not every platform encodes every bitrate: Windows takes 96 to 192 and
    // refuses 256. Detection is per bitrate, so a refused one is not offered.
    validBitrates: [96, 128, 160, 192, 256] as const,
    defaultBitrate: 192,
    webCodecsId: 'mp4a.40.2',
    supportedBitDepths: [16] as const,
  },
  flac: {
    label: 'FLAC',
    description: 'Lossless audio, highest quality',
    validBitrates: [0] as const,
    defaultBitrate: 0,
    webCodecsId: 'flac',
    supportedBitDepths: [16, 24] as const,
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

/** The fields of an encoder config, before the check that spans two of them. */
const EncoderConfigFieldsSchema = z.object({
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
  /** Jitter buffer size for PCM streaming in milliseconds. */
  jitterBufferMs: z
    .number()
    .min(JITTER_BUFFER_MS_MIN)
    .max(JITTER_BUFFER_MS_MAX)
    .default(JITTER_BUFFER_MS_DEFAULT),
  /**
   * Frame duration in milliseconds for codecs that support configurable frame sizes.
   * Currently only used for PCM. Other codecs have fixed frame sizes.
   * - 10ms: Low latency, higher CPU overhead (default)
   * - 20ms: Balanced latency and efficiency
   * - 40ms: More stable on slower networks/devices
   */
  frameDurationMs: FrameDurationMsSchema.default(FRAME_DURATION_MS_DEFAULT).optional(),
  /**
   * Frame size in samples per channel.
   * Server derives exact frame duration: duration_ms = samples * 1000 / sample_rate.
   * Set by the audio worker based on codec-optimal frame size.
   */
  frameSizeSamples: z
    .number()
    .int()
    .min(FRAME_SIZE_SAMPLES_MIN)
    .max(FRAME_SIZE_SAMPLES_MAX)
    .optional(),
});

/**
 * Whether the codec of a config can carry its bit depth.
 * @param config - The codec and bit depth to check
 * @param config.codec - The audio codec
 * @param config.bitsPerSample - The bit depth
 * @returns True if the codec supports the bit depth
 */
function codecSupportsBitDepth(config: { codec: AudioCodec; bitsPerSample: BitDepth }): boolean {
  return CODEC_METADATA[config.codec].supportedBitDepths.includes(config.bitsPerSample);
}

const BIT_DEPTH_NOT_SUPPORTED = { message: 'Bit depth not supported for this codec' };

/**
 * Complete encoder configuration passed from UI to offscreen.
 */
export const EncoderConfigSchema = EncoderConfigFieldsSchema.refine(
  codecSupportsBitDepth,
  BIT_DEPTH_NOT_SUPPORTED,
);
export type EncoderConfig = z.infer<typeof EncoderConfigSchema>;

/**
 * The encoder config as it is sent to the companion, in `HANDSHAKE` and
 * `START_BROWSER_CAPTURE`.
 *
 * It leaves out `frameDurationMs` and `latencyMode`. The companion reads
 * neither: it works the frame duration out from `frameSizeSamples` and the
 * sample rate, and the latency mode only steers the extension's own encoder,
 * streaming policy and AudioContext. Both stay in {@link EncoderConfigSchema}
 * for that.
 */
export const WireEncoderConfigSchema = EncoderConfigFieldsSchema.omit({
  frameDurationMs: true,
  latencyMode: true,
}).refine(codecSupportsBitDepth, BIT_DEPTH_NOT_SUPPORTED);
export type WireEncoderConfig = z.infer<typeof WireEncoderConfigSchema>;

/**
 * Takes an encoder config down to what the companion reads, for sending in a
 * `HANDSHAKE` or `START_BROWSER_CAPTURE` message.
 * @param config - The encoder config the extension works with
 * @returns The same config without `frameDurationMs` and `latencyMode`
 */
export function toWireEncoderConfig(config: EncoderConfig): WireEncoderConfig {
  const wire: Partial<EncoderConfig> = { ...config };
  delete wire.frameDurationMs;
  delete wire.latencyMode;
  return wire as WireEncoderConfig;
}

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
  /** Jitter buffer size for PCM streaming in milliseconds (100-1000). */
  jitterBufferMs?: number;
  /** Frame duration in milliseconds (10, 20, or 40). Currently only used for PCM codec. */
  frameDurationMs?: FrameDurationMs;
  /** Frame size in samples per channel. Set by audio worker. */
  frameSizeSamples?: number;
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
    jitterBufferMs = JITTER_BUFFER_MS_DEFAULT,
    frameDurationMs = FRAME_DURATION_MS_DEFAULT,
    frameSizeSamples,
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
    jitterBufferMs,
    frameDurationMs,
    frameSizeSamples,
  };
}
