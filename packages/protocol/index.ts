import { z } from 'zod';

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
 * WAV uses 0 to indicate lossless (uncompressed).
 */
export const BitrateSchema = z.union([
  z.literal(0), // Lossless (WAV)
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
 * Streaming buffer size constraints and default (in milliseconds).
 * Used for WAV/PCM streaming to balance latency vs. reliability.
 */
export const STREAMING_BUFFER_MS_MIN = 100;
export const STREAMING_BUFFER_MS_MAX = 1000;
export const STREAMING_BUFFER_MS_DEFAULT = 200;

/**
 * Complete encoder configuration passed from UI to offscreen.
 */
export const EncoderConfigSchema = z.object({
  codec: AudioCodecSchema,
  bitrate: BitrateSchema,
  sampleRate: SampleRateSchema.default(48000),
  channels: z.union([z.literal(1), z.literal(2)]).default(2),
  latencyMode: LatencyModeSchema.default('quality'),
  /** Buffer size for WAV streaming in milliseconds. Only affects PCM codec. */
  streamingBufferMs: z
    .number()
    .min(STREAMING_BUFFER_MS_MIN)
    .max(STREAMING_BUFFER_MS_MAX)
    .default(STREAMING_BUFFER_MS_DEFAULT),
});
export type EncoderConfig = z.infer<typeof EncoderConfigSchema>;

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
    label: 'WAV',
    description: 'Uncompressed lossless audio',
    validBitrates: [] as const,
    defaultBitrate: 0, // 0 indicates lossless/variable bitrate
    webCodecsId: null, // No WebCodecs - raw PCM passthrough
    efficiency: 10.0, // Lossless - uncompressed
  },
  'aac-lc': {
    label: 'AAC-LC',
    description: 'Balanced quality and efficiency',
    validBitrates: [128, 192, 256] as const,
    defaultBitrate: 192,
    webCodecsId: 'mp4a.40.2',
    efficiency: 1.0, // Baseline
  },
  'he-aac': {
    label: 'HE-AAC',
    description: 'High efficiency, best for low bandwidth',
    validBitrates: [64, 96, 128] as const,
    defaultBitrate: 96,
    webCodecsId: 'mp4a.40.5',
    efficiency: 1.5, // ~50% more efficient than AAC-LC
  },
  'he-aac-v2': {
    label: 'HE-AAC v2',
    description: 'Best for very low bandwidth stereo',
    validBitrates: [64, 96] as const,
    defaultBitrate: 64,
    webCodecsId: 'mp4a.40.29',
    efficiency: 2.0, // ~100% more efficient (uses Parametric Stereo)
  },
  flac: {
    label: 'FLAC',
    description: 'Lossless audio, highest quality',
    validBitrates: [0] as const,
    defaultBitrate: 0,
    webCodecsId: 'flac',
    efficiency: 10.0, // Lossless - highest possible quality
  },
  vorbis: {
    label: 'Ogg Vorbis',
    description: 'Open source, good quality',
    validBitrates: [128, 160, 192, 256, 320] as const,
    defaultBitrate: 192,
    webCodecsId: 'vorbis',
    efficiency: 1.1, // Slightly better than AAC-LC
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
 * Options for creating an encoder configuration.
 */
export interface CreateEncoderConfigOptions {
  codec: AudioCodec;
  bitrate?: Bitrate;
  sampleRate?: SupportedSampleRate;
  channels?: 1 | 2;
  latencyMode?: LatencyMode;
  /** Buffer size for WAV streaming in milliseconds (100-1000). Only affects PCM codec. */
  streamingBufferMs?: number;
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
    latencyMode = 'quality',
    streamingBufferMs = STREAMING_BUFFER_MS_DEFAULT,
  } = options;
  const effectiveBitrate =
    bitrate && isValidBitrateForCodec(codec, bitrate) ? bitrate : getDefaultBitrate(codec);

  return {
    codec,
    bitrate: effectiveBitrate,
    sampleRate,
    channels,
    latencyMode,
    streamingBufferMs,
  };
}

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

/**
 * High-level quality presets for the user interface.
 */
export const QualityPresetSchema = z.enum(['instant', 'balanced', 'efficient']);
export type QualityPreset = z.infer<typeof QualityPresetSchema>;

/**
 * Track-level metadata for display on Sonos devices.
 */
export const StreamMetadataSchema = z.object({
  title: z.string().optional(),
  artist: z.string().optional(),
  album: z.string().optional(),
  artwork: z.string().optional(),
  /** Source name derived from tab URL (e.g., "YouTube", "Spotify") */
  source: z.string().optional(),
});
export type StreamMetadata = z.infer<typeof StreamMetadataSchema>;

/**
 * Configuration parameters for initializing an audio stream session.
 */
export const StreamConfigSchema = z.object({
  streamId: z.string().uuid(),
  tabId: z.number().int().positive(),
  groupId: z.string(),
  encoderConfig: EncoderConfigSchema,
});
export type StreamConfig = z.infer<typeof StreamConfigSchema>;

/**
 * Current runtime status of an active cast session.
 */
export const CastStatusSchema = z.object({
  isActive: z.boolean(),
  streamId: z.string().uuid().optional(),
  tabId: z.number().int().positive().optional(),
  groupId: z.string().optional(),
  groupName: z.string().optional(),
  coordinatorIp: z.string().optional(),
  encoderConfig: EncoderConfigSchema.optional(),
  startedAt: z.number().int().positive().optional(),
});
export type CastStatus = z.infer<typeof CastStatusSchema>;

/**
 * WebSocket Message Payloads
 */
export const WsHandshakePayloadSchema = z.object({
  encoderConfig: EncoderConfigSchema,
});
export type WsHandshakePayload = z.infer<typeof WsHandshakePayloadSchema>;

export const WsHandshakeAckPayloadSchema = z.object({
  streamId: z.string(),
});
export type WsHandshakeAckPayload = z.infer<typeof WsHandshakeAckPayloadSchema>;

export const WsErrorPayloadSchema = z.object({
  message: z.string(),
});
export type WsErrorPayload = z.infer<typeof WsErrorPayloadSchema>;

/**
 * WebSocket Message Types
 */
export const WsMessageTypeSchema = z.enum([
  'HANDSHAKE',
  'HANDSHAKE_ACK',
  'HEARTBEAT',
  'HEARTBEAT_ACK',
  'STOP_STREAM',
  'METADATA_UPDATE',
  'ERROR',
  // Stream lifecycle messages
  'STREAM_READY',
  'START_PLAYBACK',
  'PLAYBACK_STARTED',
  'PLAYBACK_ERROR',
]);
export type WsMessageType = z.infer<typeof WsMessageTypeSchema>;

/**
 * Individual WebSocket message schemas for discriminated union.
 */
export const WsHandshakeMessageSchema = z.object({
  type: z.literal('HANDSHAKE'),
  payload: WsHandshakePayloadSchema,
});
export type WsHandshakeMessage = z.infer<typeof WsHandshakeMessageSchema>;

export const WsHandshakeAckMessageSchema = z.object({
  type: z.literal('HANDSHAKE_ACK'),
  payload: WsHandshakeAckPayloadSchema,
});
export type WsHandshakeAckMessage = z.infer<typeof WsHandshakeAckMessageSchema>;

export const WsHeartbeatMessageSchema = z.object({
  type: z.literal('HEARTBEAT'),
});
export type WsHeartbeatMessage = z.infer<typeof WsHeartbeatMessageSchema>;

export const WsHeartbeatAckMessageSchema = z.object({
  type: z.literal('HEARTBEAT_ACK'),
});
export type WsHeartbeatAckMessage = z.infer<typeof WsHeartbeatAckMessageSchema>;

export const WsStopStreamMessageSchema = z.object({
  type: z.literal('STOP_STREAM'),
});
export type WsStopStreamMessage = z.infer<typeof WsStopStreamMessageSchema>;

export const WsMetadataUpdateMessageSchema = z.object({
  type: z.literal('METADATA_UPDATE'),
  payload: StreamMetadataSchema,
});
export type WsMetadataUpdateMessage = z.infer<typeof WsMetadataUpdateMessageSchema>;

export const WsErrorMessageSchema = z.object({
  type: z.literal('ERROR'),
  payload: WsErrorPayloadSchema,
});
export type WsErrorMessage = z.infer<typeof WsErrorMessageSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Stream Lifecycle Messages
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sent by server when the stream has received its first audio frame
 * and is ready for playback. Client should wait for this before
 * requesting playback to avoid race conditions.
 */
export const WsStreamReadyPayloadSchema = z.object({
  /** Number of frames currently buffered. */
  bufferSize: z.number().int().nonnegative(),
});
export type WsStreamReadyPayload = z.infer<typeof WsStreamReadyPayloadSchema>;

export const WsStreamReadyMessageSchema = z.object({
  type: z.literal('STREAM_READY'),
  payload: WsStreamReadyPayloadSchema,
});
export type WsStreamReadyMessage = z.infer<typeof WsStreamReadyMessageSchema>;

/**
 * Sent by client to request playback on a Sonos speaker.
 * Must be sent after receiving STREAM_READY.
 */
export const WsStartPlaybackPayloadSchema = z.object({
  /** IP address of the Sonos speaker/coordinator. */
  speakerIp: z.string(),
});
export type WsStartPlaybackPayload = z.infer<typeof WsStartPlaybackPayloadSchema>;

export const WsStartPlaybackMessageSchema = z.object({
  type: z.literal('START_PLAYBACK'),
  payload: WsStartPlaybackPayloadSchema,
});
export type WsStartPlaybackMessage = z.infer<typeof WsStartPlaybackMessageSchema>;

/**
 * Sent by server when playback has successfully started on the speaker.
 */
export const WsPlaybackStartedPayloadSchema = z.object({
  /** IP address of the speaker that started playback. */
  speakerIp: z.string(),
  /** The stream URL being played. */
  streamUrl: z.string(),
});
export type WsPlaybackStartedPayload = z.infer<typeof WsPlaybackStartedPayloadSchema>;

export const WsPlaybackStartedMessageSchema = z.object({
  type: z.literal('PLAYBACK_STARTED'),
  payload: WsPlaybackStartedPayloadSchema,
});
export type WsPlaybackStartedMessage = z.infer<typeof WsPlaybackStartedMessageSchema>;

/**
 * Sent by server when playback failed to start.
 */
export const WsPlaybackErrorPayloadSchema = z.object({
  /** Error message describing the failure. */
  message: z.string(),
});
export type WsPlaybackErrorPayload = z.infer<typeof WsPlaybackErrorPayloadSchema>;

export const WsPlaybackErrorMessageSchema = z.object({
  type: z.literal('PLAYBACK_ERROR'),
  payload: WsPlaybackErrorPayloadSchema,
});
export type WsPlaybackErrorMessage = z.infer<typeof WsPlaybackErrorMessageSchema>;

/**
 * Payload for multi-group playback results message.
 * Contains per-speaker success/failure information.
 */
export const WsPlaybackResultsPayloadSchema = z.object({
  results: z.array(
    z.object({
      speakerIp: z.string(),
      success: z.boolean(),
      streamUrl: z.string().optional(),
      error: z.string().optional(),
    }),
  ),
});
export type WsPlaybackResultsPayload = z.infer<typeof WsPlaybackResultsPayloadSchema>;

export const WsPlaybackResultsMessageSchema = z.object({
  type: z.literal('PLAYBACK_RESULTS'),
  payload: WsPlaybackResultsPayloadSchema,
});
export type WsPlaybackResultsMessage = z.infer<typeof WsPlaybackResultsMessageSchema>;

/**
 * Discriminated union for all WebSocket messages with typed payloads.
 */
export const WsMessageSchema = z.discriminatedUnion('type', [
  WsHandshakeMessageSchema,
  WsHandshakeAckMessageSchema,
  WsHeartbeatMessageSchema,
  WsHeartbeatAckMessageSchema,
  WsStopStreamMessageSchema,
  WsMetadataUpdateMessageSchema,
  WsErrorMessageSchema,
  // Stream lifecycle
  WsStreamReadyMessageSchema,
  WsStartPlaybackMessageSchema,
  WsPlaybackStartedMessageSchema,
  WsPlaybackResultsMessageSchema,
  WsPlaybackErrorMessageSchema,
]);
export type WsMessage = z.infer<typeof WsMessageSchema>;

/**
 * Sonos Transport States.
 * These match the UPnP AVTransport states from Sonos.
 */
export const TransportStateSchema = z.enum([
  'Playing',
  'PAUSED_PLAYBACK',
  'Stopped',
  'Transitioning',
]);
export type TransportState = z.infer<typeof TransportStateSchema>;

/**
 * User-friendly transport state labels for UI display.
 */
export const TRANSPORT_STATE_LABELS: Record<TransportState, string> = {
  Playing: 'Playing',
  PAUSED_PLAYBACK: 'Paused',
  Stopped: 'Stopped',
  Transitioning: 'Loading',
} as const;

/**
 * Lucide icon names for each transport state.
 */
export const TRANSPORT_STATE_ICONS: Record<TransportState, string> = {
  Playing: 'play',
  PAUSED_PLAYBACK: 'pause',
  Stopped: 'square',
  Transitioning: 'loader',
} as const;

/**
 * A member of a Sonos zone group.
 */
export const ZoneGroupMemberSchema = z.object({
  uuid: z.string(),
  ip: z.string(),
  zoneName: z.string(),
  model: z.string().optional(),
});
export type ZoneGroupMember = z.infer<typeof ZoneGroupMemberSchema>;

/**
 * A Sonos zone group (one or more speakers playing in sync).
 */
export const ZoneGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  coordinatorUuid: z.string(),
  coordinatorIp: z.string(),
  members: z.array(ZoneGroupMemberSchema),
});
export type ZoneGroup = z.infer<typeof ZoneGroupSchema>;

/**
 * Active playback session linking a stream to a speaker.
 */
export const PlaybackSessionSchema = z.object({
  streamId: z.string(),
  speakerIp: z.string(),
  streamUrl: z.string(),
});
export type PlaybackSession = z.infer<typeof PlaybackSessionSchema>;

/**
 * Complete Sonos state snapshot sent on WebSocket connect.
 */
export const SonosStateSnapshotSchema = z.object({
  groups: z.array(ZoneGroupSchema),
  transportStates: z.record(z.string(), TransportStateSchema),
  groupVolumes: z.record(z.string(), z.number()),
  groupMutes: z.record(z.string(), z.boolean()),
  sessions: z.array(PlaybackSessionSchema).optional(),
});
export type SonosStateSnapshot = z.infer<typeof SonosStateSnapshotSchema>;

/**
 * Creates an empty Sonos state snapshot.
 * Used for initialization before receiving state from desktop.
 * @returns An empty SonosStateSnapshot
 */
export function createEmptySonosState(): SonosStateSnapshot {
  return {
    groups: [],
    groupVolumes: {},
    groupMutes: {},
    transportStates: {},
  };
}

/**
 * Initial state message sent by desktop on WebSocket connect.
 * Includes Sonos state.
 */
export const InitialStatePayloadSchema = z.object({
  groups: z.array(ZoneGroupSchema),
  transportStates: z.record(z.string(), TransportStateSchema),
  groupVolumes: z.record(z.string(), z.number()),
  groupMutes: z.record(z.string(), z.boolean()),
  sessions: z.array(PlaybackSessionSchema).optional(),
});
export type InitialStatePayload = z.infer<typeof InitialStatePayloadSchema>;

/**
 * Parses and validates a Sonos event from a raw payload.
 * @param data - The raw event data to parse
 * @returns A validated SonosEvent or null if invalid
 */
export function parseSonosEvent(data: unknown): SonosEvent | null {
  const result = SonosEventSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Gets a human-readable status string for a speaker.
 * Used in the speaker dropdown to show current state.
 * @param speakerIp - The speaker IP address
 * @param state - The current Sonos state snapshot
 * @returns The status label or undefined if no state available
 */
export function getSpeakerStatus(speakerIp: string, state: SonosStateSnapshot): string | undefined {
  const transport = state.transportStates[speakerIp];
  if (!transport) return undefined;
  return TRANSPORT_STATE_LABELS[transport];
}

/**
 * Checks if a speaker is currently playing.
 * @param speakerIp - The speaker IP address
 * @param state - The current Sonos state snapshot
 * @returns True if the speaker is in Playing state
 */
export function isSpeakerPlaying(speakerIp: string, state: SonosStateSnapshot): boolean {
  return state.transportStates[speakerIp] === 'Playing';
}

/**
 * Speaker availability status for UI display.
 * Indicates whether a speaker is available, in use by another source, or casting from Thaumic Cast.
 */
export type SpeakerAvailability = 'available' | 'in_use' | 'casting';

/**
 * User-friendly labels for speaker availability status.
 */
export const SPEAKER_AVAILABILITY_LABELS: Record<SpeakerAvailability, string> = {
  available: 'Available',
  in_use: 'In Use',
  casting: 'Casting',
} as const;

/**
 * Determines speaker availability considering both transport state and active casts.
 * @param speakerIp - The speaker IP address
 * @param state - The current Sonos state snapshot
 * @param castingSpeakerIps - Array of speaker IPs with active Thaumic Cast sessions
 * @returns The speaker's availability status
 */
export function getSpeakerAvailability(
  speakerIp: string,
  state: SonosStateSnapshot,
  castingSpeakerIps: string[],
): SpeakerAvailability {
  // Check if this speaker has an active Thaumic Cast session
  if (castingSpeakerIps.includes(speakerIp)) return 'casting';

  // Check if playing from another source
  const transport = state.transportStates[speakerIp];
  if (transport === 'Playing') return 'in_use';

  // Otherwise available (stopped, paused, or unknown state)
  return 'available';
}

/**
 * Initial state message sent by desktop on WebSocket connect.
 */
export const WsInitialStateMessageSchema = z.object({
  type: z.literal('INITIAL_STATE'),
  payload: InitialStatePayloadSchema,
});
export type WsInitialStateMessage = z.infer<typeof WsInitialStateMessageSchema>;

/**
 * Sonos event types broadcast by desktop app.
 */
export const SonosEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('transportState'),
    speakerIp: z.string(),
    state: TransportStateSchema,
    currentUri: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('groupVolume'),
    speakerIp: z.string(),
    volume: z.number(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('groupMute'),
    speakerIp: z.string(),
    muted: z.boolean(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('sourceChanged'),
    speakerIp: z.string(),
    currentUri: z.string(),
    expectedUri: z.string().optional(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('zoneGroupsUpdated'),
    groups: z.array(ZoneGroupSchema),
    timestamp: z.number(),
  }),
]);
export type SonosEvent = z.infer<typeof SonosEventSchema>;

/**
 * Stream event types broadcast by desktop app.
 */
export const StreamEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('created'),
    streamId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('ended'),
    streamId: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('playbackStarted'),
    streamId: z.string(),
    speakerIp: z.string(),
    streamUrl: z.string(),
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('playbackStopped'),
    streamId: z.string(),
    speakerIp: z.string(),
    timestamp: z.number(),
  }),
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

/**
 * Latency event types broadcast by desktop app.
 * Used for measuring audio playback delay from source to Sonos speaker.
 *
 * Events include epochId for deterministic state machine transitions:
 * - Epoch changes when Sonos reconnects to the stream
 * - Extension should re-lock sync when epochId changes
 */
export const LatencyEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('updated'),
    /** ID of the stream being measured */
    streamId: z.string(),
    /** IP address of the speaker being monitored */
    speakerIp: z.string(),
    /** Playback epoch ID (increments on Sonos reconnect) */
    epochId: z.number().int().nonnegative(),
    /** Measured latency in milliseconds (EMA-smoothed) */
    latencyMs: z.number().int().nonnegative(),
    /** Measurement jitter in milliseconds (standard deviation) */
    jitterMs: z.number().int().nonnegative(),
    /** Confidence score from 0.0 to 1.0 (higher = more reliable) */
    confidence: z.number().min(0).max(1),
    /** Unix timestamp in milliseconds */
    timestamp: z.number(),
  }),
  z.object({
    type: z.literal('stale'),
    /** ID of the stream that went stale */
    streamId: z.string(),
    /** IP address of the speaker that went stale */
    speakerIp: z.string(),
    /** Epoch ID that went stale (helps detect reconnects) */
    epochId: z.number().int().nonnegative(),
    /** Unix timestamp in milliseconds */
    timestamp: z.number(),
  }),
]);
export type LatencyEvent = z.infer<typeof LatencyEventSchema>;

/**
 * Broadcast event wrapper from desktop app.
 * Uses passthrough to allow the nested event fields.
 */
export const BroadcastEventSchema = z.union([
  z.object({ category: z.literal('sonos') }).passthrough(),
  z.object({ category: z.literal('stream') }).passthrough(),
  z.object({ category: z.literal('latency') }).passthrough(),
]);

/**
 * Typed broadcast event (use type guards to narrow).
 */
export interface SonosBroadcastEvent {
  category: 'sonos';
  type: SonosEvent['type'];
  [key: string]: unknown;
}

export interface StreamBroadcastEvent {
  category: 'stream';
  type: StreamEvent['type'];
  [key: string]: unknown;
}

export interface LatencyUpdatedBroadcastEvent {
  category: 'latency';
  type: 'updated';
  streamId: string;
  speakerIp: string;
  epochId: number;
  latencyMs: number;
  jitterMs: number;
  confidence: number;
  timestamp: number;
}

export interface LatencyStaleBroadcastEvent {
  category: 'latency';
  type: 'stale';
  streamId: string;
  speakerIp: string;
  epochId: number;
  timestamp: number;
}

export type LatencyBroadcastEvent = LatencyUpdatedBroadcastEvent | LatencyStaleBroadcastEvent;

export type BroadcastEvent = SonosBroadcastEvent | StreamBroadcastEvent | LatencyBroadcastEvent;

// ─────────────────────────────────────────────────────────────────────────────
// Media Metadata Types (for tab-level metadata display)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Supported media control actions from the MediaSession API.
 * These map directly to MediaSessionAction values.
 */
export const MediaActionSchema = z.enum(['play', 'pause', 'nexttrack', 'previoustrack']);
export type MediaAction = z.infer<typeof MediaActionSchema>;

/**
 * Playback state from MediaSession API.
 * Maps directly to MediaSessionPlaybackState values.
 */
export const PlaybackStateSchema = z.enum(['none', 'paused', 'playing']);
export type PlaybackState = z.infer<typeof PlaybackStateSchema>;

/**
 * Media metadata captured from the Web MediaSession API.
 * This is the canonical shape used for displaying track info.
 * Title is required; other fields are optional.
 */
export const MediaMetadataSchema = z.object({
  /** Track title (required) */
  title: z.string().min(1),
  /** Artist name */
  artist: z.string().optional(),
  /** Album name */
  album: z.string().optional(),
  /** Artwork URL (largest available) */
  artwork: z.string().url().optional(),
});
export type MediaMetadata = z.infer<typeof MediaMetadataSchema>;

/**
 * Validates and parses raw metadata into MediaMetadata.
 * Returns null if title is missing or invalid.
 * @param data - Raw metadata object to parse
 * @returns Validated MediaMetadata or null if invalid
 */
export function parseMediaMetadata(data: unknown): MediaMetadata | null {
  const result = MediaMetadataSchema.safeParse(data);
  return result.success ? result.data : null;
}

/**
 * Complete media state for a browser tab.
 * Combines metadata with tab identification for display.
 */
export const TabMediaStateSchema = z.object({
  /** Chrome tab ID */
  tabId: z.number().int().positive(),
  /** Tab title (fallback when no metadata) */
  tabTitle: z.string(),
  /** Tab favicon URL */
  tabFavicon: z.string().optional(),
  /** Tab Open Graph image URL (og:image meta tag) */
  tabOgImage: z.string().optional(),
  /** Source name derived from tab URL (e.g., "YouTube", "Spotify") */
  source: z.string().optional(),
  /** Media metadata if available */
  metadata: MediaMetadataSchema.nullable(),
  /** Supported media actions (play, pause, next, previous) */
  supportedActions: z.array(MediaActionSchema).default([]),
  /** Current playback state from MediaSession */
  playbackState: PlaybackStateSchema.default('none'),
  /** Timestamp when this state was last updated */
  updatedAt: z.number(),
});
export type TabMediaState = z.infer<typeof TabMediaStateSchema>;

/**
 * Creates a TabMediaState with defaults.
 * @param tab - Tab information from Chrome API
 * @param tab.id
 * @param tab.title
 * @param tab.favIconUrl
 * @param tab.ogImage - Open Graph image URL
 * @param tab.source - Source name derived from tab URL
 * @param metadata - Optional media metadata
 * @param supportedActions - Optional array of supported media actions
 * @param playbackState - Optional playback state from MediaSession
 * @returns A new TabMediaState object
 */
export function createTabMediaState(
  tab: { id: number; title?: string; favIconUrl?: string; ogImage?: string; source?: string },
  metadata: MediaMetadata | null = null,
  supportedActions: MediaAction[] = [],
  playbackState: PlaybackState = 'none',
): TabMediaState {
  return {
    tabId: tab.id,
    tabTitle: tab.title || 'Unknown Tab',
    tabFavicon: tab.favIconUrl,
    tabOgImage: tab.ogImage,
    source: tab.source,
    metadata,
    supportedActions,
    playbackState,
    updatedAt: Date.now(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Multi-Group Playback Types
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Result of starting playback on a single speaker.
 * Used for reporting per-speaker success/failure in multi-group casting.
 */
export const PlaybackResultSchema = z.object({
  /** IP address of the speaker */
  speakerIp: z.string(),
  /** Whether playback started successfully */
  success: z.boolean(),
  /** Stream URL the speaker is fetching (on success) */
  streamUrl: z.string().optional(),
  /** Error message (on failure) */
  error: z.string().optional(),
});
export type PlaybackResult = z.infer<typeof PlaybackResultSchema>;

/**
 * An active cast session with its current state.
 * Used for displaying in the popup's active casts list.
 * Supports multi-group casting (one stream to multiple speaker groups).
 */
export const ActiveCastSchema = z.object({
  /** Unique stream ID from server */
  streamId: z.string(),
  /** Tab ID being captured */
  tabId: z.number().int().positive(),
  /** Current media state (includes metadata) */
  mediaState: TabMediaStateSchema,
  /** Target speaker IP addresses (multi-group support) */
  speakerIps: z.array(z.string()),
  /** Speaker/group display names (parallel array with speakerIps) */
  speakerNames: z.array(z.string()),
  /** Encoder configuration used for this cast */
  encoderConfig: EncoderConfigSchema,
  /** Timestamp when cast started */
  startedAt: z.number(),
});
export type ActiveCast = z.infer<typeof ActiveCastSchema>;

// ─────────────────────────────────────────────────────────────────────────────
// Display Helpers (DRY - single source of truth for display logic)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Gets the display title from media state.
 * Prefers metadata title, falls back to tab title.
 * @param state - The tab media state
 * @returns The title to display
 */
export function getDisplayTitle(state: TabMediaState): string {
  return state.metadata?.title || state.tabTitle;
}

/**
 * Gets the display image from media state.
 * Prefers artwork, falls back to og:image, then favicon.
 * @param state - The tab media state
 * @returns The image URL to display, or undefined if none available
 */
export function getDisplayImage(state: TabMediaState): string | undefined {
  return state.metadata?.artwork || state.tabOgImage || state.tabFavicon;
}

/**
 * Gets the display subtitle from media state.
 * Returns artist/album string or undefined if no artist.
 * @param state - The tab media state
 * @returns The subtitle to display, or undefined if no artist
 */
export function getDisplaySubtitle(state: TabMediaState): string | undefined {
  const { metadata } = state;
  if (!metadata?.artist) return undefined;
  return metadata.album ? `${metadata.artist} • ${metadata.album}` : metadata.artist;
}

// ─────────────────────────────────────────────────────────────────────────────
// Video Sync Types (for A/V delay compensation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single latency sample for the stability gate.
 */
export interface LatencySample {
  latencyMs: number;
  jitterMs: number;
  confidence: number;
  /** Timestamp when sample was received (performance.now()) */
  tMs: number;
}

/**
 * Rolling window of latency samples for stability detection.
 */
export interface SampleWindow {
  buf: LatencySample[];
  /** Maximum samples to keep */
  max: number;
}

/**
 * Video sync state machine states.
 *
 * State transitions:
 * - NoData → Acquiring (on first Updated event)
 * - Acquiring → Locked (when stability gate passes)
 * - Locked → Stale (on Stale event)
 * - Stale → Acquiring (on Updated event, same or different epoch)
 * - Any → Acquiring (on epoch change)
 */
export type VideoSyncState =
  | { kind: 'NoData' }
  | {
      kind: 'Acquiring';
      epochId: number;
      samples: SampleWindow;
    }
  | {
      kind: 'Locked';
      epochId: number;
      /** Rolling sample window for windowed median (slew target) */
      samples: SampleWindow;
      /** Locked latency value in ms (used for video delay) */
      lockedLatencyMs: number;
      /** User-adjustable trim in ms (positive = more delay) */
      userTrimMs: number;
      /** performance.now() when lock was established */
      lockNowMs: number;
      /** video.currentTime when lock was established */
      lockVideoTime: number;
      /** Control mode: 'rate' for playbackRate, 'pause' for micro-pauses */
      rateMode: 'rate' | 'pause';
    }
  | {
      kind: 'Stale';
      epochId: number;
      /** Last known latency (preserved for UI display) */
      lockedLatencyMs: number;
      /** User trim preserved across stale */
      userTrimMs: number;
      /** When stale was detected (performance.now()) */
      sinceMs: number;
    };

/**
 * Constants for the video sync stability gate.
 */
export const VIDEO_SYNC_CONSTANTS = {
  /** Minimum confidence required for each sample */
  MIN_CONFIDENCE: 0.7,
  /** Maximum jitter (ms) allowed for each sample */
  MAX_JITTER_MS: 120,
  /** Maximum deviation from median (ms) for stability */
  MAX_MEDIAN_DEVIATION_MS: 80,
  /** Number of samples required to pass stability gate */
  REQUIRED_SAMPLES: 5,
  /** Deadband for locked state - ignore changes smaller than this */
  LOCK_DEADBAND_MS: 80,
  /** Maximum slew rate when adjusting locked latency (ms per second) */
  SLEW_RATE_MS_PER_SEC: 20,
  /** Deadband for video sync error (seconds) */
  ERROR_DEADBAND_SEC: 0.12,
  /** Hard error threshold for seek/pause (seconds) */
  HARD_ERROR_THRESHOLD_SEC: 1.0,
  /** Maximum micro-pause duration (ms) */
  MAX_MICRO_PAUSE_MS: 250,
  /** Maximum playback rate adjustment (±5%) */
  MAX_RATE_ADJUSTMENT: 0.05,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Control Commands (extension → desktop)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Control commands sent from extension to desktop app via WebSocket.
 * Must match the Rust `WsIncoming` enum format (SCREAMING_SNAKE_CASE type tag).
 */
export type WsControlCommand =
  | { type: 'SET_VOLUME'; payload: { ip: string; volume: number } }
  | { type: 'SET_MUTE'; payload: { ip: string; mute: boolean } }
  | { type: 'GET_VOLUME'; payload: { ip: string } }
  | { type: 'GET_MUTE'; payload: { ip: string } };

// ─────────────────────────────────────────────────────────────────────────────
// Video Sync Status (for popup display)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Video sync status for popup display.
 * Represents the current state of per-cast video sync.
 */
export interface VideoSyncStatus {
  /** Whether video sync is enabled for this cast */
  enabled: boolean;
  /** User trim adjustment in milliseconds */
  trimMs: number;
  /** Current sync state */
  state: 'off' | 'acquiring' | 'locked' | 'stale';
  /** Locked latency in ms (only when state is 'locked') */
  lockedLatencyMs?: number;
}
