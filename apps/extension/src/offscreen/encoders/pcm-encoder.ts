import type { EncoderConfig, LatencyMode } from '@thaumic-cast/protocol';
import { FRAME_DURATION_MS_DEFAULT, INT16_MAX, tpdfDither } from '@thaumic-cast/protocol';
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
 * Pre-allocates a single Int16Array and Uint8Array view at construction time
 * and reuses them across encode() calls. This eliminates ~192KB/sec of
 * short-lived allocations (at 48kHz stereo, 50fps) that cause GC pressure
 * on low-end/thermally-throttled devices.
 *
 * Buffer reuse is safe because WebSocket.send() copies the data internally
 * per spec before returning. Callers that store the encoded result for
 * deferred use (e.g., quality-mode frame queue) must make a defensive copy.
 *
 * Unlike other encoders that extend BaseAudioEncoder and use WebCodecs,
 * PcmEncoder implements the AudioEncoder interface directly since there's
 * no codec encoding happening in the browser - just format conversion.
 */
export class PcmEncoder implements AudioEncoder {
  readonly config: EncoderConfig;

  /** Internal timestamp tracking for interface compatibility. */
  private timestamp = 0;

  /** Pre-allocated Int16 buffer, reused across encode() calls to avoid GC pressure. */
  private readonly int16Buffer: Int16Array;

  /** Uint8Array view over int16Buffer for returning raw bytes. */
  private readonly uint8View: Uint8Array;

  /**
   * Creates a new PCM encoder with pre-allocated conversion buffers.
   * @param config - The encoder configuration (must include frameSizeSamples)
   */
  constructor(config: EncoderConfig) {
    this.config = config;

    // Compute interleaved frame size: per-channel samples * channels
    // frameSizeSamples is set by the audio worker during INIT; fall back to
    // frameDurationMs-based calculation if absent.
    const perChannelSamples =
      config.frameSizeSamples ??
      Math.round(
        config.sampleRate * ((config.frameDurationMs ?? FRAME_DURATION_MS_DEFAULT) / 1000),
      );
    const interleavedSamples = perChannelSamples * config.channels;

    this.int16Buffer = new Int16Array(interleavedSamples);
    this.uint8View = new Uint8Array(this.int16Buffer.buffer);

    log.info(
      `Configured PCM encoder @ ${config.sampleRate}Hz, ${config.channels}ch ` +
        `(buffer: ${interleavedSamples} samples, ${this.uint8View.byteLength} bytes)`,
    );
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
   * Returns a view of the pre-allocated internal buffer. WebSocket.send() copies
   * the data internally per spec, so immediate send is safe. Callers that store
   * the result for deferred use (e.g., quality-mode frame queue) MUST copy it
   * first, since the next encode() call will overwrite the buffer.
   *
   * @param samples - Interleaved Float32 PCM samples (range [-1.0, 1.0])
   * @returns Raw Int16 bytes as a view of the reused internal buffer
   */
  encode(samples: Float32Array): Uint8Array {
    // Advance timestamp for consistency with other encoders
    const frameCount = samples.length / this.config.channels;
    this.timestamp += (frameCount / this.config.sampleRate) * 1_000_000;

    const int16 = this.int16Buffer;

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

    // For full-size frames (the common hot path), return the pre-allocated view directly.
    // For partial frames (e.g., flushRemaining), return a correctly-sized slice to
    // avoid sending stale trailing data from a previous encode.
    if (samples.length === this.int16Buffer.length) {
      return this.uint8View;
    }
    return new Uint8Array(this.int16Buffer.buffer, 0, samples.length * 2);
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
