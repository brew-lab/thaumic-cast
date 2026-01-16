import type { EncoderConfig } from '@thaumic-cast/protocol';
import { CODEC_METADATA } from '@thaumic-cast/protocol';
import { BaseAudioEncoder, type ChromeAudioEncoderConfig } from './base-encoder';
import type { LatencyMode } from './types';

/**
 * ADTS (Audio Data Transport Stream) frame header constants.
 * ADTS provides framing for AAC audio, enabling streaming without container formats.
 * See ISO/IEC 13818-7 for full specification.
 */
const ADTS = {
  /** AAC-LC profile identifier (Low Complexity) */
  PROFILE_AAC_LC: 1,
  /** HE-AAC profile identifier (High Efficiency, uses SBR) */
  PROFILE_HE_AAC: 4,
  /** Sync word byte 0: always 0xFF */
  SYNC_BYTE_0: 0xff,
  /** Sync word byte 1: 0xF1 = sync(4) + MPEG-4(1) + Layer(2) + no CRC(1) */
  SYNC_BYTE_1: 0xf1,
  /** VBR indicator for buffer fullness field (5 bits, all 1s = 0x1F) */
  BUFFER_FULLNESS_VBR_5BIT: 0x1f,
  /** Byte 6: VBR fullness end (6 bits = 0x3F << 2) + 1 frame (0b00) = 0xFC */
  BYTE_6_VBR_ONE_FRAME: 0xfc,
} as const;

/**
 * Sample rate index table for ADTS header.
 */
const SAMPLE_RATE_INDEX: Record<number, number> = {
  96000: 0,
  88200: 1,
  64000: 2,
  48000: 3,
  44100: 4,
  32000: 5,
  24000: 6,
  22050: 7,
  16000: 8,
  12000: 9,
  11025: 10,
  8000: 11,
  7350: 12,
};

/**
 * AAC encoder using WebCodecs AudioEncoder API.
 * Outputs ADTS-wrapped frames suitable for streaming.
 */
export class AacEncoder extends BaseAudioEncoder {
  private readonly profile: number;
  private readonly sampleRateIndex: number;

  /** Pre-allocated 7-byte ADTS header to avoid per-frame allocation */
  private readonly adtsHeader = new Uint8Array(7);

  /**
   * Creates a new AAC encoder instance.
   * @param config - The encoder configuration
   */
  constructor(config: EncoderConfig) {
    super(config);

    // HE-AAC and HE-AAC v2 both use the same ADTS profile (SBR signaling).
    // For HE-AAC v2, Parametric Stereo (PS) is detected in-band by the decoder.
    this.profile = config.codec.startsWith('he-aac') ? ADTS.PROFILE_HE_AAC : ADTS.PROFILE_AAC_LC;
    this.sampleRateIndex = SAMPLE_RATE_INDEX[config.sampleRate] ?? 3;

    // Pre-compute static ADTS header fields (bytes 0-2 are mostly static)
    this.adtsHeader[0] = ADTS.SYNC_BYTE_0;
    this.adtsHeader[1] = ADTS.SYNC_BYTE_1;
    this.adtsHeader[2] =
      ((this.profile - 1) << 6) | (this.sampleRateIndex << 2) | ((config.channels >> 2) & 0x01);
  }

  /**
   * Returns the logger name for this encoder.
   * @returns The logger identifier string
   */
  protected getLoggerName(): string {
    return 'AacEncoder';
  }

  /**
   * Creates the WebCodecs encoder configuration.
   * @param webCodecsId - WebCodecs codec identifier
   * @param latencyMode - Latency mode for encoding
   * @returns The encoder configuration object
   */
  protected getEncoderConfig(
    webCodecsId: string,
    latencyMode: LatencyMode,
  ): ChromeAudioEncoderConfig {
    return {
      codec: webCodecsId,
      sampleRate: this.config.sampleRate,
      numberOfChannels: this.config.channels,
      bitrate: this.config.bitrate * 1000,
      latencyMode,
    };
  }

  /**
   * Logs the encoder configuration details.
   */
  protected logConfiguration(): void {
    this.log.info(`Configured ${this.config.codec} @ ${this.config.bitrate}kbps`);
  }

  /**
   * Handles encoded output from WebCodecs.
   * @param chunk - The encoded audio chunk
   */
  protected handleOutput(chunk: EncodedAudioChunk): void {
    const rawData = new Uint8Array(chunk.byteLength);
    chunk.copyTo(rawData);

    const adtsFrame = this.wrapWithAdts(rawData);
    this.outputQueue.push(adtsFrame);
  }

  /**
   * Wraps raw AAC data with an ADTS header.
   * Uses pre-allocated header buffer; only bytes 3-6 vary per frame.
   * @param rawAac - The raw AAC frame data
   * @returns ADTS-wrapped frame
   */
  private wrapWithAdts(rawAac: Uint8Array): Uint8Array {
    const frameLength = rawAac.byteLength + 7;
    const h = this.adtsHeader;

    // Bytes 0-2 are pre-computed in constructor (static per encoder instance)
    // Byte 3: Channel config end (2 bits) + Original/Home/Copyright (4 bits) + Frame length start (2 bits)
    h[3] = ((this.config.channels & 0x03) << 6) | ((frameLength >> 11) & 0x03);
    // Byte 4: Frame length middle (8 bits)
    h[4] = (frameLength >> 3) & 0xff;
    // Byte 5: Frame length end (3 bits) + Buffer fullness start (5 bits, VBR indicator)
    h[5] = ((frameLength & 0x07) << 5) | ADTS.BUFFER_FULLNESS_VBR_5BIT;
    // Byte 6: Buffer fullness end (6 bits, VBR) + Number of AAC frames - 1 (2 bits, = 1 frame)
    h[6] = ADTS.BYTE_6_VBR_ONE_FRAME;

    // Still need to allocate the output frame (unavoidable - data must be copied)
    const adtsFrame = new Uint8Array(frameLength);
    adtsFrame.set(h);
    adtsFrame.set(rawAac, 7);

    return adtsFrame;
  }
}

/**
 * Checks if AAC encoding is supported for a given configuration.
 * @param config - The encoder configuration to check
 * @returns True if the configuration is supported
 */
export async function isAacSupported(config: EncoderConfig): Promise<boolean> {
  if (typeof AudioEncoder === 'undefined') {
    return false;
  }

  const webCodecsId = CODEC_METADATA[config.codec]?.webCodecsId;
  if (!webCodecsId) {
    return false;
  }

  try {
    const result = await AudioEncoder.isConfigSupported({
      codec: webCodecsId,
      sampleRate: config.sampleRate,
      numberOfChannels: config.channels,
      bitrate: config.bitrate * 1000,
    });
    return result.supported === true;
  } catch {
    return false;
  }
}
