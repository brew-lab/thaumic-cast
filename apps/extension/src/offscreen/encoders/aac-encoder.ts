import type { EncoderConfig } from '@thaumic-cast/protocol';
import { CODEC_METADATA } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import type { AudioEncoder } from './types';

const log = createLogger('AacEncoder');

/**
 * Extended interface for AudioEncoderConfig to include non-standard Chrome properties.
 */
interface ChromeAudioEncoderConfig extends AudioEncoderConfig {
  latencyMode?: 'realtime' | 'quality';
}

/**
 * ADTS frame header constants.
 */
const ADTS = {
  SYNC_WORD: 0xfff,
  MPEG_VERSION_4: 0,
  LAYER: 0,
  PROTECTION_ABSENT: 1,
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
export class AacEncoder implements AudioEncoder {
  private encoder: globalThis.AudioEncoder;
  private outputQueue: Uint8Array[] = [];
  private timestamp = 0;
  private isClosed = false;
  private readonly profile: number;
  private readonly sampleRateIndex: number;

  /**
   * Creates a new AAC encoder instance.
   * @param config - The encoder configuration
   */
  constructor(public readonly config: EncoderConfig) {
    const webCodecsId = CODEC_METADATA[config.codec].webCodecsId;
    if (!webCodecsId) {
      throw new Error(`Codec ${config.codec} does not support WebCodecs`);
    }

    this.profile = config.codec === 'he-aac' ? ADTS.PROFILE_HE_AAC : ADTS.PROFILE_AAC_LC;
    this.sampleRateIndex = SAMPLE_RATE_INDEX[config.sampleRate] ?? 3;

    this.encoder = new AudioEncoder({
      output: (chunk) => this.handleOutput(chunk),
      error: (err) => log.error('Encoder error:', err.message),
    });

    const encoderConfig: ChromeAudioEncoderConfig = {
      codec: webCodecsId,
      sampleRate: config.sampleRate,
      numberOfChannels: config.channels,
      bitrate: config.bitrate * 1000,
      latencyMode: 'realtime',
    };

    this.encoder.configure(encoderConfig);
    log.info(`Configured ${config.codec} @ ${config.bitrate}kbps`);
  }

  /**
   * Handles encoded output from WebCodecs.
   * @param chunk - The encoded audio chunk
   */
  private handleOutput(chunk: EncodedAudioChunk): void {
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

  /**
   * Encodes PCM samples to AAC.
   * @param samples - Interleaved stereo Int16 samples
   * @returns Encoded AAC data or null if unavailable
   */
  encode(samples: Int16Array): Uint8Array | null {
    if (this.isClosed) return null;

    const frameCount = samples.length / 2;
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);

    for (let i = 0; i < frameCount; i++) {
      left[i] = samples[i * 2]! / 0x7fff;
      right[i] = samples[i * 2 + 1]! / 0x7fff;
    }

    const planar = new Float32Array(left.length + right.length);
    planar.set(left);
    planar.set(right, left.length);

    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: this.config.sampleRate,
      numberOfFrames: frameCount,
      numberOfChannels: this.config.channels,
      timestamp: this.timestamp,
      data: planar.buffer as ArrayBuffer,
    });

    this.encoder.encode(data);
    data.close();
    this.timestamp += (frameCount / this.config.sampleRate) * 1_000_000;

    if (this.outputQueue.length === 0) {
      return null;
    }

    const totalLength = this.outputQueue.reduce((acc, buf) => acc + buf.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of this.outputQueue) {
      result.set(buf, offset);
      offset += buf.byteLength;
    }
    this.outputQueue = [];
    return result;
  }

  /**
   * Flushes any remaining encoded data.
   * Note: WebCodecs flush() is async but we return sync for interface compatibility.
   * Any pending flush will be aborted when close() is called.
   * @returns Remaining encoded data or null if empty
   */
  flush(): Uint8Array | null {
    if (this.isClosed) return null;

    try {
      // flush() returns a Promise but we can't await here due to interface.
      // Catch any rejection to prevent unhandled promise errors.
      this.encoder.flush().catch(() => {
        // Silently ignore - encoder may be closing
      });
    } catch {
      // Encoder may already be in error state
    }

    if (this.outputQueue.length === 0) {
      return null;
    }

    const totalLength = this.outputQueue.reduce((acc, buf) => acc + buf.byteLength, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const buf of this.outputQueue) {
      result.set(buf, offset);
      offset += buf.byteLength;
    }
    this.outputQueue = [];
    return result;
  }

  /**
   * Closes the encoder and releases resources.
   * Handles AbortError from any pending async operations.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    try {
      // Close may cause pending operations to reject with AbortError.
      // The flush().catch() above handles that case.
      this.encoder.close();
    } catch {
      log.debug('Encoder already closed');
    }
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
