import type { EncoderConfig } from '@thaumic-cast/protocol';
import { CODEC_METADATA } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import type { AudioEncoder } from './types';

const log = createLogger('VorbisEncoder');

/**
 * Extended interface for AudioEncoderConfig to include non-standard Chrome properties.
 */
interface ChromeAudioEncoderConfig extends AudioEncoderConfig {
  latencyMode?: 'realtime' | 'quality';
}

/**
 * CRC32 lookup table for Ogg pages.
 */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) {
      r = (r << 1) ^ ((r >>> 31) * 0x04c11db7);
    }
    table[i] = r >>> 0;
  }
  return table;
})();

/**
 * Calculates CRC32 checksum for Ogg page.
 * @param data - The page data (with CRC field set to 0)
 * @returns The CRC32 checksum
 */
function oggCrc32(data: Uint8Array): number {
  let crc = 0;
  for (let i = 0; i < data.length; i++) {
    crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ data[i]!) & 0xff]!) >>> 0;
  }
  return crc;
}

/**
 * Header type flags for Ogg pages.
 */
const OGG_FLAGS = {
  CONTINUED: 0x01,
  BOS: 0x02, // Beginning of stream
  EOS: 0x04, // End of stream
} as const;

/**
 * Default capacity for pre-allocated buffers.
 * Sized for 10ms of stereo audio at 48kHz (480 frames * 2 channels).
 */
const DEFAULT_BUFFER_CAPACITY = 960;

/**
 * Vorbis encoder using WebCodecs AudioEncoder API.
 * Outputs Ogg Vorbis stream for HTTP streaming.
 *
 * Uses pre-allocated buffers to minimize GC pressure during encoding.
 */
export class VorbisEncoder implements AudioEncoder {
  private encoder: globalThis.AudioEncoder;
  private outputQueue: Uint8Array[] = [];
  private timestamp = 0;
  private isClosed = false;
  private headersSent = false;
  private pageSequence = 0;
  private granulePosition = 0n;
  private readonly serialNumber: number;

  /** Pre-allocated planar conversion buffer */
  private planarBuffer: Float32Array;

  /**
   * Returns the number of pending encode requests.
   * @returns The number of queued encode operations
   */
  get encodeQueueSize(): number {
    return this.encoder.encodeQueueSize;
  }

  /**
   * Creates a new Vorbis encoder instance.
   * @param config - The encoder configuration
   */
  constructor(public readonly config: EncoderConfig) {
    const webCodecsId = CODEC_METADATA[config.codec].webCodecsId;
    if (!webCodecsId) {
      throw new Error(`Codec ${config.codec} does not support WebCodecs`);
    }

    // Random serial number for this stream
    this.serialNumber = Math.floor(Math.random() * 0xffffffff);

    this.encoder = new AudioEncoder({
      output: (chunk, metadata) => this.handleOutput(chunk, metadata),
      error: (err) => log.error('Encoder error:', err.message),
    });

    const encoderConfig: ChromeAudioEncoderConfig = {
      codec: webCodecsId,
      sampleRate: config.sampleRate,
      numberOfChannels: config.channels,
      bitrate: config.bitrate * 1000,
      latencyMode: 'quality',
    };

    this.encoder.configure(encoderConfig);

    // Pre-allocate conversion buffer to minimize GC during encoding
    this.planarBuffer = new Float32Array(DEFAULT_BUFFER_CAPACITY);

    log.info(`Configured Vorbis @ ${config.bitrate}kbps`);
  }

  /**
   * Ensures planar buffer is large enough for the given sample count.
   * @param sampleCount - Total number of samples (frames * channels)
   */
  private ensureBufferCapacity(sampleCount: number): void {
    if (this.planarBuffer.length < sampleCount) {
      this.planarBuffer = new Float32Array(sampleCount);
    }
  }

  /**
   * Consolidates output queue into a single buffer.
   * @returns Consolidated output or null if queue is empty
   */
  private consolidateOutput(): Uint8Array | null {
    if (this.outputQueue.length === 0) {
      return null;
    }

    // Fast path: single item, no consolidation needed
    if (this.outputQueue.length === 1) {
      const result = this.outputQueue[0]!;
      this.outputQueue = [];
      return result;
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
   * Creates an Ogg page from packet data.
   * @param packets - Array of packet data
   * @param flags - Header type flags
   * @param granule - Granule position
   * @returns The complete Ogg page
   */
  private createOggPage(packets: Uint8Array[], flags: number, granule: bigint): Uint8Array {
    // Calculate segment table
    const segments: number[] = [];
    let totalDataSize = 0;

    for (const packet of packets) {
      let remaining = packet.byteLength;
      while (remaining >= 255) {
        segments.push(255);
        remaining -= 255;
      }
      segments.push(remaining);
      totalDataSize += packet.byteLength;
    }

    // Page header: 27 bytes + segment table + data
    const pageSize = 27 + segments.length + totalDataSize;
    const page = new Uint8Array(pageSize);
    const view = new DataView(page.buffer);

    // Capture pattern: "OggS"
    page[0] = 0x4f; // O
    page[1] = 0x67; // g
    page[2] = 0x67; // g
    page[3] = 0x53; // S

    // Version
    page[4] = 0;

    // Header type
    page[5] = flags;

    // Granule position (64-bit little-endian)
    view.setBigInt64(6, granule, true);

    // Serial number (32-bit little-endian)
    view.setUint32(14, this.serialNumber, true);

    // Page sequence number (32-bit little-endian)
    view.setUint32(18, this.pageSequence++, true);

    // CRC (set to 0 for calculation, filled in later)
    view.setUint32(22, 0, true);

    // Number of segments
    page[26] = segments.length;

    // Segment table
    for (let i = 0; i < segments.length; i++) {
      page[27 + i] = segments[i]!;
    }

    // Data
    let offset = 27 + segments.length;
    for (const packet of packets) {
      page.set(packet, offset);
      offset += packet.byteLength;
    }

    // Calculate and set CRC
    const crc = oggCrc32(page);
    view.setUint32(22, crc, true);

    return page;
  }

  /**
   * Handles encoded output from WebCodecs.
   * @param chunk - The encoded audio chunk
   * @param metadata - Optional metadata containing codec description
   */
  private handleOutput(chunk: EncodedAudioChunk, metadata?: EncodedAudioChunkMetadata): void {
    // First chunk should include decoderConfig with Vorbis headers
    if (!this.headersSent && metadata?.decoderConfig?.description) {
      const description = metadata.decoderConfig.description;
      const headerData = new Uint8Array(
        description instanceof ArrayBuffer ? description : (description as ArrayBufferView).buffer,
      );

      // WebCodecs provides Vorbis headers as a single blob
      // We need to parse and wrap each in its own Ogg page
      // Header structure: identification, comment, setup headers
      const headers = this.parseVorbisHeaders(headerData);

      if (headers.length >= 3) {
        // BOS page with identification header
        this.outputQueue.push(this.createOggPage([headers[0]!], OGG_FLAGS.BOS, 0n));

        // Comment and setup headers (can be in same page or separate)
        this.outputQueue.push(this.createOggPage([headers[1]!, headers[2]!], 0, 0n));

        this.headersSent = true;
        log.debug('Vorbis headers sent');
      }
    }

    const frameData = new Uint8Array(chunk.byteLength);
    chunk.copyTo(frameData);

    // Calculate granule position (number of samples)
    const samples = Math.floor(((chunk.duration ?? 0) * this.config.sampleRate) / 1_000_000);
    this.granulePosition += BigInt(samples);

    // Wrap audio packet in Ogg page
    const page = this.createOggPage([frameData], 0, this.granulePosition);
    this.outputQueue.push(page);
  }

  /**
   * Parses Vorbis headers from WebCodecs description.
   * WebCodecs provides headers in a specific format.
   * @param data - The header data from WebCodecs
   * @returns Array of individual header packets
   */
  private parseVorbisHeaders(data: Uint8Array): Uint8Array[] {
    const headers: Uint8Array[] = [];

    // WebCodecs Vorbis description format:
    // 2 bytes: number of headers - 1
    // For each header except last: 2 bytes length
    // Then all header data concatenated

    if (data.length < 2) {
      log.warn('Invalid Vorbis header data');
      return headers;
    }

    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const numHeaders = view.getUint16(0, true) + 1;
    const lengths: number[] = [];

    let offset = 2;
    for (let i = 0; i < numHeaders - 1; i++) {
      if (offset + 2 > data.length) break;
      lengths.push(view.getUint16(offset, true));
      offset += 2;
    }

    // Last header length is remaining data
    const dataStart = offset;
    let consumed = 0;

    for (let i = 0; i < numHeaders; i++) {
      const len = i < lengths.length ? lengths[i]! : data.length - dataStart - consumed;
      if (dataStart + consumed + len <= data.length) {
        headers.push(data.slice(dataStart + consumed, dataStart + consumed + len));
        consumed += len;
      }
    }

    return headers;
  }

  /**
   * Encodes PCM samples to Vorbis.
   * Uses pre-allocated buffers to minimize GC pressure.
   * @param samples - Interleaved stereo Int16 samples
   * @returns Encoded Ogg Vorbis data or null if unavailable
   */
  encode(samples: Int16Array): Uint8Array | null {
    if (this.isClosed) return null;

    const frameCount = samples.length / this.config.channels;
    const sampleCount = samples.length;

    // Ensure buffer is large enough (rare reallocation for larger frames)
    this.ensureBufferCapacity(sampleCount);

    // Convert interleaved Int16 to planar Float32 using pre-allocated buffer
    for (let ch = 0; ch < this.config.channels; ch++) {
      for (let i = 0; i < frameCount; i++) {
        this.planarBuffer[ch * frameCount + i] = samples[i * this.config.channels + ch]! / 0x7fff;
      }
    }

    // AudioData requires the buffer to match the exact sample count
    const planarData = this.planarBuffer.subarray(0, sampleCount);

    const data = new AudioData({
      format: 'f32-planar',
      sampleRate: this.config.sampleRate,
      numberOfFrames: frameCount,
      numberOfChannels: this.config.channels,
      timestamp: this.timestamp,
      data: (planarData.buffer as ArrayBuffer).slice(
        planarData.byteOffset,
        planarData.byteOffset + planarData.byteLength,
      ),
    });

    this.encoder.encode(data);
    data.close();
    this.timestamp += (frameCount / this.config.sampleRate) * 1_000_000;

    return this.consolidateOutput();
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

    return this.consolidateOutput();
  }

  /**
   * Advances the encoder's internal timestamp without encoding.
   * Used when dropping frames due to backpressure to prevent time compression.
   * @param frameCount - Number of audio frames to skip
   */
  advanceTimestamp(frameCount: number): void {
    this.timestamp += (frameCount / this.config.sampleRate) * 1_000_000;
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
