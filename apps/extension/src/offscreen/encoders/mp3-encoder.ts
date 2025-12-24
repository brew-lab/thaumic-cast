import type { EncoderConfig } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import type { AudioEncoder } from './types';

const log = createLogger('Mp3Encoder');

/**
 * MP3 encoder instance type from wasm-media-encoders.
 */
interface WasmMp3Encoder {
  configure(config: { sampleRate: number; channels: number; vbrQuality?: number }): void;
  encode(samples: Float32Array[]): Uint8Array;
  finalize(): Uint8Array;
}

/**
 * MP3 encoder using wasm-media-encoders.
 * Used as fallback when AAC is not supported.
 */
export class Mp3Encoder implements AudioEncoder {
  private encoder: WasmMp3Encoder;
  private isClosed = false;

  /**
   * Private constructor for internal use.
   * @param config - The encoder configuration
   * @param encoder - The WASM MP3 encoder instance
   */
  private constructor(
    public readonly config: EncoderConfig,
    encoder: WasmMp3Encoder,
  ) {
    this.encoder = encoder;
  }

  /**
   * Creates a new MP3 encoder asynchronously.
   * @param config - The encoder configuration
   * @returns A configured MP3 encoder instance
   */
  static async create(config: EncoderConfig): Promise<Mp3Encoder> {
    const { createMp3Encoder } = await import('wasm-media-encoders');
    const encoder = await createMp3Encoder();

    const vbrQuality = Mp3Encoder.bitrateToVbrQuality(config.bitrate);
    encoder.configure({
      sampleRate: config.sampleRate,
      channels: config.channels,
      vbrQuality,
    });

    log.info(`Configured MP3 @ VBR quality ${vbrQuality} (target ~${config.bitrate}kbps)`);
    return new Mp3Encoder(config, encoder);
  }

  /**
   * Maps bitrate to VBR quality setting (0-9, lower is better quality).
   * @param bitrate - Target bitrate in kbps
   * @returns VBR quality value
   */
  private static bitrateToVbrQuality(bitrate: number): number {
    if (bitrate >= 320) return 0;
    if (bitrate >= 192) return 2;
    if (bitrate >= 128) return 4;
    if (bitrate >= 96) return 6;
    return 7;
  }

  /**
   * Encodes PCM samples to MP3.
   * @param samples - Interleaved stereo Int16 samples
   * @returns Encoded MP3 data or null if unavailable
   */
  encode(samples: Int16Array): Uint8Array | null {
    if (this.isClosed) return null;

    const { left, right } = this.deinterleave(samples);
    const encoded = this.encoder.encode([left, right]);

    return encoded.byteLength > 0 ? encoded : null;
  }

  /**
   * Flushes any remaining encoded data.
   * @returns Remaining encoded data or null if empty
   */
  flush(): Uint8Array | null {
    if (this.isClosed) return null;

    const final = this.encoder.finalize();
    return final.byteLength > 0 ? final : null;
  }

  /**
   * Closes the encoder.
   */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    // wasm-media-encoders doesn't have explicit close
  }

  /**
   * Deinterleaves stereo Int16 samples into separate Float32 channels.
   * @param samples - Interleaved stereo Int16 samples
   * @returns Deinterleaved left and right channels
   */
  private deinterleave(samples: Int16Array): { left: Float32Array; right: Float32Array } {
    const frameCount = samples.length / 2;
    const left = new Float32Array(frameCount);
    const right = new Float32Array(frameCount);

    for (let i = 0; i < frameCount; i++) {
      left[i] = samples[i * 2]! / 0x7fff;
      right[i] = samples[i * 2 + 1]! / 0x7fff;
    }

    return { left, right };
  }
}
