import type { EncoderConfig } from '@thaumic-cast/protocol';
import { CODEC_METADATA } from '@thaumic-cast/protocol';
import { BaseAudioEncoder, type ChromeAudioEncoderConfig } from './base-encoder';

/**
 * ADTS frame header constants.
 */
const ADTS = {
  PROFILE_AAC_LC: 1,
  PROFILE_HE_AAC: 4,
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
  }

  /**
   *
   */
  protected getLoggerName(): string {
    return 'AacEncoder';
  }

  /**
   *
   * @param webCodecsId
   */
  protected getEncoderConfig(webCodecsId: string): ChromeAudioEncoderConfig {
    return {
      codec: webCodecsId,
      sampleRate: this.config.sampleRate,
      numberOfChannels: this.config.channels,
      bitrate: this.config.bitrate * 1000,
      latencyMode: 'quality',
    };
  }

  /**
   *
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
   * @param rawAac - The raw AAC frame data
   * @returns ADTS-wrapped frame
   */
  private wrapWithAdts(rawAac: Uint8Array): Uint8Array {
    const frameLength = rawAac.byteLength + 7;
    const header = new Uint8Array(7);

    // Byte 0-1: Syncword (12 bits) + MPEG Version (1 bit) + Layer (2 bits) + Protection absent (1 bit)
    header[0] = 0xff;
    header[1] = 0xf1;

    // Byte 2: Profile (2 bits) + Sample rate index (4 bits) + Private bit (1 bit) + Channel config start (1 bit)
    header[2] =
      ((this.profile - 1) << 6) |
      (this.sampleRateIndex << 2) |
      ((this.config.channels >> 2) & 0x01);

    // Byte 3: Channel config end (2 bits) + Original (1 bit) + Home (1 bit) + Copyright ID bit (1 bit) + Copyright ID start (1 bit) + Frame length start (2 bits)
    header[3] = ((this.config.channels & 0x03) << 6) | ((frameLength >> 11) & 0x03);

    // Byte 4: Frame length (8 bits)
    header[4] = (frameLength >> 3) & 0xff;

    // Byte 5: Frame length end (3 bits) + Buffer fullness start (5 bits)
    header[5] = ((frameLength & 0x07) << 5) | 0x1f;

    // Byte 6: Buffer fullness end (6 bits) + Number of AAC frames - 1 (2 bits)
    header[6] = 0xfc;

    const adtsFrame = new Uint8Array(frameLength);
    adtsFrame.set(header);
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
