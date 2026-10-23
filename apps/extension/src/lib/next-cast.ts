/**
 * Next cast
 *
 * Says whether a running cast is playing with settings other than the ones a
 * cast would start with now. A cast keeps the encoder config and capture mode it
 * started with (the background stores both in its session, so they survive a
 * restored service worker), and the options page says so while the two differ:
 * "The cast playing now keeps its settings. Changes apply from the next cast."
 * (DESIGN.md §11 call 103).
 *
 * Only what reaches the stream counts. Settings that apply at once (theme,
 * language), or that a running cast reads again (the start level, read when
 * rooms are added), never do.
 */

import type { ActiveCast, EncoderConfig } from '@thaumic-cast/protocol';

/** What a running cast started with, as the background keeps it. */
export type StartedCast = Pick<ActiveCast, 'encoderConfig' | 'captureMode'>;

/** What a cast would start with now: the resolver's config and the capture mode. */
export interface NextCast {
  /** The config a cast started now would send (`resolveAudio(...).config`). */
  config: EncoderConfig;
  /** The capture mode a cast started now would use. */
  captureMode: 'tab' | 'browser';
}

/** The parts of a stream a setting can change, keyed by field. */
type StreamFields = Partial<Record<keyof EncoderConfig | 'captureMode', unknown>>;

/**
 * Takes a cast's config down to the fields that reach its stream.
 *
 * - Browser-wide capture: only the smoothing. The companion captures and core
 *   sends 16-bit PCM in 10 ms frames at the device's rate and channel count, so
 *   the Quality choice's codec, rate, channels and fall-behind choice do nothing.
 * - A tab cast: codec, bitrate, channels, bit depth and the fall-behind choice;
 *   for PCM the smoothing and frame size (its rate follows the capture), and for
 *   the codecs the browser encodes the sample rate.
 * @param config - The cast's encoder config
 * @param captureMode - The cast's capture mode
 * @returns The fields that reach the stream
 */
export function streamFields(config: EncoderConfig, captureMode: 'tab' | 'browser'): StreamFields {
  if (captureMode === 'browser') {
    return { captureMode, jitterBufferMs: config.jitterBufferMs };
  }
  const fields: StreamFields = {
    captureMode,
    codec: config.codec,
    bitrate: config.bitrate,
    channels: config.channels,
    bitsPerSample: config.bitsPerSample,
    latencyMode: config.latencyMode,
  };
  if (config.codec === 'pcm') {
    fields.jitterBufferMs = config.jitterBufferMs;
    fields.frameDurationMs = config.frameDurationMs;
  } else {
    fields.sampleRate = config.sampleRate;
  }
  return fields;
}

/**
 * Whether a running cast plays with settings other than the next cast's.
 * @param started - What the cast started with
 * @param next - What a cast would start with now
 * @returns True when a field that reaches the stream differs
 */
export function castKeepsOldSettings(started: StartedCast, next: NextCast): boolean {
  const was = streamFields(started.encoderConfig, started.captureMode);
  const now = streamFields(next.config, next.captureMode);
  const keys = new Set([...Object.keys(was), ...Object.keys(now)]) as Set<keyof StreamFields>;
  for (const key of keys) {
    if (was[key] !== now[key]) return true;
  }
  return false;
}

/**
 * Whether the options page shows the next-cast Notice: some cast from this
 * browser is running with settings other than the next cast's. Nothing shows
 * while the next cast's config is unknown (codecs still being detected).
 * @param casts - The running casts from this browser
 * @param next - What a cast would start with now, or null when unknown
 * @returns True when the Notice shows
 */
export function showNextCastNotice(casts: readonly StartedCast[], next: NextCast | null): boolean {
  if (!next) return false;
  return casts.some((cast) => castKeepsOldSettings(cast, next));
}
