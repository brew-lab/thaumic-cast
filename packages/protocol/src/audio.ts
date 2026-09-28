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
 * Pre-computed TPDF dither noise table.
 *
 * Using a lookup table is ~10-20x faster than calling Math.random() per sample.
 * At 48kHz stereo, the hot loop calls tpdfDither() 96,000 times/sec, making
 * Math.random() a significant bottleneck (it uses a CSPRNG internally).
 *
 * 4096 samples is large enough to avoid audible periodicity while remaining
 * cache-friendly. The values are pre-computed once at module load using the
 * same triangular distribution algorithm.
 */
const DITHER_TABLE_SIZE = 4096;
const DITHER_TABLE = new Float32Array(DITHER_TABLE_SIZE);
for (let i = 0; i < DITHER_TABLE_SIZE; i++) {
  DITHER_TABLE[i] = Math.random() - 0.5 + (Math.random() - 0.5);
}
let ditherIndex = 0;

/**
 * Generates TPDF (Triangular Probability Density Function) dither noise.
 *
 * Uses a pre-computed noise table for performance. Triangular distribution
 * decorrelates quantization error from the signal, converting harmonic
 * distortion into benign white noise.
 *
 * Used during quantization from Float32 to Int16/Int24 to improve perceived
 * dynamic range, especially noticeable in quiet passages and fade-outs.
 *
 * @returns Dither value in the range [-1, 1] with triangular distribution
 */
export function tpdfDither(): number {
  const value = DITHER_TABLE[ditherIndex]!;
  ditherIndex = (ditherIndex + 1) & (DITHER_TABLE_SIZE - 1);
  return value;
}

/**
 * Jitter buffer size constraints and default (in milliseconds).
 * Used for PCM streaming to balance latency vs. reliability.
 */
export const JITTER_BUFFER_MS_MIN = 100;
export const JITTER_BUFFER_MS_MAX = 1000;
export const JITTER_BUFFER_MS_DEFAULT = 200;

/**
 * Default smoothing for PCM streams, in milliseconds: how much audio the
 * companion holds back to even out delivery from the browser. Sent on the wire
 * as `jitterBufferMs`.
 */
export const PCM_SMOOTHING_DEFAULT_MS = 200;

/**
 * Smoothing steps the extension offers, in milliseconds. The wire accepts any
 * value from {@link JITTER_BUFFER_MS_MIN} to {@link JITTER_BUFFER_MS_MAX}.
 */
export const PCM_SMOOTHING_OPTIONS = [100, 200, 300, 500] as const;

/** A smoothing step the extension offers, in milliseconds. */
export type PcmSmoothingMs = (typeof PCM_SMOOTHING_OPTIONS)[number];

/**
 * Zod schema for a smoothing step the extension offers.
 */
export const PcmSmoothingMsSchema = z.union([
  z.literal(100),
  z.literal(200),
  z.literal(300),
  z.literal(500),
]);

/**
 * Frame duration options (in milliseconds).
 * Controls how audio is chunked for streaming:
 * - 10ms: Low latency, higher CPU overhead (default)
 * - 20ms: Balanced latency and efficiency
 * - 40ms: More stable on slower networks/devices, higher latency
 *
 * Currently only configurable for PCM. Other codecs have fixed frame sizes
 * dictated by codec specifications (e.g., AAC uses 1024 samples).
 */
export const FRAME_DURATION_MS_MIN = 10;
export const FRAME_DURATION_MS_MAX = 40;
export const FRAME_DURATION_MS_DEFAULT = 10;

/**
 * Valid frame duration values in milliseconds.
 */
export const FRAME_DURATIONS = [10, 20, 40] as const;
export type FrameDurationMs = (typeof FRAME_DURATIONS)[number];

/**
 * Zod schema for frame duration.
 */
export const FrameDurationMsSchema = z.union([z.literal(10), z.literal(20), z.literal(40)]);

/**
 * Frame size constraints (in samples per channel).
 * Used to derive exact frame duration without floating-point rounding.
 * Server computes: duration_ms = samples * 1000 / sample_rate
 *
 * SYNC REQUIRED: These must match the Rust constants in:
 *   packages/thaumic-core/src/protocol_constants.rs
 *
 * Bounds are based on codec frame sizes:
 * - Min 64: ~1.3ms at 48kHz (reasonable minimum)
 * - Max 8192: ~170ms at 48kHz (covers all codec frame sizes)
 */
export const FRAME_SIZE_SAMPLES_MIN = 64;
export const FRAME_SIZE_SAMPLES_MAX = 8192;

// ─────────────────────────────────────────────────────────────────────────────
// Companion Audio Settings
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Largest speaker head start (PCM connect burst) the companion accepts, in ms.
 *
 * SYNC REQUIRED: must match `MAX_PCM_CONNECT_BURST_MS` in
 *   packages/thaumic-core/src/protocol_constants.rs
 */
export const HEAD_START_MS_MAX = 2000;

/**
 * The companion's speaker-side audio settings, for display and for the wording
 * of speaker notices. The companion owns them: clients only show them. Sent in
 * `INITIAL_STATE` as `companionAudio` and again in a `companionAudioChanged`
 * stream event whenever one changes. Each applies from a speaker's next
 * connection.
 */
export const CompanionAudioSchema = z.object({
  /** Speaker head start sent to each speaker when it connects, in ms. `0` is off. */
  headStartMs: z.number().int().min(0).max(HEAD_START_MS_MAX),
  /** Whether an environment variable fixes the head start, so only it can change it. */
  headStartFixed: z.boolean(),
  /** Whether the speaker monitor, and with it speaker notices, is on. */
  speakerMonitor: z.boolean(),
  /**
   * Clock drift correction mode. Absent from companions without drift
   * correction; degraded to `undefined` for a mode this build does not know.
   */
  driftCompensation: z.enum(['on', 'observe', 'off']).optional().catch(undefined),
});
export type CompanionAudio = z.infer<typeof CompanionAudioSchema>;
