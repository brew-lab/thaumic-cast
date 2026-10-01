import type { EncoderConfig } from '@thaumic-cast/protocol';
import { CODEC_METADATA } from '@thaumic-cast/protocol';
import { BaseAudioEncoder, type ChromeAudioEncoderConfig } from './base-encoder';
import { ADTS_HEADER_LENGTH, adtsParamsForCodec, buildAdtsHeader, type AdtsParams } from './adts';
import type { LatencyMode } from './types';

/**
 * AAC encoder using WebCodecs AudioEncoder API.
 * Outputs ADTS-wrapped frames suitable for streaming.
 */
export class AacEncoder extends BaseAudioEncoder {
  /** What the ADTS header declares, fixed for the life of the encoder */
  private readonly adtsParams: AdtsParams;

  /** Pre-allocated 7-byte ADTS header to avoid per-frame allocation */
  private readonly adtsHeader = new Uint8Array(ADTS_HEADER_LENGTH);

  /**
   * Creates a new AAC encoder instance.
   * @param config - The encoder configuration
   * @throws {RangeError} If ADTS cannot describe the configured rate or channels
   */
  constructor(config: EncoderConfig) {
    super(config);

    this.adtsParams = adtsParamsForCodec(config.codec, config.sampleRate, config.channels);
    // Build one header now so a stream ADTS cannot describe fails here, at
    // cast start, and not on the first encoded frame.
    this.writeAdtsHeader(0);
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
   * Writes the ADTS header for a frame into the pre-allocated buffer.
   * @param payloadLength - Length of the raw AAC frame in bytes
   * @returns The pre-allocated header buffer
   */
  private writeAdtsHeader(payloadLength: number): Uint8Array {
    const { objectType, sampleRate, channels } = this.adtsParams;
    return buildAdtsHeader(objectType, sampleRate, channels, payloadLength, this.adtsHeader);
  }

  /**
   * Wraps raw AAC data with an ADTS header.
   * @param rawAac - The raw AAC frame data
   * @returns ADTS-wrapped frame
   */
  private wrapWithAdts(rawAac: Uint8Array): Uint8Array<ArrayBuffer> {
    const header = this.writeAdtsHeader(rawAac.byteLength);

    // Still need to allocate the output frame (unavoidable - data must be copied)
    const adtsFrame = new Uint8Array(header.byteLength + rawAac.byteLength);
    adtsFrame.set(header);
    adtsFrame.set(rawAac, header.byteLength);

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
