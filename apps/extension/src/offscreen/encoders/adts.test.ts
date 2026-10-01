import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  ADTS_HEADER_LENGTH,
  AOT_AAC_LC,
  AOT_AAC_LTP,
  AOT_AAC_MAIN,
  adtsParamsForCodec,
  buildAdtsHeader,
} from './adts';

/**
 * The expected bytes below are worked out by hand from the ADTS field layout
 * in ISO/IEC 13818-7 / 14496-3, not taken from this code's output:
 *
 *   byte 2 = profile(2) | sampling_frequency_index(4) | private(1) | channel_cfg high bit(1)
 *   byte 3 = channel_cfg low bits(2) | four zero flag bits | frame length high bits(2)
 *   byte 4 = frame length middle bits(8)
 *   byte 5 = frame length low bits(3) | buffer fullness high bits(5), all ones
 *   byte 6 = buffer fullness low bits(6), all ones | raw data blocks - 1 (2), zero
 */
describe('buildAdtsHeader', () => {
  it('should declare AAC-LC for a 48 kHz stereo frame', () => {
    // profile 01 (LC = object type 2, minus 1), index 0011 (48 kHz), private 0,
    // channel configuration 010 -> 01 0011 0 0 = 0x4C, then 10 0000 00 = 0x80.
    // Frame length 200 + 7 = 207 = 0b0_0000_1100_1111 -> 00, 0001 1001, 111.
    expect([...buildAdtsHeader(AOT_AAC_LC, 48000, 2, 200)]).toEqual([
      0xff, 0xf1, 0x4c, 0x80, 0x19, 0xff, 0xfc,
    ]);
  });

  it('should declare AAC-LC for a 44.1 kHz mono frame', () => {
    // profile 01, index 0100 (44.1 kHz), private 0, channel configuration 001
    // -> 01 0100 0 0 = 0x50, then 01 0000 00 = 0x40.
    // Frame length 100 + 7 = 107 = 0b0_0000_0110_1011 -> 00, 0000 1101, 011.
    expect([...buildAdtsHeader(AOT_AAC_LC, 44100, 1, 100)]).toEqual([
      0xff, 0xf1, 0x50, 0x40, 0x0d, 0x7f, 0xfc,
    ]);
  });

  it('should put the audio object type minus one in the profile bits', () => {
    expect(buildAdtsHeader(AOT_AAC_MAIN, 48000, 2, 0)[2]! >> 6).toBe(0b00);
    expect(buildAdtsHeader(AOT_AAC_LC, 48000, 2, 0)[2]! >> 6).toBe(0b01);
    expect(buildAdtsHeader(AOT_AAC_LTP, 48000, 2, 0)[2]! >> 6).toBe(0b11);
  });

  it('should spread a long frame length over bytes 3 to 5', () => {
    // 8184 + 7 = 8191 = 13 ones: the largest frame the field can hold.
    const header = buildAdtsHeader(AOT_AAC_LC, 48000, 2, 8184);
    expect([header[3], header[4], header[5]]).toEqual([0x83, 0xff, 0xff]);
  });

  it('should split a 5.1 channel configuration across bytes 2 and 3', () => {
    // channel configuration 110: high bit into byte 2, low bits 10 into byte 3.
    const header = buildAdtsHeader(AOT_AAC_LC, 48000, 6, 0);
    expect(header[2]).toBe(0x4d);
    expect(header[3]! >> 6).toBe(0b10);
  });

  it('should write into the buffer it is given', () => {
    const out = new Uint8Array(ADTS_HEADER_LENGTH);
    expect(buildAdtsHeader(AOT_AAC_LC, 48000, 2, 200, out)).toBe(out);
    expect(out[2]).toBe(0x4c);
  });

  it('should refuse what an ADTS header cannot express', () => {
    // SBR (5) and PS (29) have no profile value.
    expect(() => buildAdtsHeader(5, 48000, 2, 200)).toThrow(RangeError);
    expect(() => buildAdtsHeader(29, 48000, 2, 200)).toThrow(RangeError);
    expect(() => buildAdtsHeader(0, 48000, 2, 200)).toThrow(RangeError);
    expect(() => buildAdtsHeader(AOT_AAC_LC, 47999, 2, 200)).toThrow(RangeError);
    expect(() => buildAdtsHeader(AOT_AAC_LC, 48000, 0, 200)).toThrow(RangeError);
    expect(() => buildAdtsHeader(AOT_AAC_LC, 48000, 7, 200)).toThrow(RangeError);
    expect(() => buildAdtsHeader(AOT_AAC_LC, 48000, 2, 8185)).toThrow(RangeError);
    expect(() => buildAdtsHeader(AOT_AAC_LC, 48000, 2, -1)).toThrow(RangeError);
  });
});

describe('adtsParamsForCodec', () => {
  it('should declare AAC-LC as it is', () => {
    expect(adtsParamsForCodec('aac-lc', 48000, 2)).toEqual({
      objectType: AOT_AAC_LC,
      sampleRate: 48000,
      channels: 2,
    });
    expect(adtsParamsForCodec('aac-lc', 44100, 1)).toEqual({
      objectType: AOT_AAC_LC,
      sampleRate: 44100,
      channels: 1,
    });
  });

  it('should declare the half-rate AAC-LC core of HE-AAC', () => {
    expect(adtsParamsForCodec('he-aac', 48000, 2)).toEqual({
      objectType: AOT_AAC_LC,
      sampleRate: 24000,
      channels: 2,
    });
  });

  it('should declare the half-rate mono AAC-LC core of HE-AAC v2', () => {
    expect(adtsParamsForCodec('he-aac-v2', 44100, 2)).toEqual({
      objectType: AOT_AAC_LC,
      sampleRate: 22050,
      channels: 1,
    });
  });
});

/**
 * Splits an ADTS stream into the raw AAC payload of each frame, reading only
 * the 13-bit frame length so nothing here depends on the code under test.
 */
function adtsPayloads(stream: Uint8Array): Uint8Array[] {
  const payloads: Uint8Array[] = [];
  let offset = 0;
  while (offset + ADTS_HEADER_LENGTH <= stream.length) {
    const length =
      ((stream[offset + 3]! & 0x03) << 11) |
      (stream[offset + 4]! << 3) |
      (stream[offset + 5]! >> 5);
    if (length < ADTS_HEADER_LENGTH || offset + length > stream.length) break;
    payloads.push(stream.subarray(offset + ADTS_HEADER_LENGTH, offset + length));
    offset += length;
  }
  return payloads;
}

const hasFfmpeg = Bun.which('ffmpeg') !== null && Bun.which('ffprobe') !== null;

describe.skipIf(!hasFfmpeg)('ADTS framing read back by ffprobe', () => {
  const cases = [
    { sampleRate: 48000, channels: 2, layout: 'stereo' },
    { sampleRate: 44100, channels: 1, layout: 'mono' },
  ];

  for (const { sampleRate, channels, layout } of cases) {
    it(`should be recognised as AAC-LC, ${sampleRate} Hz, ${layout}`, () => {
      // Real AAC-LC frames from ffmpeg's own encoder, stripped of its headers.
      const encoded = Bun.spawnSync([
        'ffmpeg',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `sine=frequency=1000:sample_rate=${sampleRate}:duration=2`,
        '-ac',
        String(channels),
        '-c:a',
        'aac',
        '-profile:a',
        'aac_low',
        '-f',
        'adts',
        'pipe:1',
      ]);
      expect(encoded.exitCode).toBe(0);
      const payloads = adtsPayloads(new Uint8Array(encoded.stdout)).slice(0, 50);
      expect(payloads.length).toBe(50);

      // The same frames under our header.
      const rewrapped: number[] = [];
      for (const payload of payloads) {
        rewrapped.push(...buildAdtsHeader(AOT_AAC_LC, sampleRate, channels, payload.length));
        rewrapped.push(...payload);
      }

      const dir = mkdtempSync(join(tmpdir(), 'thaumic-adts-'));
      try {
        const file = join(dir, 'rewrapped.aac');
        writeFileSync(file, new Uint8Array(rewrapped));
        const probed = Bun.spawnSync([
          'ffprobe',
          '-v',
          'error',
          '-select_streams',
          'a:0',
          '-show_entries',
          'stream=codec_name,profile,sample_rate,channels',
          '-of',
          'default=noprint_wrappers=1',
          file,
        ]);
        expect(probed.exitCode).toBe(0);
        const report = probed.stdout.toString();
        expect(report).toContain('codec_name=aac');
        expect(report).toContain('profile=LC');
        expect(report).toContain(`sample_rate=${sampleRate}`);
        expect(report).toContain(`channels=${channels}`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});
