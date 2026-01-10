import { BaseAudioEncoder, type ChromeAudioEncoderConfig } from './base-encoder';
import type { LatencyMode } from './types';

/**
 * FLAC encoder using WebCodecs AudioEncoder API.
 * Outputs FLAC stream with proper header for HTTP streaming.
 */
export class FlacEncoder extends BaseAudioEncoder {
  private headerSent = false;

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
    this.log.info(`Configured FLAC @ ${this.config.sampleRate}Hz, ${this.config.channels}ch`);
  }

  /**
   * Resets header state after reconfiguration.
   * New encoder instance needs to send headers again.
   */
  protected onReconfigure(): void {
    this.headerSent = false;
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
      const headerData = new Uint8Array(
        description instanceof ArrayBuffer ? description : (description as ArrayBufferView).buffer,
      );
      this.outputQueue.push(headerData);
      this.headerSent = true;
      this.log.debug(`FLAC header sent: ${headerData.byteLength} bytes`);
    }

    const frameData = new Uint8Array(chunk.byteLength);
    chunk.copyTo(frameData);
    this.outputQueue.push(frameData);
  }
}
