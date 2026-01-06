import type { EncoderConfig, LatencyMode } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import type { AudioEncoder } from './types';

const log = createLogger('PcmEncoder');

/**
 * PCM "encoder" that passes through raw Int16 samples without encoding.
 *
 * This is used for server-side FLAC encoding: the desktop app receives
 * uncompressed PCM over WebSocket and encodes it to FLAC before serving
 * to Sonos speakers. This provides lossless audio quality without requiring
 * browser WebCodecs FLAC support.
 *
 * Unlike other encoders that extend BaseAudioEncoder and use WebCodecs,
 * PcmEncoder implements the AudioEncoder interface directly since there's
 * no actual encoding happening in the browser.
 */
export class PcmEncoder implements AudioEncoder {
  readonly config: EncoderConfig;

  /** Internal timestamp tracking for interface compatibility. */
  private timestamp = 0;

  /**
   * Creates a new PCM passthrough encoder.
   * @param config - The encoder configuration
   */
  constructor(config: EncoderConfig) {
    this.config = config;
    log.info(`Configured PCM passthrough @ ${config.sampleRate}Hz, ${config.channels}ch`);
  }

  /**
   * Returns 0 since PCM passthrough is synchronous with no queue.
   * @returns Always 0
   */
  get encodeQueueSize(): number {
    return 0;
  }

  /**
   * Returns 'quality' for interface compatibility.
   * Latency mode is not applicable to PCM passthrough.
   * @returns Always 'quality'
   */
  get latencyMode(): LatencyMode {
    return 'quality';
  }

  /**
   * Passes through raw PCM samples without encoding.
   *
   * The samples are already in Int16 interleaved format from the AudioWorklet,
   * which is exactly what the desktop app expects for FLAC encoding.
   *
   * @param samples - Interleaved Int16 PCM samples
   * @returns Raw bytes to send over WebSocket
   */
  encode(samples: Int16Array): Uint8Array {
    // Advance timestamp for consistency with other encoders
    const frameCount = samples.length / this.config.channels;
    this.timestamp += (frameCount / this.config.sampleRate) * 1_000_000;

    // Return raw bytes - samples are already Int16 interleaved from AudioWorklet
    return new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  }

  /**
   * Advances the internal timestamp without producing output.
   * Used when dropping frames due to backpressure.
   * @param frameCount - Number of audio frames to skip
   */
  advanceTimestamp(frameCount: number): void {
    this.timestamp += (frameCount / this.config.sampleRate) * 1_000_000;
  }

  /**
   * Returns null since PCM passthrough has no buffering.
   * @returns Always null
   */
  flush(): Uint8Array | null {
    return null;
  }

  /**
   * No-op for PCM passthrough.
   * Latency mode reconfiguration is not applicable.
   * @returns Always null
   */
  reconfigure(): Uint8Array | null {
    // PCM passthrough has no configuration to change
    return null;
  }

  /**
   * No-op for PCM passthrough - no resources to release.
   */
  close(): void {
    log.debug('PCM encoder closed');
  }
}
