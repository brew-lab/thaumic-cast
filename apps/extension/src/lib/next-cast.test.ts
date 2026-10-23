import { describe, expect, it } from 'bun:test';
import type { SupportedCodecsResult } from '@thaumic-cast/protocol';
import { EncoderConfigSchema } from '@thaumic-cast/protocol';

import { getDefaultExtensionSettings, type ExtensionSettings } from './settings';
import { resolveAudio } from './audio-resolver';
import {
  castKeepsOldSettings,
  showNextCastNotice,
  type NextCast,
  type StartedCast,
} from './next-cast';

/** A browser that encodes AAC-LC and FLAC at both rate families; PCM needs no encoder. */
const SUPPORT: SupportedCodecsResult = {
  supported: [
    { codec: 'pcm', bitrate: 0, supported: true },
    ...[128, 192, 256].map((bitrate) => ({
      codec: 'aac-lc' as const,
      bitrate: bitrate as 128 | 192 | 256,
      supported: true,
    })),
    { codec: 'flac', bitrate: 0, supported: true },
  ],
  sampleRateSupport: (['pcm', 'aac-lc', 'flac'] as const).flatMap((codec) => [
    { codec, sampleRate: 48000 as const, supported: true },
    { codec, sampleRate: 44100 as const, supported: true },
  ]),
  availableCodecs: ['pcm', 'aac-lc', 'flac'],
  defaultCodec: 'pcm',
  defaultBitrate: 0,
};

const defaults = getDefaultExtensionSettings();

/**
 * Bespoke PCM settings, with changes.
 * @param overrides - The settings that differ
 * @returns The settings
 */
function settings(overrides: Partial<ExtensionSettings> = {}): ExtensionSettings {
  return {
    ...defaults,
    audioMode: 'custom',
    customAudioSettings: { ...defaults.customAudioSettings, codec: 'pcm', bitrate: 0 },
    ...overrides,
  };
}

/**
 * What a cast started now with these settings would send, as the options page works it out.
 * @param s - The stored settings
 * @returns The next cast
 */
function next(s: ExtensionSettings): NextCast {
  return { config: resolveAudio(s, SUPPORT).config, captureMode: s.captureMode };
}

/**
 * A cast started with these settings, as the background keeps it.
 * @param s - The settings it started with
 * @returns The started cast
 */
function started(s: ExtensionSettings): StartedCast {
  const { config, captureMode } = next(s);
  return { encoderConfig: config, captureMode };
}

describe('castKeepsOldSettings', () => {
  it('should say nothing while the settings match the cast', () => {
    expect(castKeepsOldSettings(started(settings()), next(settings()))).toBe(false);
  });

  it('should count smoothing, frame size and falling behind for a PCM tab cast', () => {
    const cast = started(settings());
    expect(castKeepsOldSettings(cast, next(settings({ pcmSmoothingMs: 500 })))).toBe(true);
    expect(castKeepsOldSettings(cast, next(settings({ pcmFrameDurationMs: 40 })))).toBe(true);
    const realtime = settings();
    realtime.customAudioSettings = { ...realtime.customAudioSettings, latencyMode: 'realtime' };
    expect(castKeepsOldSettings(cast, next(realtime))).toBe(true);
  });

  it('should go quiet again when a change is changed back', () => {
    const cast = started(settings());
    expect(castKeepsOldSettings(cast, next(settings({ pcmSmoothingMs: 0 })))).toBe(true);
    expect(castKeepsOldSettings(cast, next(settings()))).toBe(false);
  });

  it('should count the quality, codec, bitrate, channels and bit depth', () => {
    const cast = started(settings());
    expect(castKeepsOldSettings(cast, next(settings({ audioMode: 'low' })))).toBe(true);
    const aac = settings();
    aac.customAudioSettings = { ...aac.customAudioSettings, codec: 'aac-lc', bitrate: 192 };
    expect(castKeepsOldSettings(cast, next(aac))).toBe(true);
    const mono = settings();
    mono.customAudioSettings = { ...mono.customAudioSettings, channels: 1 };
    expect(castKeepsOldSettings(cast, next(mono))).toBe(true);

    const flac = settings();
    flac.customAudioSettings = { ...flac.customAudioSettings, codec: 'flac', bitsPerSample: 16 };
    const deep = settings();
    deep.customAudioSettings = { ...deep.customAudioSettings, codec: 'flac', bitsPerSample: 24 };
    expect(castKeepsOldSettings(started(flac), next(deep))).toBe(true);
  });

  it('should count the sample rate for an encoded codec, not for PCM, which follows capture', () => {
    const aac = settings();
    aac.customAudioSettings = { ...aac.customAudioSettings, codec: 'aac-lc', bitrate: 192 };
    const aac44 = settings();
    aac44.customAudioSettings = { ...aac.customAudioSettings, sampleRate: 44100 };
    expect(castKeepsOldSettings(started(aac), next(aac44))).toBe(true);

    const pcm44 = settings();
    pcm44.customAudioSettings = { ...pcm44.customAudioSettings, sampleRate: 44100 };
    expect(castKeepsOldSettings(started(settings()), next(pcm44))).toBe(false);
  });

  it('should not count PCM smoothing or frame size for an encoded codec', () => {
    const aac = settings();
    aac.customAudioSettings = { ...aac.customAudioSettings, codec: 'aac-lc', bitrate: 192 };
    const aacSmoothed = { ...aac, pcmSmoothingMs: 500 as const, pcmFrameDurationMs: 40 as const };
    expect(castKeepsOldSettings(started(aac), next(aacSmoothed))).toBe(false);
  });

  it('should not count Bespoke choices while a preset decides', () => {
    const high = settings({ audioMode: 'high' });
    const changed = settings({ audioMode: 'high' });
    changed.customAudioSettings = { ...changed.customAudioSettings, channels: 1 };
    expect(castKeepsOldSettings(started(high), next(changed))).toBe(false);
  });

  it('should never count settings that apply at once or that a cast reads again', () => {
    const cast = started(settings());
    const others = settings({
      theme: 'dark',
      language: 'en',
      startCeiling: 80,
      startCeilingEnabled: false,
      serverUrl: 'http://192.168.1.2:49400',
    });
    expect(castKeepsOldSettings(cast, next(others))).toBe(false);
  });

  it('should count only smoothing for a browser-wide cast, whose format core decides', () => {
    const browser = settings({ captureMode: 'browser' });
    const cast = started(browser);
    const mono = settings({ captureMode: 'browser' });
    mono.customAudioSettings = {
      ...mono.customAudioSettings,
      channels: 1,
      latencyMode: 'realtime',
    };
    expect(castKeepsOldSettings(cast, next(mono))).toBe(false);
    expect(
      castKeepsOldSettings(cast, next(settings({ audioMode: 'low', captureMode: 'browser' }))),
    ).toBe(false);
    expect(
      castKeepsOldSettings(cast, next(settings({ captureMode: 'browser', pcmSmoothingMs: 500 }))),
    ).toBe(true);
  });

  it('should count the capture mode, even where the format would match', () => {
    // A PCM tab cast in 10 ms frames sends what browser-wide capture declares.
    const tab = settings({ pcmFrameDurationMs: 10 });
    expect(castKeepsOldSettings(started(tab), next({ ...tab, captureMode: 'browser' }))).toBe(true);
  });

  it('should still compare right after the cast went through storage (a restored worker)', () => {
    const cast = started(settings());
    const stored = JSON.parse(JSON.stringify(cast)) as StartedCast;
    const restored: StartedCast = {
      encoderConfig: EncoderConfigSchema.parse(stored.encoderConfig),
      captureMode: stored.captureMode,
    };
    expect(castKeepsOldSettings(restored, next(settings()))).toBe(false);
    expect(castKeepsOldSettings(restored, next(settings({ pcmSmoothingMs: 500 })))).toBe(true);
  });
});

describe('showNextCastNotice', () => {
  it('should not show without a running cast', () => {
    expect(showNextCastNotice([], next(settings({ pcmSmoothingMs: 500 })))).toBe(false);
  });

  it('should not show while the next cast is unknown', () => {
    expect(showNextCastNotice([started(settings())], null)).toBe(false);
  });

  it('should show when any one of several casts differs', () => {
    const a = started(settings());
    const b = started(settings({ pcmSmoothingMs: 500 }));
    expect(showNextCastNotice([a, b], next(settings()))).toBe(true);
    expect(showNextCastNotice([a, b], next(settings({ pcmSmoothingMs: 500 })))).toBe(true);
    expect(showNextCastNotice([a, a], next(settings()))).toBe(false);
  });
});
