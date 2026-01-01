import { BaseAudioEncoder, type ChromeAudioEncoderConfig } from './base-encoder';

/**
 * FLAC encoder using WebCodecs AudioEncoder API.
 * Outputs FLAC stream with proper header for HTTP streaming.
 */
export class FlacEncoder extends BaseAudioEncoder {
  private headerSent = false;

  /**
   *
   */
  protected getLoggerName(): string {
    return 'FlacEncoder';
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
      // FLAC is lossless - bitrate doesn't apply
      latencyMode: 'quality',
    };
  }

  /**
   *
   */
  protected logConfiguration(): void {
    this.log.info(`Configured FLAC @ ${this.config.sampleRate}Hz, ${this.config.channels}ch`);
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
