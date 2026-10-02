/**
 * Audio Resolver
 *
 * The one place that turns stored audio settings into the config a cast sends
 * and the list of controls that do something for that cast. The cast handler
 * sends what it returns and the options page renders from it, so the page
 * cannot show one thing while the cast does another.
 */

import type { EncoderConfig, SupportedCodecsResult } from '@thaumic-cast/protocol';
import { DEFAULT_BITS_PER_SAMPLE, getSupportedBitDepths } from '@thaumic-cast/protocol';
import type { ExtensionSettings } from './settings';
import { resolveAudioMode } from './presets';

/**
 * Frame size core uses for browser-wide capture, whatever the extension asks
 * for (`CAPTURE_PACKET_DURATION_MS` in `stream_coordinator.rs`).
 */
export const BROWSER_CAPTURE_FRAME_DURATION_MS = 10;

/** The stored settings the resolver reads. */
export type AudioResolverSettings = Pick<
  ExtensionSettings,
  'audioMode' | 'customAudioSettings' | 'pcmSmoothingMs' | 'pcmFrameDurationMs' | 'captureMode'
>;

/**
 * What the connected companion can do. It does not change the config a cast
 * sends: the capture mode is the user's, and only they change it. It decides
 * whether the companion will take the cast at all.
 */
export interface CompanionCapability {
  /** Whether the companion can capture the whole browser; undefined when unknown. */
  browserCapture?: boolean;
}

/** Which audio controls do something for the cast the settings produce. */
export interface AudioControls {
  /** Smoothing: any PCM cast, including one browser-wide capture forces to PCM. */
  smoothing: boolean;
  /** Frame size: a PCM tab cast. Core fixes it under browser-wide capture. */
  frameSize: boolean;
  /** Bit depth: Bespoke with a codec that offers more than one depth. */
  bitDepth: boolean;
}

/** The outcome of resolving stored audio settings. */
export interface ResolvedAudio {
  /** The config the cast sends: the format the speakers actually get. */
  config: EncoderConfig;
  /** What the Quality choice resolves to for a tab cast, whatever the capture mode. */
  tabConfig: EncoderConfig;
  /** True when browser-wide capture decides the format, whatever the Quality choice. */
  formatForced: boolean;
  /**
   * True when browser-wide capture is chosen and the companion is known not
   * to capture: it will refuse this cast.
   */
  captureRefused: boolean;
  /** The controls that apply to this cast. */
  controls: AudioControls;
}

/**
 * Resolves stored audio settings to the config a cast sends and the controls
 * that apply to it.
 *
 * A tab cast sends exactly what {@link resolveAudioMode} returns. Under
 * browser-wide capture the companion captures the audio itself and core sends
 * it as 16-bit PCM in 10 ms frames, at the capture device's own rate and
 * channel count, so only the smoothing reaches the cast; the config says PCM
 * and keeps the Quality choice's rate and channels as the declared values core
 * replaces.
 *
 * @param settings - The stored audio settings and capture mode
 * @param codecSupport - Runtime codec support info
 * @param companion - What the companion can do; leave out when unknown
 * @returns The effective config, the tab-cast config and the applicable controls
 * @throws Error if no supported codecs are found
 */
export function resolveAudio(
  settings: AudioResolverSettings,
  codecSupport: SupportedCodecsResult,
  companion?: CompanionCapability,
): ResolvedAudio {
  const tabConfig = resolveAudioMode(
    settings.audioMode,
    codecSupport,
    settings.customAudioSettings,
    {
      smoothingMs: settings.pcmSmoothingMs,
      frameDurationMs: settings.pcmFrameDurationMs,
    },
  );

  const browserWide = settings.captureMode === 'browser';
  const config: EncoderConfig = browserWide
    ? {
        ...tabConfig,
        codec: 'pcm',
        bitrate: 0,
        bitsPerSample: DEFAULT_BITS_PER_SAMPLE,
        frameDurationMs: BROWSER_CAPTURE_FRAME_DURATION_MS,
      }
    : tabConfig;

  const isPcm = config.codec === 'pcm';

  return {
    config,
    tabConfig,
    formatForced: browserWide,
    captureRefused: browserWide && companion?.browserCapture === false,
    controls: {
      smoothing: isPcm,
      frameSize: isPcm && !browserWide,
      bitDepth:
        settings.audioMode === 'custom' &&
        getSupportedBitDepths(settings.customAudioSettings.codec).length > 1,
    },
  };
}
