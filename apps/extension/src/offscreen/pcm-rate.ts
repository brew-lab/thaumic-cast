/**
 * The sample rate a PCM tab cast declares.
 *
 * PCM is relayed as captured: the MediaStreamTrackProcessor path has no
 * AudioContext, so nothing resamples it. The rate declared in the handshake
 * must therefore be the rate the capture delivers, whatever rate the settings
 * hold. Declaring any other plays the cast at the wrong speed.
 *
 * Kept apart from the relay worker so it can be tested without a worker scope.
 */

import { isSupportedSampleRate, type SupportedSampleRate } from '@thaumic-cast/protocol';
import { KeyedError } from '../lib/keyed-error';

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
