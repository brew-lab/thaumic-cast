import { afterEach, describe, expect, it } from 'bun:test';

import type { AudioCodec, Bitrate } from './audio.js';
import {
  calculateQualityScore,
  detectSupportedCodecs,
  generateDynamicPresets,
  getCodecBitrateLabel,
  getPreferredBitrate,
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

    expect(await isCodecSupported('aac-lc', 96, 44100, 1)).toBe(true);
    expect(calls).toEqual([
      { codec: 'mp4a.40.2', sampleRate: 44100, numberOfChannels: 1, bitrate: 96_000 },
    ]);
  });

  it('should treat a throwing WebCodecs check as unsupported', async () => {
    installFakeAudioEncoder(() => {
      throw new TypeError('bad config');
    });

    expect(await isCodecSupported('aac-lc', 192)).toBe(false);
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

describe('detectSupportedCodecs on AAC', () => {
  it('should only ever ask for AAC-LC, never an HE-AAC profile', async () => {
    const calls = installFakeAudioEncoder(() => true);

    await detectSupportedCodecs();

    const ids = new Set(calls.map((c) => c.codec));
    expect(ids.has('mp4a.40.2')).toBe(true);
    expect(ids.has('mp4a.40.5')).toBe(false);
    expect(ids.has('mp4a.40.29')).toBe(false);
  });

  it('should offer only the AAC-LC bitrates the platform accepts', async () => {
    // Windows encodes AAC at 96, 128, 160 and 192 kbps and refuses 256.
    installFakeAudioEncoder((config) => config.codec === 'mp4a.40.2' && config.bitrate <= 192_000);

    const result = await detectSupportedCodecs();

    expect(getSupportedBitrates('aac-lc', result)).toEqual([96, 128, 160, 192]);
  });

  it('should offer 256 kbps where the platform accepts it', async () => {
    installFakeAudioEncoder((config) => config.codec === 'mp4a.40.2');

    const result = await detectSupportedCodecs();

    expect(getSupportedBitrates('aac-lc', result)).toEqual([96, 128, 160, 192, 256]);
  });
});

describe('getSupportedBitrates / getSupportedSampleRates', () => {
  it('should return only the supported entries for the requested codec', () => {
    const info = support(
      [
        ['aac-lc', 128],
        ['aac-lc', 256, false],
        ['flac', 0, false],
      ],
      [
        ['aac-lc', 48000, true],
        ['aac-lc', 44100, false],
        ['pcm', 44100, true],
      ],
    );

    expect(getSupportedBitrates('aac-lc', info)).toEqual([128]);
    expect(getSupportedSampleRates('aac-lc', info)).toEqual([48000]);
    expect(getSupportedBitrates('flac', info)).toEqual([]);
  });
});

describe('getPreferredBitrate', () => {
  it('should start AAC-LC at its default bitrate, not the lowest one', () => {
    const info = support([
      ['aac-lc', 96],
      ['aac-lc', 128],
      ['aac-lc', 160],
      ['aac-lc', 192],
      ['aac-lc', 256, false],
    ]);

    expect(getPreferredBitrate('aac-lc', info)).toBe(192);
  });

  it('should take the supported bitrate nearest the default when the default is refused', () => {
    const info = support([
      ['aac-lc', 96],
      ['aac-lc', 128],
      ['aac-lc', 192, false],
      ['aac-lc', 256],
    ]);

    // 128 and 256 are equally far from 192; the higher wins.
    expect(getPreferredBitrate('aac-lc', info)).toBe(256);
    expect(getPreferredBitrate('aac-lc', support([['aac-lc', 96]]))).toBe(96);
  });

  it('should give the codec default when detection supports no bitrate', () => {
    expect(getPreferredBitrate('aac-lc', support([['aac-lc', 192, false]]))).toBe(192);
    expect(getPreferredBitrate('pcm', support([['pcm', 0]]))).toBe(0);
    expect(getPreferredBitrate('flac', support([['flac', 0]]))).toBe(0);
  });
});

describe('quality scoring and labels', () => {
  it('should score a lossy option by its bitrate', () => {
    expect(calculateQualityScore('aac-lc', 128)).toBe(128);
    expect(calculateQualityScore('aac-lc', 96)).toBe(96);
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
        ['aac-lc', 128],
      ]),
    );

    expect(presets.high).toMatchObject({ codec: 'flac', bitrate: 0 });
  });

  it('should pick the highest bitrate for the high tier when nothing is lossless', () => {
    const presets = generateDynamicPresets(
      support([
        ['aac-lc', 128],
        ['aac-lc', 256],
        ['aac-lc', 192],
      ]),
    );

    expect(presets.high).toMatchObject({ codec: 'aac-lc', bitrate: 256 });
  });

  it('should pick the lowest bitrate for the low tier and never a lossless option', () => {
    const presets = generateDynamicPresets(
      support([
        ['pcm', 0],
        ['aac-lc', 128],
        ['aac-lc', 96],
      ]),
    );

    expect(presets.low).toMatchObject({ codec: 'aac-lc', bitrate: 96 });
  });

  it('should skip every lossless option for the low tier, not just the one used for high', () => {
    // Two lossless options: one becomes the high tier, the other would sort
    // lowest by bitrate (0) and must still lose to the lossy option.
    const presets = generateDynamicPresets(
      support([
        ['pcm', 0],
        ['flac', 0],
        ['aac-lc', 128],
      ]),
    );

    expect(presets.low).toMatchObject({ codec: 'aac-lc', bitrate: 128 });
  });

  it('should choose a mid option distinct from both high and low', () => {
    const presets = generateDynamicPresets(
      support([
        ['flac', 0],
        ['aac-lc', 192],
        ['aac-lc', 96],
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
        ['aac-lc', 96],
        ['aac-lc', 128],
        ['flac', 0],
      ]),
    );

    expect(presets.allOptions.map((o) => o.label)).toEqual([
      'FLAC Lossless',
      'AAC-LC 128kbps',
      'AAC-LC 96kbps',
    ]);
  });

  describe('with the AAC-LC bitrates a platform encodes', () => {
    const pcmAndAac = (bitrates: Bitrate[]): SupportedCodecsResult =>
      support([['pcm', 0], ...bitrates.map((bitrate): Option => ['aac-lc', bitrate])]);

    it('should resolve the tiers on a platform that stops at 192 kbps', () => {
      const presets = generateDynamicPresets(pcmAndAac([96, 128, 160, 192]));

      expect(presets.high).toMatchObject({ codec: 'pcm', bitrate: 0 });
      expect(presets.mid).toMatchObject({ codec: 'aac-lc', bitrate: 192 });
      expect(presets.low).toMatchObject({ codec: 'aac-lc', bitrate: 96 });
    });

    it('should resolve the tiers on a platform that reaches 256 kbps', () => {
      const presets = generateDynamicPresets(pcmAndAac([96, 128, 160, 192, 256]));

      expect(presets.high).toMatchObject({ codec: 'pcm', bitrate: 0 });
      expect(presets.mid).toMatchObject({ codec: 'aac-lc', bitrate: 256 });
      expect(presets.low).toMatchObject({ codec: 'aac-lc', bitrate: 96 });
    });
  });
});
