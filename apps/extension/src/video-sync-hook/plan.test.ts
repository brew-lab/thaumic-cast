import { describe, expect, it } from 'bun:test';

import type { CacheEntry } from './cache';
import {
  cacheCovers,
  natEndAfter,
  planSwitch,
  rapAhead,
  rapTimes,
  rescaleRate,
  targetOffset,
  type SwitchInput,
} from './plan';

const AAC_FRAME = 1024 / 48000;

function entry(vStart: number, vEnd: number, extra: Partial<CacheEntry> = {}): CacheEntry {
  return {
    data: new Uint8Array(1),
    init: { bytes: new Uint8Array(1), encrypted: false },
    vTO: 0,
    vAWS: 0,
    vAWE: Infinity,
    vStart,
    vEnd,
    frameDur: AAC_FRAME,
    syncs: null,
    ...extra,
  };
}

function input(over: Partial<SwitchInput>): SwitchInput {
  return {
    ct: 1,
    rate: 1,
    canCache: true,
    fromOff: 0,
    newOff: -0.9,
    nonSync: false,
    encrypted: false,
    frameDur: AAC_FRAME,
    entries: [],
    native: [],
    ...over,
  };
}

describe('targetOffset', () => {
  const base = { active: true, leadS: 0.9, rate: 1, encrypted: false, frameDur: AAC_FRAME };

  it('should move audio earlier by the lead', () => {
    expect(targetOffset(base)).toBeCloseTo(-0.9, 12);
  });

  it('should scale the lead by the playback rate', () => {
    expect(targetOffset({ ...base, rate: 1.5 })).toBeCloseTo(-1.35, 12);
  });

  it('should round encrypted audio to whole frames: 900 ms at 1024/48000 is 896 ms', () => {
    const off = targetOffset({ ...base, encrypted: true });
    expect(off).toBeCloseTo(-42 * AAC_FRAME, 12);
    expect(Math.round(-off * 1000)).toBe(896);
  });

  it('should be 0 when inactive or without a lead', () => {
    expect(targetOffset({ ...base, active: false })).toBe(0);
    expect(targetOffset({ ...base, leadS: 0 })).toBe(0);
  });
});

describe('rescaleRate', () => {
  it('should keep the old scale while the error stays within 20 ms', () => {
    expect(rescaleRate(1.02, 1, 0.9, -0.9)).toBe(1); // 18 ms
  });

  it('should rescale once the error passes 20 ms', () => {
    expect(rescaleRate(1.05, 1, 0.9, -0.9)).toBe(1.05); // 45 ms
    expect(rescaleRate(1.5, 1, 0.9, -0.9)).toBe(1.5);
  });

  it('should always follow the rate while nothing is shifted', () => {
    expect(rescaleRate(1.01, 1, 0.9, 0)).toBe(1.01);
  });
});

describe('rapTimes and rapAhead', () => {
  it('should list the frame grid of an all-sync fragment inside its window', () => {
    const e = entry(0, 0.1, { frameDur: 0.025, vAWS: 0.03 });
    const got = rapTimes(e, 0);
    expect(got).toHaveLength(2);
    expect(got[0]).toBeCloseTo(0.05, 12);
    expect(got[1]).toBeCloseTo(0.075, 12);
  });

  it('should list the sync frames of a non-sync fragment inside its window', () => {
    expect(rapTimes(entry(0, 8, { syncs: [0, 4], vAWS: 1 }), 0)).toEqual([4]);
  });

  it('should find the first shifted random access point at or after a time', () => {
    const list = [entry(0, 4, { syncs: [0] }), entry(4, 8, { syncs: [4] })];
    expect(rapAhead(list, 1.5, -0.9, AAC_FRAME)).toBeCloseTo(3.1, 12);
    expect(rapAhead(list, 3.2, -0.9, AAC_FRAME)).toBeNull();
  });
});

describe('natEndAfter and cacheCovers', () => {
  it('should find the end of data buffered beyond a time', () => {
    expect(
      natEndAfter(
        [
          [0, 5],
          [6, 9],
        ],
        1,
      ),
    ).toBe(9);
    expect(natEndAfter([[0, 1.02]], 1)).toBeNull();
  });

  it('should need the cache to reach the end of every range beyond the cut', () => {
    const list = [entry(1, 4), entry(4, 8)];
    expect(cacheCovers([[0, 8]], list, 1.5, 0, -0.9)).toBe(true);
    expect(cacheCovers([[0, 8]], [entry(1, 4)], 1.5, 0, -0.9)).toBe(false);
    expect(cacheCovers([[0, 8]], [entry(1, 4), entry(4.5, 8)], 1.5, 0, -0.9)).toBe(false);
  });
});

describe('planSwitch', () => {
  it('should cut just ahead of the playhead and re-append what lies beyond', () => {
    const entries = [entry(0, 2), entry(2, 4), entry(4, 6)];
    const p = planSwitch(input({ entries, native: [[0, 6]] }));
    expect(p.action).toBe('switch');
    if (p.action !== 'switch') return;
    expect(p.cut).toBeCloseTo(1.5, 12);
    expect(p.awsEps).toBe(0);
    expect(p.list.map((e) => e.vStart)).toEqual([2, 4]);
  });

  it('should cut on the first shifted random access point for non-sync audio (Netflix-like)', () => {
    const entries = [entry(0, 4, { syncs: [0] }), entry(4, 8, { syncs: [4] })];
    const p = planSwitch(input({ entries, native: [[0, 8]], nonSync: true }));
    expect(p.action).toBe('switch');
    if (p.action !== 'switch') return;
    expect(p.cut).toBeCloseTo(3.1, 12);
    expect(p.awsEps).toBe(0.001);
    expect(p.list.map((e) => e.vStart)).toEqual([4]);
  });

  it('should defer moving later when the buffered audio ends before the random access point', () => {
    const entries = [entry(0, 4, { syncs: [0] }), entry(4, 8, { syncs: [4] })];
    const p = planSwitch(
      input({ entries, native: [[0, 3]], nonSync: true, fromOff: -0.9, newOff: 0 }),
    );
    expect(p).toEqual({
      action: 'defer',
      why: 'the buffered audio ends before the next random access point',
    });
  });

  it('should drain moving earlier when no random access point lies ahead', () => {
    const entries = [entry(0, 4, { syncs: [0] })];
    const p = planSwitch(input({ entries, native: [[0, 4]], nonSync: true }));
    expect(p).toEqual({ action: 'drain', why: 'no random access point ahead in the cache' });
  });

  it('should defer moving later without cover and drain moving earlier (review fix 1)', () => {
    const entries = [entry(0, 2)];
    expect(planSwitch(input({ entries, native: [[0, 7.1]], fromOff: -0.9, newOff: 0 }))).toEqual({
      action: 'defer',
      why: 'cache does not cover what is buffered ahead',
    });
    expect(planSwitch(input({ entries, native: [[0, 8]] }))).toEqual({
      action: 'drain',
      why: 'cache does not cover what is buffered ahead',
    });
  });

  it('should cut encrypted audio on a frame boundary of the new placement', () => {
    const newOff = -42 * AAC_FRAME;
    const entries = [entry(0, 2), entry(2, 4), entry(4, 6)];
    const p = planSwitch(input({ entries, native: [[0, 6]], encrypted: true, newOff }));
    expect(p.action).toBe('switch');
    if (p.action !== 'switch') return;
    const frames = (p.cut - (2 + newOff)) / AAC_FRAME;
    expect(Math.abs(frames - Math.round(frames))).toBeLessThan(1e-6);
    expect(p.cut).toBeGreaterThanOrEqual(1.5);
    expect(p.cut).toBeLessThan(1.5 + AAC_FRAME);
    expect(p.awsEps).toBe(0.001);
  });

  it('should keep the cut at least 150 ms ahead at low rates and scale it at high ones', () => {
    const entries = [entry(0, 2), entry(2, 4)];
    const slow = planSwitch(input({ entries, native: [[0, 4]], rate: 0.25 }));
    const fast = planSwitch(input({ entries, native: [[0, 4]], rate: 2 }));
    expect(slow.action === 'switch' && slow.cut).toBeCloseTo(1.15, 12);
    expect(fast.action === 'switch' && fast.cut).toBeCloseTo(2, 12);
  });

  it('should drain or defer without a playhead or a cache', () => {
    expect(planSwitch(input({ ct: null, native: [[0, 4]] }))).toEqual({
      action: 'drain',
      why: 'no-playhead',
    });
    expect(planSwitch(input({ ct: null, native: [[0, 4]], fromOff: -0.9, newOff: 0 }))).toEqual({
      action: 'defer',
      why: 'no-playhead',
    });
    expect(planSwitch(input({ canCache: false, native: [], fromOff: -0.9, newOff: 0 }))).toEqual({
      action: 'drain',
      why: 'no-cache',
    });
  });
});
