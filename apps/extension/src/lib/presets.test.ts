import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import type { SupportedCodecsResult } from '@thaumic-cast/protocol';

import { getDefaultExtensionSettings } from './settings';
import { getResolvedConfigForDisplay, resolveAudioMode } from './presets';

/** Codec support for a machine that can only send PCM, at both rate families. */
const PCM_ONLY: SupportedCodecsResult = {
  supported: [{ codec: 'pcm', bitrate: 0, supported: true }],
  sampleRateSupport: [
    { codec: 'pcm', sampleRate: 48000, supported: true },
    { codec: 'pcm', sampleRate: 44100, supported: true },
  ],
  availableCodecs: ['pcm'],
  defaultCodec: 'pcm',
  defaultBitrate: 0,
};

const custom = getDefaultExtensionSettings().customAudioSettings;

let info: ReturnType<typeof spyOn>;
let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  // PCM alone has no low tier, so the resolver logs its fallback; keep output readable.
  info = spyOn(console, 'info').mockImplementation(() => {});
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  info.mockRestore();
  warn.mockRestore();
});

describe('resolveAudioMode', () => {
  it('should send the same smoothing and frame size in every mode', () => {
    for (const mode of ['high', 'mid', 'low', 'custom'] as const) {
      const config = resolveAudioMode(mode, PCM_ONLY, custom, {
        smoothingMs: 300,
        frameDurationMs: 20,
      });
      expect(config.jitterBufferMs).toBe(300);
      expect(config.frameDurationMs).toBe(20);
    }
  });

  it('should default to 200 ms smoothing and 10 ms frames', () => {
    const config = resolveAudioMode('high', PCM_ONLY, custom);

    expect(config.jitterBufferMs).toBe(200);
    expect(config.frameDurationMs).toBe(10);
  });
});

describe('resolveAudioMode with AAC-LC', () => {
  /** Codec support for PCM plus AAC-LC at the given bitrates, at both rates. */
  function withAac(bitrates: (96 | 128 | 160 | 192 | 256)[]): SupportedCodecsResult {
    return {
      supported: [
        { codec: 'pcm', bitrate: 0, supported: true },
        ...([96, 128, 160, 192, 256] as const).map((bitrate) => ({
          codec: 'aac-lc' as const,
          bitrate,
          supported: bitrates.includes(bitrate),
        })),
      ],
      sampleRateSupport: [
        ...PCM_ONLY.sampleRateSupport,
        { codec: 'aac-lc', sampleRate: 48000, supported: true },
        { codec: 'aac-lc', sampleRate: 44100, supported: true },
      ],
      availableCodecs: ['pcm', 'aac-lc'],
      defaultCodec: 'pcm',
      defaultBitrate: 0,
    };
  }

  /** What Windows encodes: 256 kbps is refused. */
  const UP_TO_192 = withAac([96, 128, 160, 192]);
  const UP_TO_256 = withAac([96, 128, 160, 192, 256]);

  it('should resolve the low preset to AAC-LC at 96 kbps, mono, 44.1 kHz', () => {
    for (const support of [UP_TO_192, UP_TO_256]) {
      expect(resolveAudioMode('low', support, custom)).toMatchObject({
        codec: 'aac-lc',
        bitrate: 96,
        channels: 1,
        sampleRate: 44100,
        latencyMode: 'realtime',
      });
    }
  });

  it('should resolve the mid preset to the highest AAC-LC bitrate the platform encodes', () => {
    expect(resolveAudioMode('mid', UP_TO_192, custom)).toMatchObject({
      codec: 'aac-lc',
      bitrate: 192,
      channels: 2,
    });
    expect(resolveAudioMode('mid', UP_TO_256, custom)).toMatchObject({
      codec: 'aac-lc',
      bitrate: 256,
      channels: 2,
    });
  });

  it('should resolve the high preset to PCM', () => {
    for (const support of [UP_TO_192, UP_TO_256]) {
      expect(resolveAudioMode('high', support, custom)).toMatchObject({ codec: 'pcm', bitrate: 0 });
    }
  });

  it('should keep PCM, FLAC and the lowest AAC-LC bitrate as the presets where FLAC encodes', () => {
    const support: SupportedCodecsResult = {
      ...UP_TO_192,
      supported: [...UP_TO_192.supported, { codec: 'flac', bitrate: 0, supported: true }],
      sampleRateSupport: [
        ...UP_TO_192.sampleRateSupport,
        { codec: 'flac', sampleRate: 48000, supported: true },
        { codec: 'flac', sampleRate: 44100, supported: true },
      ],
      availableCodecs: ['pcm', 'aac-lc', 'flac'],
    };

    expect(resolveAudioMode('high', support, custom)).toMatchObject({ codec: 'pcm', bitrate: 0 });
    expect(resolveAudioMode('mid', support, custom)).toMatchObject({ codec: 'flac', bitrate: 0 });
    expect(resolveAudioMode('low', support, custom)).toMatchObject({
      codec: 'aac-lc',
      bitrate: 96,
    });
  });

  it('should keep a custom AAC-LC choice at a bitrate the platform encodes', () => {
    const settings = { ...custom, codec: 'aac-lc' as const, bitrate: 160 as const };

    expect(resolveAudioMode('custom', UP_TO_192, settings)).toMatchObject({
      codec: 'aac-lc',
      bitrate: 160,
    });
  });

  it('should fall back to the mid preset for a custom bitrate the platform refuses', () => {
    const settings = { ...custom, codec: 'aac-lc' as const, bitrate: 256 as const };

    expect(resolveAudioMode('custom', UP_TO_192, settings)).toMatchObject({
      codec: 'aac-lc',
      bitrate: 192,
    });
  });
});

describe('getResolvedConfigForDisplay', () => {
  it('should show the smoothing the stream will run with', () => {
    const config = getResolvedConfigForDisplay('mid', PCM_ONLY, custom, {
      smoothingMs: 500,
      frameDurationMs: 10,
    });

    expect(config?.jitterBufferMs).toBe(500);
  });
});
