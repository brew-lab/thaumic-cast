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

describe('getResolvedConfigForDisplay', () => {
  it('should show the smoothing the stream will run with', () => {
    const config = getResolvedConfigForDisplay('mid', PCM_ONLY, custom, {
      smoothingMs: 500,
      frameDurationMs: 10,
    });

    expect(config?.jitterBufferMs).toBe(500);
  });
});
