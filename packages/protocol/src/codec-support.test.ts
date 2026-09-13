import { afterEach, describe, expect, it } from 'bun:test';

import type { AudioCodec, Bitrate } from './audio.js';
import {
  calculateQualityScore,
  detectSupportedCodecs,
  generateDynamicPresets,
  getCodecBitrateLabel,
  getSupportedBitrates,
  getSupportedSampleRates,
  isCodecSupported,
  type SupportedCodecsResult,
} from './codec-support.js';

type Option = [codec: AudioCodec, bitrate: Bitrate, supported?: boolean];

function support(
  options: Option[],
  sampleRates: [AudioCodec, number, boolean][] = [],
): SupportedCodecsResult {
  return {
    supported: options.map(([codec, bitrate, supported = true]) => ({ codec, bitrate, supported })),
    sampleRateSupport: sampleRates.map(([codec, sampleRate, supported]) => ({
      codec,
      sampleRate: sampleRate as 48000,
      supported,
    })),
    availableCodecs: [],
    defaultCodec: null,
    defaultBitrate: null,
  };
}

interface EncoderConfigCheck {
  codec: string;
  sampleRate: number;
  numberOfChannels: number;
  bitrate: number;
}

/** Installs a fake WebCodecs AudioEncoder that supports the given codec ids. */
function installFakeAudioEncoder(
  isSupported: (config: EncoderConfigCheck) => boolean | Promise<boolean>,
): EncoderConfigCheck[] {
  const calls: EncoderConfigCheck[] = [];
  Object.defineProperty(globalThis, 'AudioEncoder', {
    configurable: true,
    value: {
      async isConfigSupported(config: EncoderConfigCheck) {
        calls.push(config);
        return { supported: await isSupported(config) };
      },
    },
  });
  return calls;
}

afterEach(() => {
  delete (globalThis as { AudioEncoder?: unknown }).AudioEncoder;
});

describe('isCodecSupported', () => {
  it('should always support PCM because it needs no WebCodecs encoder', async () => {
    expect(typeof globalThis.AudioEncoder).toBe('undefined');
    expect(await isCodecSupported('pcm', 0)).toBe(true);
  });

  it('should report encoded codecs unsupported when WebCodecs is unavailable', async () => {
    expect(await isCodecSupported('aac-lc', 192)).toBe(false);
  });

  it('should ask WebCodecs with the codec id and the bitrate in bits per second', async () => {
    const calls = installFakeAudioEncoder(() => true);

    expect(await isCodecSupported('he-aac', 96, 44100, 1)).toBe(true);
    expect(calls).toEqual([
      { codec: 'mp4a.40.5', sampleRate: 44100, numberOfChannels: 1, bitrate: 96_000 },
    ]);
  });

  it('should treat a throwing WebCodecs check as unsupported', async () => {
    installFakeAudioEncoder(() => {
      throw new TypeError('bad config');
    });

    expect(await isCodecSupported('vorbis', 192)).toBe(false);
  });
});

describe('detectSupportedCodecs', () => {
  it('should list PCM and any codec WebCodecs accepts, in preference order', async () => {
    installFakeAudioEncoder(
      (config) => config.codec === 'mp4a.40.2' && config.sampleRate === 48000,
    );

    const result = await detectSupportedCodecs();

    expect(result.availableCodecs).toEqual(['pcm', 'aac-lc']);
    expect(result.defaultCodec).toBe('pcm');
    expect(result.defaultBitrate).toBe(0);
  });

  it('should record PCM as a single bitrate-0 option', async () => {
    const result = await detectSupportedCodecs();

    expect(result.supported.filter((s) => s.codec === 'pcm')).toEqual([
      { codec: 'pcm', bitrate: 0, supported: true },
    ]);
  });

  it('should only probe sample rates for codecs that have a supported bitrate', async () => {
    installFakeAudioEncoder(
      (config) => config.codec === 'mp4a.40.2' && config.sampleRate === 48000,
    );

    const result = await detectSupportedCodecs();
    const probed = new Set(result.sampleRateSupport.map((s) => s.codec));

    expect(probed).toEqual(new Set(['pcm', 'aac-lc']));
    expect(getSupportedSampleRates('aac-lc', result)).toEqual([48000]);
  });
});

describe('getSupportedBitrates / getSupportedSampleRates', () => {
  it('should return only the supported entries for the requested codec', () => {
    const info = support(
      [
        ['aac-lc', 128],
        ['aac-lc', 256, false],
        ['vorbis', 192],
      ],
      [
        ['aac-lc', 48000, true],
        ['aac-lc', 44100, false],
        ['vorbis', 44100, true],
      ],
    );

    expect(getSupportedBitrates('aac-lc', info)).toEqual([128]);
    expect(getSupportedSampleRates('aac-lc', info)).toEqual([48000]);
    expect(getSupportedBitrates('flac', info)).toEqual([]);
  });
});

describe('quality scoring and labels', () => {
  it('should scale the bitrate by the codec efficiency', () => {
    expect(calculateQualityScore('aac-lc', 128)).toBe(128);
    expect(calculateQualityScore('he-aac', 64)).toBe(96);
  });

  it('should give lossless options a fixed top score', () => {
    expect(calculateQualityScore('flac', 0)).toBe(1000);
    expect(calculateQualityScore('pcm', 0)).toBe(1000);
  });

  it('should label lossless options without a bitrate', () => {
    expect(getCodecBitrateLabel('flac', 0)).toBe('FLAC Lossless');
    expect(getCodecBitrateLabel('aac-lc', 192)).toBe('AAC-LC 192kbps');
  });
});

describe('generateDynamicPresets', () => {
  it('should return empty presets when nothing is supported', () => {
    expect(generateDynamicPresets(support([['aac-lc', 128, false]]))).toEqual({
      high: null,
      mid: null,
      low: null,
      allOptions: [],
    });
  });

  it('should prefer a lossless option for the high tier over any bitrate', () => {
    const presets = generateDynamicPresets(
      support([
        ['aac-lc', 256],
        ['flac', 0],
        ['vorbis', 320],
      ]),
    );

    expect(presets.high).toMatchObject({ codec: 'flac', bitrate: 0 });
  });

  it('should pick the highest bitrate for the high tier when nothing is lossless', () => {
    const presets = generateDynamicPresets(
      support([
        ['aac-lc', 256],
        ['vorbis', 320],
      ]),
    );

    expect(presets.high).toMatchObject({ codec: 'vorbis', bitrate: 320 });
  });

  it('should pick the lowest bitrate for the low tier and never a lossless option', () => {
    const presets = generateDynamicPresets(
      support([
        ['pcm', 0],
        ['aac-lc', 128],
        ['he-aac', 64],
      ]),
    );

    expect(presets.low).toMatchObject({ codec: 'he-aac', bitrate: 64 });
  });

  it('should break a low-tier bitrate tie in favour of the more efficient codec', () => {
    const presets = generateDynamicPresets(
      support([
        ['aac-lc', 256],
        ['he-aac', 64],
        ['he-aac-v2', 64],
      ]),
    );

    expect(presets.low).toMatchObject({ codec: 'he-aac-v2', bitrate: 64 });
  });

  it('should choose a mid option distinct from both high and low', () => {
    const presets = generateDynamicPresets(
      support([
        ['flac', 0],
        ['aac-lc', 192],
        ['he-aac', 64],
      ]),
    );

    expect(presets.mid).toMatchObject({ codec: 'aac-lc', bitrate: 192 });
  });

  it('should leave mid and low empty when only one option exists', () => {
    const presets = generateDynamicPresets(support([['aac-lc', 128]]));

    expect(presets.high).toMatchObject({ codec: 'aac-lc', bitrate: 128 });
    expect(presets.mid).toBeNull();
    expect(presets.low).toBeNull();
  });

  it('should leave mid empty when only two options exist', () => {
    const presets = generateDynamicPresets(
      support([
        ['aac-lc', 128],
        ['aac-lc', 256],
      ]),
    );

    expect(presets.high).toMatchObject({ bitrate: 256 });
    expect(presets.low).toMatchObject({ bitrate: 128 });
    expect(presets.mid).toBeNull();
  });

  it('should sort all options by quality score, highest first', () => {
    const presets = generateDynamicPresets(
      support([
        ['aac-lc', 128],
        ['he-aac', 96],
        ['flac', 0],
      ]),
    );

    expect(presets.allOptions.map((o) => o.label)).toEqual([
      'FLAC Lossless',
      'HE-AAC 96kbps',
      'AAC-LC 128kbps',
    ]);
  });
});
