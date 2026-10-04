/**
 * How long captured PCM audio waits in the extension before the companion
 * has it: the part of a video sync lead the companion cannot see.
 *
 * Three places hold it on the relay worker's path, all read from counters the
 * worker already keeps: the frame accumulator (samples not yet a whole
 * frame), the frame queue (frames held back while the socket is busy) and
 * the socket's own send buffer. Reading them allocates nothing.
 *
 * Not counted: AudioData waiting in the track processor's own queue. When the
 * socket backs up, the read loop's backoff stops reading for a while and
 * audio waits there instead, so under backpressure this reads low, by up to
 * the backoff, exactly when the delay is largest. Measuring each AudioData's
 * age against its timestamp would cover it; it is left out for now.
 */

/** Interval between capture-delay reports, in ms. */
export const CAPTURE_DELAY_INTERVAL_MS = 1000;

/**
 * The PCM format the worker sends: 16-bit interleaved samples.
 */
export interface PcmSendFormat {
  /** Samples per second per channel. */
  sampleRate: number;
  /** Interleaved channels. */
  channels: number;
}

/** Bytes in one 16-bit sample. */
const BYTES_PER_SAMPLE = 2;

/**
 * The audio held in the extension, in ms.
 * @param queueBytes - Bytes in the frame queue
 * @param accumSamples - Interleaved samples in the accumulator
 * @param bufferedAmount - Bytes the socket has not sent yet
 * @param format - The format sent
 * @returns The delay in whole ms (0 when the format is unknown)
 */
export function captureDelayMs(
  queueBytes: number,
  accumSamples: number,
  bufferedAmount: number,
  format: PcmSendFormat,
): number {
  const samplesPerMs = (format.sampleRate * format.channels) / 1000;
  if (!(samplesPerMs > 0)) return 0;
  const bytes = Math.max(0, queueBytes) + Math.max(0, bufferedAmount);
  const samples = bytes / BYTES_PER_SAMPLE + Math.max(0, accumSamples);
  return Math.round(samples / samplesPerMs);
}
