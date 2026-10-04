import { describe, expect, it } from 'bun:test';

import { NON_SYNC, SYNC, mp4Fragment, mp4Init } from '../test-support/media-fixtures';
import { fragmentSpan, parseInit } from './mp4';

const AAC = { id: 1, handler: 'soun' as const, timescale: 48000, defaultDuration: 1024 };

describe('parseInit', () => {
  it('should read timescale, handler and trex defaults per track', () => {
    const info = parseInit(mp4Init([{ ...AAC, defaultFlags: SYNC }]));
    expect(info.tracks).toEqual([
      {
        id: 1,
        timescale: 48000,
        handler: 'soun',
        defaultDuration: 1024,
        defaultFlags: SYNC,
        editShift: 0,
      },
    ]);
    expect(info.hasAudio).toBe(true);
    expect(info.hasVideo).toBe(false);
    expect(info.muxed).toBe(false);
    expect(info.encrypted).toBe(false);
  });

  it('should read a version 1 mdhd timescale', () => {
    const info = parseInit(mp4Init([{ ...AAC, timescale: 44100, mdhdV1: true }]));
    expect(info.tracks[0].timescale).toBe(44100);
  });

  it('should read the first edit media_time, version 0 and 1', () => {
    expect(parseInit(mp4Init([{ ...AAC, editShift: 2112 }])).tracks[0].editShift).toBe(2112);
    expect(
      parseInit(mp4Init([{ ...AAC, editShift: 1024, editV1: true }])).tracks[0].editShift,
    ).toBe(1024);
  });

  it('should detect an encrypted sample entry', () => {
    expect(parseInit(mp4Init([{ ...AAC, encrypted: true }])).encrypted).toBe(true);
  });

  it('should call an init with audio and video muxed', () => {
    const info = parseInit(
      mp4Init([AAC, { id: 2, handler: 'vide', timescale: 90000, defaultDuration: 3000 }]),
    );
    expect(info.hasAudio && info.hasVideo).toBe(true);
    expect(info.muxed).toBe(true);
  });
});

describe('fragmentSpan', () => {
  const init = parseInit(mp4Init([AAC]));

  it('should time a fragment from tfdt and the trex default duration', () => {
    const span = fragmentSpan(
      mp4Fragment({ trackId: 1, baseTime: 48000, samples: [{}, {}, {}] }),
      init,
    );
    expect(span).not.toBeNull();
    expect(span!.start).toBe(1);
    expect(span!.end).toBeCloseTo(1 + (3 * 1024) / 48000, 9);
    expect(span!.frameDur).toBeCloseTo(1024 / 48000, 9);
    expect(span!.frames).toBe(3);
    expect(span!.nonSync).toBe(0);
    expect(span!.syncs).toEqual([]);
  });

  it('should let the tfhd default duration override trex', () => {
    const span = fragmentSpan(
      mp4Fragment({ trackId: 1, baseTime: 0, defaultDuration: 2048, samples: [{}, {}] }),
      init,
    )!;
    expect(span.end).toBeCloseTo(4096 / 48000, 9);
    expect(span.frameDur).toBeCloseTo(2048 / 48000, 9);
  });

  it('should use per-sample durations when the trun has them', () => {
    const span = fragmentSpan(
      mp4Fragment({ trackId: 1, baseTime: 0, samples: [{ dur: 960 }, { dur: 480 }] }),
      init,
    )!;
    expect(span.end).toBeCloseTo(1440 / 48000, 9);
    expect(span.frameDur).toBeCloseTo(960 / 48000, 9);
  });

  it('should read a 64-bit tfdt', () => {
    const base = 2 ** 33 + 48000; // beyond 32 bits
    const span = fragmentSpan(
      mp4Fragment({ trackId: 1, baseTime: base, tfdtV1: true, samples: [{}] }),
      init,
    )!;
    expect(span.start).toBeCloseTo(base / 48000, 6);
  });

  it('should apply tfhd default flags and let first-sample-flags override the first', () => {
    const span = fragmentSpan(
      mp4Fragment({
        trackId: 1,
        baseTime: 0,
        defaultFlags: NON_SYNC,
        firstSampleFlags: SYNC,
        samples: [{}, {}, {}, {}],
      }),
      init,
    )!;
    expect(span.nonSync).toBe(3);
    expect(span.syncs).toEqual([0]);
  });

  it('should list sync times when sync frames sit only at the fragment start (Netflix-like)', () => {
    const samples = Array.from({ length: 8 }, (_, i) => ({ flags: i === 0 ? SYNC : NON_SYNC }));
    const span = fragmentSpan(mp4Fragment({ trackId: 1, baseTime: 96000, samples }), init)!;
    expect(span.nonSync).toBe(7);
    expect(span.frames).toBe(8);
    expect(span.syncs).toEqual([2]);
  });

  it('should list every sync time when sync frames recur', () => {
    const samples = Array.from({ length: 6 }, (_, i) => ({ flags: i % 3 === 0 ? SYNC : NON_SYNC }));
    const span = fragmentSpan(mp4Fragment({ trackId: 1, baseTime: 0, samples }), init)!;
    expect(span.syncs).toHaveLength(2);
    expect(span.syncs[1]).toBeCloseTo((3 * 1024) / 48000, 9);
  });

  it('should take trex default flags when nothing else sets them', () => {
    const nsInit = parseInit(mp4Init([{ ...AAC, defaultFlags: NON_SYNC }]));
    const span = fragmentSpan(
      mp4Fragment({ trackId: 1, baseTime: 0, firstSampleFlags: SYNC, samples: [{}, {}] }),
      nsInit,
    )!;
    expect(span.nonSync).toBe(1);
  });

  it('should apply composition offsets, unsigned in version 0', () => {
    const span = fragmentSpan(
      mp4Fragment({ trackId: 1, baseTime: 0, samples: [{ cto: 480 }, { cto: 480 }] }),
      init,
    )!;
    expect(span.presStart).toBeCloseTo(480 / 48000, 9);
    expect(span.start).toBe(0); // decode time is unchanged
  });

  it('should read version 1 composition offsets as signed', () => {
    const span = fragmentSpan(
      mp4Fragment({ trackId: 1, baseTime: 4800, trunV1: true, samples: [{ cto: -480 }] }),
      init,
    )!;
    expect(span.presStart).toBeCloseTo(4320 / 48000, 9);
  });

  it('should subtract the edit list shift from presentation times', () => {
    const shifted = parseInit(mp4Init([{ ...AAC, editShift: 2112 }]));
    const samples = [{ flags: SYNC }, { flags: NON_SYNC }];
    const span = fragmentSpan(mp4Fragment({ trackId: 1, baseTime: 48000, samples }), shifted)!;
    expect(span.presStart).toBeCloseTo((48000 - 2112) / 48000, 9);
    expect(span.syncs[0]).toBeCloseTo((48000 - 2112) / 48000, 9);
  });

  it('should fall back to the first track when the track ID is unknown', () => {
    const span = fragmentSpan(mp4Fragment({ trackId: 9, baseTime: 48000, samples: [{}] }), init);
    expect(span?.start).toBe(1);
  });

  it('should give null without a moof', () => {
    expect(fragmentSpan(new Uint8Array([0, 0, 0, 8, 0x6d, 0x64, 0x61, 0x74]), init)).toBeNull();
  });
});
