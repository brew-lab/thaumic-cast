import { z } from 'zod';

// ─────────────────────────────────────────────────────────────────────────────
// System Defaults
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Default maximum concurrent streams.
 *
 * This value should match the Rust default in `thaumic-core/src/state.rs`.
 * Used as a fallback when the server's actual limit is unavailable.
 */
export const DEFAULT_MAX_CONCURRENT_STREAMS = 10;

// ─────────────────────────────────────────────────────────────────────────────
// Audio Codecs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Audio codecs supported by Sonos speakers.
 * This list includes all codecs that:
 * 1. Sonos speakers can play (per Sonos documentation)
 * 2. WebCodecs API can potentially encode
 *
 * Runtime detection filters this list to codecs the browser actually supports.
 *
 * - `pcm`: Raw PCM passthrough - wrapped in WAV container server-side for lossless streaming
 * - `aac-lc`: AAC Low Complexity (mp4a.40.2) - balanced quality
 * - `he-aac`: High-Efficiency AAC (mp4a.40.5) - best for low bitrates
 * - `he-aac-v2`: High-Efficiency AAC v2 (mp4a.40.29) - best for very low bitrates, stereo
 * - `flac`: Free Lossless Audio Codec - lossless compression (requires browser support)
 * - `vorbis`: Ogg Vorbis - open source lossy codec
 */
export const AudioCodecSchema = z.enum(['pcm', 'aac-lc', 'he-aac', 'he-aac-v2', 'flac', 'vorbis']);
export type AudioCodec = z.infer<typeof AudioCodecSchema>;

/**
 * Supported bitrates in kbps.
 * Not all bitrates are valid for all codecs - use `getValidBitrates()` to filter.
 * PCM uses 0 to indicate lossless (uncompressed).
 */
export const BitrateSchema = z.union([
  z.literal(0), // Lossless (PCM)
  z.literal(64),
  z.literal(96),
  z.literal(128),
  z.literal(160),
  z.literal(192),
  z.literal(256),
  z.literal(320),
]);
export type Bitrate = z.infer<typeof BitrateSchema>;

/** All valid bitrate values as a readonly array. */
export const ALL_BITRATES = [0, 64, 96, 128, 160, 192, 256, 320] as const;

/**
 * Sample rates supported by Sonos speakers.
 * Includes both 48kHz and 44.1kHz families.
 */
export const SUPPORTED_SAMPLE_RATES = [
  48000, 44100, 32000, 24000, 22050, 16000, 11025, 8000,
] as const;
export type SupportedSampleRate = (typeof SUPPORTED_SAMPLE_RATES)[number];

/**
 * Zod schema for supported sample rates.
 */
export const SampleRateSchema = z.union([
  z.literal(48000),
  z.literal(44100),
  z.literal(32000),
  z.literal(24000),
  z.literal(22050),
  z.literal(16000),
  z.literal(11025),
  z.literal(8000),
]);

/**
 * Checks if a sample rate is supported by Sonos.
 * @param rate - The sample rate to check
 * @returns True if the rate is supported
 */
export function isSupportedSampleRate(rate: number): rate is SupportedSampleRate {
  return SUPPORTED_SAMPLE_RATES.includes(rate as SupportedSampleRate);
}

/**
 * Latency mode for encoder operation.
 * - 'quality': Prioritize audio quality (default, best for music)
 * - 'realtime': Prioritize encoding speed, may sacrifice quality (for low-end devices)
 */
export const LatencyModeSchema = z.enum(['quality', 'realtime']);
export type LatencyMode = z.infer<typeof LatencyModeSchema>;

/**
 * Bit depths supported for audio encoding.
 * - 16: Standard CD quality, supported by all codecs
 * - 24: High-resolution audio, only supported by FLAC on Sonos S2 speakers
 */
export const BIT_DEPTHS = [16, 24] as const;
export type BitDepth = (typeof BIT_DEPTHS)[number];
export const BitDepthSchema = z.union([z.literal(16), z.literal(24)]);

/** Default bit depth for audio encoding. */
export const DEFAULT_BITS_PER_SAMPLE: BitDepth = 16;

/**
 * Audio sample scaling constants.
 * Used for converting between Float32 [-1.0, 1.0] and integer formats.
 */
export const INT16_MAX = 0x7fff; // 32767
export const INT24_MAX = 0x7fffff; // 8388607

/**
 * Clamps a Float32 audio sample to the valid range [-1.0, 1.0].
 *
 * Note: This function does NOT handle NaN - it assumes valid input.
 * For NaN-safe clamping, use: Math.max(-1, Math.min(1, s || 0))
 *
 * The pcm-processor.ts AudioWorklet uses an optimized, loop-unrolled,
 * NaN-safe version inline (AudioWorklet can't import modules).
 *
 * @param s - The sample value to clamp (must not be NaN)
 * @returns The clamped value
 */
export function clampSample(s: number): number {
  return Math.max(-1, Math.min(1, s));
}

/**
 * Generates TPDF (Triangular Probability Density Function) dither noise.
 *
 * Triangular distribution is achieved by summing two uniform random values.
 * The result has amplitude of ±1 LSB, which decorrelates quantization error
 * from the signal, converting harmonic distortion into benign white noise.
 *
 * Used during quantization from Float32 to Int16/Int24 to improve perceived
 * dynamic range, especially noticeable in quiet passages and fade-outs.
 *
 * @returns Dither value in the range [-1, 1] with triangular distribution
 */
export function tpdfDither(): number {
  return Math.random() - 0.5 + (Math.random() - 0.5);
}

/**
 * Streaming buffer size constraints and default (in milliseconds).
 * Used for PCM streaming to balance latency vs. reliability.
 */
export const STREAMING_BUFFER_MS_MIN = 100;
export const STREAMING_BUFFER_MS_MAX = 1000;
export const STREAMING_BUFFER_MS_DEFAULT = 200;

/**
 * Frame duration constraints and default (in milliseconds).
 * Affects backend cadence timing for silence injection.
 *
 * SYNC REQUIRED: These must match the Rust constants in:
 *   packages/thaumic-core/src/protocol_constants.rs
 *   - MIN_FRAME_DURATION_MS
 *   - MAX_FRAME_DURATION_MS
 *   - SILENCE_FRAME_DURATION_MS (default)
 *
 * Bounds are based on actual codec requirements:
 * - Min 5ms: reasonable for low-latency PCM
 * - Max 150ms: covers AAC at 8kHz (1024 samples = 128ms)
 */
export const FRAME_DURATION_MS_MIN = 5;
export const FRAME_DURATION_MS_MAX = 150;
export const FRAME_DURATION_MS_DEFAULT = 10;
