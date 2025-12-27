import type { EncoderConfig } from '@thaumic-cast/protocol';
import { CODEC_METADATA } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import type { AudioEncoder } from './types';

const log = createLogger('FlacEncoder');

/**
 * Extended interface for AudioEncoderConfig to include non-standard Chrome properties.
 */
interface ChromeAudioEncoderConfig extends AudioEncoderConfig {
  latencyMode?: 'realtime' | 'quality';
}

/**
 * FLAC encoder using WebCodecs AudioEncoder API.
 * Outputs FLAC stream with proper header for HTTP streaming.
 */
export class FlacEncoder implements AudioEncoder {
  private encoder: globalThis.AudioEncoder;
  private outputQueue: Uint8Array[] = [];
  private timestamp = 0;
  private isClosed = false;
  private headerSent = false;

  /**
   * Creates a new FLAC encoder instance.
   * @param config - The encoder configuration
   */
  constructor(public readonly config: EncoderConfig) {
    const webCodecsId = CODEC_METADATA[config.codec].webCodecsId;
    if (!webCodecsId) {
      throw new Error(`Codec ${config.codec} does not support WebCodecs`);
    }

    this.encoder = new AudioEncoder({
      output: (chunk, metadata) => this.handleOutput(chunk, metadata),
      error: (err) => log.error('Encoder error:', err.message),
    });

    const encoderConfig: ChromeAudioEncoderConfig = {
      codec: webCodecsId,
      sampleRate: config.sampleRate,
      numberOfChannels: config.channels,
      // FLAC is lossless - bitrate doesn't apply
      latencyMode: 'realtime',
    };

    this.encoder.configure(encoderConfig);
    log.info(`Configured FLAC @ ${config.sampleRate}Hz, ${config.channels}ch`);
  }

  /**
   * Handles encoded output from WebCodecs.
   * @param chunk - The encoded audio chunk
   * @param metadata - Optional metadata containing codec description
   */
  private handleOutput(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata): void {
    // First chunk should include decoderConfig with the FLAC stream header
    if (!this.headerSent && metadata?.decoderConfig?.description) {
      const description = metadata.decoderConfig.description;
      const headerData = new Uint8Array(
        description instanceof ArrayBuffer ? description : (description as ArrayBufferView).buffer,
      );
      this.outputQueue.push(headerData);
      this.headerSent = true;
      log.debug(`FLAC header sent: ${headerData.byteLength} bytes`);
    }

    const frameData = new Uint8Array(chunk.byteLength);
    chunk.copyTo(frameData);
    this.outputQueue.push(frameData);
  }

  /**
   * Encodes PCM samples to FLAC.
   * @param samples - Interleaved stereo Int16 samples
   * @returns Encoded FLAC data or null if unavailable
   */
  encode(samples: Int16Array): Uint8Array | null {
    if (this.isClosed) return null;

    const frameCount = samples.length / this.config.channels;
    const planar = new Float32Array(samples.length);

    // Convert interleaved Int16 to planar Float32
    for (let ch = 0; ch < this.config.channels; ch++) {
      for (let i = 0; i < frameCount; i++) {
        planar[ch * frameCount + i] = samples[i * this.config.channels + ch]! / 0x7fff;
      }
    }

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
   * @returns Remaining encoded data or null if empty
   */
  flush(): Uint8Array | null {
    if (this.isClosed) return null;

    try {
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
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;

    try {
      this.encoder.close();
    } catch {
      log.debug('Encoder already closed');
    }
  }
}
