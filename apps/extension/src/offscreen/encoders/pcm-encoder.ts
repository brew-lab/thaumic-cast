import type { EncoderConfig, LatencyMode } from '@thaumic-cast/protocol';
import { INT16_MAX, tpdfDither } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import type { AudioEncoder } from './types';

const log = createLogger('PcmEncoder');

/**
 * PCM encoder that quantizes Float32 samples to Int16 for transmission.
 *
 * Accepts Float32 samples from the audio pipeline and converts them to
 * Int16 for the wire protocol. The desktop app receives uncompressed PCM
 * over WebSocket and wraps it in a WAV container before serving to Sonos.
 *
 * Allocates a fresh Int16Array each call and returns a Uint8Array view of it.
 * No buffer reuse means no risk of WebSocket.send() corruption from async copies.
 * The allocation cost (~3.8KB/frame at 50 frames/sec = ~192KB/s for 48kHz stereo)
 * is negligible, and V8's generational GC handles short-lived allocations efficiently.
 *
 * Unlike other encoders that extend BaseAudioEncoder and use WebCodecs,
 * PcmEncoder implements the AudioEncoder interface directly since there's
 * no codec encoding happening in the browser - just format conversion.
 */
export class PcmEncoder implements AudioEncoder {
  readonly config: EncoderConfig;

  /** Internal timestamp tracking for interface compatibility. */
  private timestamp = 0;

  /**
   * Creates a new PCM encoder.
   * @param config - The encoder configuration
   */
  constructor(config: EncoderConfig) {
    this.config = config;
    log.info(`Configured PCM encoder @ ${config.sampleRate}Hz, ${config.channels}ch`);
  }

  /**
   * Returns 0 since PCM conversion is synchronous with no queue.
   * @returns Always 0
   */
  get encodeQueueSize(): number {
    return 0;
  }

  /**
   * Returns 'quality' for interface compatibility.
   * Latency mode is not applicable to PCM format conversion.
   * @returns Always 'quality'
   */
  get latencyMode(): LatencyMode {
    return 'quality';
  }

  /**
   * Converts Float32 samples to Int16 for wire protocol.
   *
   * The desktop app expects Int16 interleaved samples for WAV container generation.
   * We quantize here at the final step to preserve precision throughout the pipeline.
   *
   * @param samples - Interleaved Float32 PCM samples (range [-1.0, 1.0])
   * @returns Raw Int16 bytes to send over WebSocket
   */
  encode(samples: Float32Array): Uint8Array {
    // Advance timestamp for consistency with other encoders
    const frameCount = samples.length / this.config.channels;
    this.timestamp += (frameCount / this.config.sampleRate) * 1_000_000;

    // Fresh buffer each call - no reuse means no WebSocket async copy issues
    const int16 = new Int16Array(samples.length);

    // Convert Float32 to Int16 with TPDF dithering
    // Dithering decorrelates quantization error from the signal, converting
    // audible harmonic distortion into inaudible white noise floor
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i]!;
      const safe = s !== s ? 0 : s < -1 ? -1 : s > 1 ? 1 : s;
      // Scale to Int16 range, add dither, then quantize
      // Clamp after rounding to prevent overflow: dither can push peaks past ±32767
      const dithered = safe * INT16_MAX + tpdfDither();
      const rounded = Math.round(dithered);
      int16[i] = rounded < -32768 ? -32768 : rounded > 32767 ? 32767 : rounded;
    }

    // Return view of the fresh buffer - safe since buffer isn't reused
    return new Uint8Array(int16.buffer);
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
   * Returns null since PCM conversion has no buffering.
   * @returns Always null
   */
  flush(): Uint8Array | null {
    return null;
  }

  /**
   * No-op for PCM encoder.
   * Latency mode reconfiguration is not applicable to format conversion.
   * @returns Always null
   */
  reconfigure(): Uint8Array | null {
    return null;
  }

  /**
   * No-op - no resources to release.
   */
  close(): void {
    log.debug('PCM encoder closed');
  }
}
