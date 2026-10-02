import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { AudioCodec, SupportedCodecsResult } from '@thaumic-cast/protocol';
import { EncoderConfigSchema } from '@thaumic-cast/protocol';

import { getDefaultExtensionSettings, type AudioMode } from './settings';
import { resolveAudioMode } from './presets';
import { resolveAudio, type AudioControls, type AudioResolverSettings } from './audio-resolver';

const AAC_BITRATES = [96, 128, 160, 192, 256] as const;

/**
 * Codec support for a browser that encodes the given codecs, at both rate
 * families. PCM is always there: it needs no encoder.
 * @param codecs - The codecs besides PCM that encode
 * @returns The codec support
 */
function supportFor(codecs: Exclude<AudioCodec, 'pcm'>[]): SupportedCodecsResult {
  const available: AudioCodec[] = ['pcm', ...codecs];
  return {
    supported: [
      { codec: 'pcm', bitrate: 0, supported: true },
      ...(codecs.includes('aac-lc')
        ? AAC_BITRATES.map((bitrate) => ({ codec: 'aac-lc' as const, bitrate, supported: true }))
        : []),
      ...(codecs.includes('flac')
        ? [{ codec: 'flac' as const, bitrate: 0 as const, supported: true }]
        : []),
    ],
    sampleRateSupport: available.flatMap((codec) => [
      { codec, sampleRate: 48000 as const, supported: true },
      { codec, sampleRate: 44100 as const, supported: true },
    ]),
    availableCodecs: available,
    defaultCodec: 'pcm',
    defaultBitrate: 0,
  };
}

const SUPPORT = {
  pcm: supportFor([]),
  aac: supportFor(['aac-lc']),
  flac: supportFor(['aac-lc', 'flac']),
};

const MODES: AudioMode[] = ['high', 'mid', 'low', 'custom'];
const defaults = getDefaultExtensionSettings();

/**
 * Stored settings with a non-default smoothing and frame size, so a value
 * that was dropped or replaced shows.
 * @param overrides - The settings under test
 * @returns The settings the resolver reads
 */
function stored(overrides: Partial<AudioResolverSettings>): AudioResolverSettings {
  return {
    audioMode: 'mid',
    customAudioSettings: defaults.customAudioSettings,
    pcmSmoothingMs: 300,
    pcmFrameDurationMs: 40,
    captureMode: 'tab',
    ...overrides,
  };
}

/** Bespoke settings for each codec, as the options page stores them. */
const CUSTOM = {
  pcm: { ...defaults.customAudioSettings, codec: 'pcm' as const, bitrate: 0 as const },
  aac: {
    ...defaults.customAudioSettings,
    codec: 'aac-lc' as const,
    bitrate: 160 as const,
    sampleRate: 44100 as const,
    channels: 1 as const,
  },
  flac: {
    ...defaults.customAudioSettings,
    codec: 'flac' as const,
    bitrate: 0 as const,
    bitsPerSample: 24 as const,
  },
};

let info: ReturnType<typeof spyOn>;
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  // The preset resolver logs each resolution and each fallback; keep output readable.
  info = spyOn(console, 'info').mockImplementation(() => {});
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
});

describe('resolveAudio for a tab cast', () => {
  it('should send exactly what resolveAudioMode returns, in every mode and for every custom codec', () => {
    for (const support of Object.values(SUPPORT)) {
      for (const audioMode of MODES) {
        for (const customAudioSettings of Object.values(CUSTOM)) {
          const settings = stored({ audioMode, customAudioSettings });
          const expected = resolveAudioMode(audioMode, support, customAudioSettings, {
            smoothingMs: settings.pcmSmoothingMs,
            frameDurationMs: settings.pcmFrameDurationMs,
          });

          const resolved = resolveAudio(settings, support);

          expect(resolved.config).toEqual(expected);
          expect(resolved.tabConfig).toEqual(expected);
          expect(resolved.formatForced).toBe(false);
        }
      }
    }
  });

  it('should show smoothing and frame size for a PCM cast and neither for a compressed one', () => {
    const cases: [AudioMode, keyof typeof SUPPORT, AudioCodec][] = [
      ['high', 'pcm', 'pcm'],
      ['mid', 'pcm', 'pcm'],
      ['low', 'pcm', 'pcm'],
      ['high', 'aac', 'pcm'],
      ['mid', 'aac', 'aac-lc'],
      ['low', 'aac', 'aac-lc'],
      ['high', 'flac', 'pcm'],
      ['mid', 'flac', 'flac'],
      ['low', 'flac', 'aac-lc'],
    ];

    for (const [audioMode, support, codec] of cases) {
      const { config, controls } = resolveAudio(stored({ audioMode }), SUPPORT[support]);

      expect(config.codec).toBe(codec);
      expect(controls).toEqual({
        smoothing: codec === 'pcm',
        frameSize: codec === 'pcm',
        bitDepth: false,
        fallBehind: null,
      });
    }
  });

  it('should show the Bespoke controls that the chosen codec has', () => {
    const cases: [keyof typeof CUSTOM, AudioControls][] = [
      ['pcm', { smoothing: true, frameSize: true, bitDepth: false, fallBehind: 'advanced' }],
      ['aac', { smoothing: false, frameSize: false, bitDepth: false, fallBehind: 'format' }],
      ['flac', { smoothing: false, frameSize: false, bitDepth: true, fallBehind: 'format' }],
    ];

    for (const [codec, expected] of cases) {
      const settings = stored({ audioMode: 'custom', customAudioSettings: CUSTOM[codec] });

      expect(resolveAudio(settings, SUPPORT.flac).controls).toEqual(expected);
    }
  });

  it('should offer bit depth only in Bespoke, even when a preset resolves to FLAC', () => {
    const settings = stored({ audioMode: 'mid', customAudioSettings: CUSTOM.flac });
    const resolved = resolveAudio(settings, SUPPORT.flac);

    expect(resolved.config.codec).toBe('flac');
    expect(resolved.controls.bitDepth).toBe(false);
  });

  it('should carry the stored smoothing and frame size into the config', () => {
    const { config } = resolveAudio(stored({ audioMode: 'high' }), SUPPORT.aac);

    expect(config.jitterBufferMs).toBe(300);
    expect(config.frameDurationMs).toBe(40);
  });
});

describe('resolveAudio under browser-wide capture', () => {
  it('should cast 16-bit PCM in 10 ms frames whatever the mode, the support or the custom codec', () => {
    for (const support of Object.values(SUPPORT)) {
      for (const audioMode of MODES) {
        for (const customAudioSettings of Object.values(CUSTOM)) {
          const settings = stored({ audioMode, customAudioSettings, captureMode: 'browser' });

          const { config, formatForced, controls } = resolveAudio(settings, support);

          expect(config).toMatchObject({
            codec: 'pcm',
            bitrate: 0,
            bitsPerSample: 16,
            frameDurationMs: 10,
            jitterBufferMs: 300,
          });
          expect(EncoderConfigSchema.safeParse(config).success).toBe(true);
          expect(formatForced).toBe(true);
          expect(controls.smoothing).toBe(true);
          expect(controls.frameSize).toBe(false);
        }
      }
    }
  });

  it('should keep the Quality choice as what a tab cast would send', () => {
    for (const support of Object.values(SUPPORT)) {
      for (const audioMode of MODES) {
        for (const customAudioSettings of Object.values(CUSTOM)) {
          const tab = resolveAudio(stored({ audioMode, customAudioSettings }), support);
          const browser = resolveAudio(
            stored({ audioMode, customAudioSettings, captureMode: 'browser' }),
            support,
          );

          expect(browser.tabConfig).toEqual(tab.config);
        }
      }
    }
  });

  it('should show smoothing for a lossy preset, which is still sent and used', () => {
    const settings = stored({ audioMode: 'low', captureMode: 'browser' });
    const resolved = resolveAudio(settings, SUPPORT.aac);

    expect(resolved.tabConfig.codec).toBe('aac-lc');
    expect(resolved.controls).toEqual({
      smoothing: true,
      frameSize: false,
      bitDepth: false,
      fallBehind: null,
    });
  });

  it('should leave the fall-behind choice to the preset, whatever codec it resolves to', () => {
    for (const support of Object.values(SUPPORT)) {
      for (const audioMode of ['high', 'mid', 'low'] as const) {
        for (const captureMode of ['tab', 'browser'] as const) {
          const settings = stored({
            audioMode,
            captureMode,
            customAudioSettings: { ...CUSTOM.pcm, latencyMode: 'realtime' },
          });
          const resolved = resolveAudio(settings, support);

          expect(resolved.controls.fallBehind).toBeNull();
          const untouched = resolveAudio(stored({ audioMode, captureMode }), support);
          expect(resolved.config.latencyMode).toBe(untouched.config.latencyMode);
        }
      }
    }
  });

  it('should hide the fall-behind choice for Bespoke PCM under browser-wide capture', () => {
    const settings = stored({
      audioMode: 'custom',
      customAudioSettings: CUSTOM.pcm,
      captureMode: 'browser',
    });

    expect(resolveAudio(settings, SUPPORT.flac).controls.fallBehind).toBeNull();
  });

  it('should keep the fall-behind choice with the Bespoke format under browser-wide capture', () => {
    for (const codec of ['aac', 'flac'] as const) {
      const settings = stored({
        audioMode: 'custom',
        customAudioSettings: CUSTOM[codec],
        captureMode: 'browser',
      });

      expect(resolveAudio(settings, SUPPORT.flac).controls.fallBehind).toBe('format');
    }
  });

  it('should send the stored fall-behind choice for Bespoke PCM', () => {
    for (const latencyMode of ['quality', 'realtime'] as const) {
      const settings = stored({
        audioMode: 'custom',
        customAudioSettings: { ...CUSTOM.pcm, latencyMode },
      });

      expect(resolveAudio(settings, SUPPORT.pcm).config.latencyMode).toBe(latencyMode);
    }
  });

  it('should still offer bit depth for Bespoke FLAC, which a tab cast would use', () => {
    const settings = stored({
      audioMode: 'custom',
      customAudioSettings: CUSTOM.flac,
      captureMode: 'browser',
    });
    const resolved = resolveAudio(settings, SUPPORT.flac);

    expect(resolved.tabConfig).toMatchObject({ codec: 'flac', bitsPerSample: 24 });
    expect(resolved.config.bitsPerSample).toBe(16);
    expect(resolved.controls.bitDepth).toBe(true);
  });

  it('should say the cast will be refused only when the companion is known not to capture', () => {
    const browser = stored({ captureMode: 'browser' });
    const tab = stored({ captureMode: 'tab' });

    expect(resolveAudio(browser, SUPPORT.aac, { browserCapture: false }).captureRefused).toBe(true);
    expect(resolveAudio(browser, SUPPORT.aac, { browserCapture: true }).captureRefused).toBe(false);
    expect(resolveAudio(browser, SUPPORT.aac, {}).captureRefused).toBe(false);
    expect(resolveAudio(browser, SUPPORT.aac).captureRefused).toBe(false);
    expect(resolveAudio(tab, SUPPORT.aac, { browserCapture: false }).captureRefused).toBe(false);
  });

  it('should send the same config whatever the companion can do', () => {
    const settings = stored({ audioMode: 'high', captureMode: 'browser' });
    const unknown = resolveAudio(settings, SUPPORT.aac);

    for (const browserCapture of [true, false]) {
      const resolved = resolveAudio(settings, SUPPORT.aac, { browserCapture });
      expect(resolved.config).toEqual(unknown.config);
      expect(resolved.controls).toEqual(unknown.controls);
    }
  });

  it('should leave the stored settings as they were', () => {
    const settings = stored({
      audioMode: 'custom',
      customAudioSettings: CUSTOM.flac,
      captureMode: 'browser',
    });
    const before = structuredClone(settings);

    resolveAudio(settings, SUPPORT.flac);

    expect(settings).toEqual(before);
  });
});
