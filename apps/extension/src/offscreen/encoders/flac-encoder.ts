import { INT24_MAX, tpdfDither } from '@thaumic-cast/protocol';
import { BaseAudioEncoder, type ChromeAudioEncoderConfig } from './base-encoder';
import type { LatencyMode } from './types';

/** Default capacity in samples for pre-allocated Int32 buffer (10ms stereo @ 48kHz = 480 frames × 2 ch). */
const DEFAULT_INT32_BUFFER_CAPACITY = 960;

/**
 * FLAC encoder using WebCodecs AudioEncoder API.
 * Outputs FLAC stream with proper header for HTTP streaming.
 *
 * Supports both 16-bit and 24-bit encoding:
 * - 16-bit: Uses f32-planar format (inherited from BaseAudioEncoder)
 * - 24-bit: Uses s32-planar format with samples scaled to 24-bit range
 */
export class FlacEncoder extends BaseAudioEncoder {
  private headerSent = false;
  /** Pre-allocated buffer for 24-bit Int32 planar conversion (explicitly ArrayBuffer-backed for BufferSource compatibility). */
  private int32PlanarBuffer: Int32Array<ArrayBuffer>;

  /**
   * Creates a new FLAC encoder instance.
   * @param config - The encoder configuration
   */
  constructor(config: import('@thaumic-cast/protocol').EncoderConfig) {
    super(config);
    // Pre-allocate Int32 buffer for 24-bit encoding
    this.int32PlanarBuffer = new Int32Array(DEFAULT_INT32_BUFFER_CAPACITY);
  }

  /**
   * Returns the logger name for this encoder.
   * @returns The logger identifier string
   */
  protected getLoggerName(): string {
    return 'FlacEncoder';
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
      // FLAC is lossless - bitrate doesn't apply
      latencyMode,
    };
  }

  /**
   * Logs the encoder configuration details.
   */
  protected logConfiguration(): void {
    this.log.info(
      `Configured FLAC @ ${this.config.sampleRate}Hz, ${this.config.channels}ch, ${this.config.bitsPerSample}-bit`,
    );
  }

  /**
   * Resets header state after reconfiguration.
   * New encoder instance needs to send headers again.
   */
  protected onReconfigure(): void {
    this.headerSent = false;
  }

  /**
   * Ensures the Int32 planar buffer is large enough.
   * @param sampleCount - Total samples needed
   */
  private ensureInt32BufferCapacity(sampleCount: number): void {
    if (this.int32PlanarBuffer.length < sampleCount) {
      this.int32PlanarBuffer = new Int32Array(sampleCount);
    }
  }

  /**
   * Converts interleaved Float32 samples to planar Int32 format scaled to 24-bit range.
   * @param samples - Interleaved Float32 samples (range [-1.0, 1.0])
   * @returns Object with planar Int32 data and frame count
   */
  private convertToInt32Planar(samples: Float32Array): {
    planarData: Int32Array<ArrayBuffer>;
    frameCount: number;
  } {
    const channels = this.config.channels;
    const frameCount = samples.length / channels;
    const sampleCount = samples.length;

    this.ensureInt32BufferCapacity(sampleCount);

    // Scale to 24-bit range and deinterleave to planar format with TPDF dithering
    // Dithering decorrelates quantization error from the signal, converting
    // audible harmonic distortion into inaudible white noise floor
    for (let ch = 0; ch < channels; ch++) {
      for (let i = 0; i < frameCount; i++) {
        const s = samples[i * channels + ch]!;
        // Defensive: handle NaN (s !== s) and clamp to [-1, 1] to prevent overflow
        const safe = s !== s ? 0 : s < -1 ? -1 : s > 1 ? 1 : s;
        // Scale to 24-bit range, add dither, then quantize
        // Clamp after rounding to prevent overflow: dither can push peaks past ±8388607
        const dithered = safe * INT24_MAX + tpdfDither();
        const rounded = Math.round(dithered);
        this.int32PlanarBuffer[ch * frameCount + i] =
          rounded < -8388608 ? -8388608 : rounded > 8388607 ? 8388607 : rounded;
      }
    }

    return {
      planarData: this.int32PlanarBuffer.subarray(0, sampleCount),
      frameCount,
    };
  }

  /**
   * Encodes PCM samples using either 16-bit or 24-bit encoding.
   * @param samples - Interleaved Float32 samples (range [-1.0, 1.0])
   * @returns Encoded FLAC data or null if unavailable
   */
  override encode(samples: Float32Array): Uint8Array | null {
    if (this.config.bitsPerSample === 24) {
      return this.encode24Bit(samples);
    }
    // Use base class 16-bit encoding (f32-planar)
    return super.encode(samples);
  }

  /**
   * Encodes samples as 24-bit FLAC using s32-planar format.
   * @param samples - Interleaved Float32 samples
   * @returns Encoded FLAC data or null if unavailable
   */
  private encode24Bit(samples: Float32Array): Uint8Array | null {
    const { planarData, frameCount } = this.convertToInt32Planar(samples);

    const data = new AudioData({
      format: 's32-planar',
      sampleRate: this.config.sampleRate,
      numberOfFrames: frameCount,
      numberOfChannels: this.config.channels,
      timestamp: this.timestamp,
      data: planarData,
    });

    this.encoder.encode(data);
    data.close();
    this.timestamp += (frameCount / this.config.sampleRate) * 1_000_000;

    return this.consolidateOutput();
  }

  /**
   * Extracts bits-per-sample from FLAC header data.
   *
   * WebCodecs may provide different formats:
   * - Full stream: "fLaC" (4) + block header (4) + STREAMINFO (34) = 42+ bytes
   * - Block + data: block header (4) + STREAMINFO (34) = 38 bytes
   * - Raw STREAMINFO: just the 34-byte STREAMINFO block
   *
   * Bits-per-sample is a 5-bit field at byte offset 12-13 within STREAMINFO.
   *
   * @param header - The FLAC header data
   * @returns The bits per sample, or null if format unrecognized
   */
  private extractBitsPerSample(header: Uint8Array): number | null {
    // Determine STREAMINFO offset based on header format
    let streamInfoOffset: number;

    // Check for "fLaC" marker (0x66 0x4C 0x61 0x43)
    const hasFLaCMarker =
      header.length >= 4 &&
      header[0] === 0x66 &&
      header[1] === 0x4c &&
      header[2] === 0x61 &&
      header[3] === 0x43;

    if (hasFLaCMarker) {
      // Full FLAC stream: fLaC (4) + block header (4) + STREAMINFO
      streamInfoOffset = 8;
    } else if (header.length >= 38) {
      // Likely block header (4) + STREAMINFO (34)
      streamInfoOffset = 4;
    } else if (header.length >= 34) {
      // Raw STREAMINFO block
      streamInfoOffset = 0;
    } else {
      return null; // Too short to be valid
    }

    // Need at least 14 bytes into STREAMINFO to read bps field
    if (header.length < streamInfoOffset + 14) return null;

    // Bits-per-sample is stored as (bps - 1) in a 5-bit field:
    // - 1 bit at end of STREAMINFO byte 12 (bit 0)
    // - 4 bits at start of STREAMINFO byte 13 (bits 7-4)
    const byte12 = header[streamInfoOffset + 12]!;
    const byte13 = header[streamInfoOffset + 13]!;
    const bpsMinusOne = ((byte12 & 0x01) << 4) | ((byte13 >> 4) & 0x0f);
    return bpsMinusOne + 1;
  }

  /**
   * Handles encoded output from WebCodecs.
   * @param chunk - The encoded audio chunk
   * @param metadata - Optional metadata containing codec description
   */
  protected handleOutput(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata): void {
    // First chunk should include decoderConfig with the FLAC stream header
    if (!this.headerSent && metadata?.decoderConfig?.description) {
      const description = metadata.decoderConfig.description;
      // Handle both ArrayBuffer and ArrayBufferView, respecting byteOffset/byteLength
      const headerData =
        description instanceof ArrayBuffer
          ? new Uint8Array(description)
          : new Uint8Array(
              (description as ArrayBufferView).buffer,
              (description as ArrayBufferView).byteOffset,
              (description as ArrayBufferView).byteLength,
            );

      // Verify actual output bit depth matches requested
      const actualBps = this.extractBitsPerSample(headerData);
      if (actualBps !== null && actualBps !== this.config.bitsPerSample) {
        this.log.warn(
          `FLAC bit depth mismatch: requested ${this.config.bitsPerSample}-bit, got ${actualBps}-bit. ` +
            `Sonos S2 supports up to 24-bit; 32-bit may cause playback issues.`,
        );
      }

      this.outputQueue.push(headerData);
      this.headerSent = true;
      this.log.debug(`FLAC header sent: ${headerData.byteLength} bytes, ${actualBps ?? '?'}-bit`);
    }

    const frameData = new Uint8Array(chunk.byteLength);
    chunk.copyTo(frameData);
    this.outputQueue.push(frameData);
  }
}
