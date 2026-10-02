/**
 * The sample rate a PCM tab cast declares.
 *
 * PCM is relayed as captured: the MediaStreamTrackProcessor path has no
 * AudioContext, so nothing resamples it. The rate declared in the handshake
 * must therefore be the rate the capture delivers, whatever rate the settings
 * hold. Declaring any other plays the cast at the wrong speed.
 *
 * The capture states its rate on each AudioData, and Chrome may deliver none
 * while the tab is silent or paused. So the first one is waited for only
 * briefly: a cast started from a quiet tab declares the rate the track reports,
 * and is stopped if the audio then arrives at another.
 *
 * Kept apart from the relay worker so it can be tested without a worker scope.
 */

import { isSupportedSampleRate, type SupportedSampleRate } from '@thaumic-cast/protocol';
import { KeyedError, type ErrorParams } from '../lib/keyed-error';

/** Rate declared when the capture states none. Chrome captures tab audio at 48 kHz. */
export const PCM_FALLBACK_SAMPLE_RATE: SupportedSampleRate = 48000;

/**
 * Resolves the rate a PCM cast declares from the rate its capture delivers.
 * @param capturedRate - The capture's sample rate in Hz, or nothing when it states none
 * @returns The captured rate when it is supported, or 48000 when none was stated
 * @throws {KeyedError} If the capture states a rate no stream can carry
 */
export function resolvePcmDeclaredRate(
  capturedRate: number | null | undefined,
): SupportedSampleRate {
  if (!capturedRate) return PCM_FALLBACK_SAMPLE_RATE;
  if (!isSupportedSampleRate(capturedRate)) {
    throw new KeyedError('error_pcm_rate_unsupported', { rate: capturedRate });
  }
  return capturedRate;
}

/**
 * Computes the number of interleaved samples in one PCM frame.
 * @param sampleRate - The declared sample rate in Hz
 * @param frameDurationMs - The frame duration in milliseconds
 * @param channels - The number of output channels
 * @returns Interleaved samples per frame
 */
export function pcmFrameSizeInterleaved(
  sampleRate: number,
  frameDurationMs: number,
  channels: number,
): number {
  return Math.round(sampleRate * (frameDurationMs / 1000)) * channels;
}

/**
 * How long a PCM cast waits for its first AudioData before declaring a rate
 * without one, in milliseconds.
 *
 * A playing tab delivers an AudioData about every 10 ms, so 300 ms is some
 * thirty of them: long enough that a playing tab is declared at the rate it is
 * captured at. A silent or paused tab may deliver none at all, and its cast
 * must still start, so the wait is short enough to pass unnoticed and is a
 * fiftieth of the 15 s the session allows itself to initialise.
 */
export const PCM_FIRST_FRAME_WAIT_MS = 300;

/**
 * Resolves the rate a PCM cast declares when no audio arrived in time to state one.
 *
 * The stored rate is never a candidate: it belongs to whichever codec was
 * configured last, and declaring it is how a cast came to play at the wrong speed.
 * @param trackRate - The rate the track's settings report in Hz, or nothing when they state none
 * @returns The track's rate when it is supported, otherwise 48000
 */
export function resolvePcmSilentStartRate(
  trackRate: number | null | undefined,
): SupportedSampleRate {
  return trackRate && isSupportedSampleRate(trackRate) ? trackRate : PCM_FALLBACK_SAMPLE_RATE;
}

/** Why a PCM cast was stopped over its sample rate; each is an auto-stop reason. */
export type PcmRateStopReason = 'pcm_rate_changed' | 'pcm_rate_unsupported';

/** A PCM cast's audio arriving at a rate other than the one declared. */
export interface PcmRateMismatch {
  /** Whether a new cast could carry the rate, or no PCM cast can. */
  reason: PcmRateStopReason;
  /** The values the reason's message prints: `rate` and `declared`, in Hz. */
  params: ErrorParams;
}

/**
 * Compares the rate an AudioData states with the rate the cast declared.
 * @param frameRate - The AudioData's sample rate in Hz; zero or nothing when it states none
 * @param declaredRate - The rate declared in the handshake, in Hz
 * @returns Nothing when the cast may carry on, otherwise why it must stop
 */
export function pcmRateMismatch(
  frameRate: number | null | undefined,
  declaredRate: number,
): PcmRateMismatch | null {
  if (!frameRate || frameRate === declaredRate) return null;
  return {
    reason: isSupportedSampleRate(frameRate) ? 'pcm_rate_changed' : 'pcm_rate_unsupported',
    params: { rate: frameRate, declared: declaredRate },
  };
}

/**
 * What a stream read settles with: a chunk, or the end of the stream. Stated
 * here in the shape every reader agrees on, so a test can supply a plain object.
 */
export type ReadOutcome<T> = { done: false; value: T } | { done: true; value?: undefined };

/** The part of a stream reader the first-read wait uses. */
export interface ReadSource<T> {
  /** Starts a read of the next chunk. */
  read: () => Promise<ReadOutcome<T>>;
}

/** The outcome of waiting a limited time for a stream's first read. */
export interface FirstRead<T> {
  /** The read's result when it settled within the limit, otherwise null. */
  settled: ReadOutcome<T> | null;
  /**
   * The one read that was started. When `settled` is null it is still
   * outstanding and whoever reads next must await this, not start another.
   */
  read: Promise<ReadOutcome<T>>;
}

/**
 * Starts one read and waits for it up to a limit.
 *
 * The read is started exactly once. If the limit passes first the read is
 * handed back still outstanding, so the frame it yields is neither lost nor
 * read a second time.
 * @param reader - The reader to take the first chunk from
 * @param limitMs - How long to wait for it, in milliseconds
 * @returns The read, and its result when it settled within the limit
 * @throws Whatever the read rejects with, when it rejects within the limit
 */
export async function readFirstWithin<T>(
  reader: ReadSource<T>,
  limitMs: number,
): Promise<FirstRead<T>> {
  const read = reader.read();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), limitMs);
  });
  try {
    // The race leaves a handler on `read`, so a rejection after the limit
    // waits for the next reader instead of being reported as unhandled.
    const settled = await Promise.race([read, limit]);
    return { settled, read };
  } finally {
    clearTimeout(timer);
  }
}
