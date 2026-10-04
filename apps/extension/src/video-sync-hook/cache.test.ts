import { describe, expect, it } from 'bun:test';

import { addEntry, createCache, evict, forgetRange, type CacheEntry, type InitRef } from './cache';

const INIT: InitRef = { bytes: new Uint8Array([1]), encrypted: false };

function entry(vStart: number, vEnd: number, extra: Partial<CacheEntry> = {}): CacheEntry {
  return {
    data: new Uint8Array(extra.data?.length ?? 100),
    init: INIT,
    vTO: 0,
    vAWS: 0,
    vAWE: Infinity,
    vStart,
    vEnd,
    frameDur: 0.02,
    syncs: null,
    ...extra,
  };
}

const spans = (c: ReturnType<typeof createCache>) =>
  c.entries.map((e) => [e.vStart, e.vEnd, e.vAWS, e.vAWE]);

describe('addEntry', () => {
  it('should keep entries in start order and count their bytes', () => {
    const c = createCache();
    addEntry(c, entry(4, 6));
    addEntry(c, entry(0, 2));
    addEntry(c, entry(2, 4));
    expect(c.entries.map((e) => e.vStart)).toEqual([0, 2, 4]);
    expect(c.bytes).toBe(300);
  });

  it('should keep the tail of a partly overlapped fragment, its window start moved (quality switch)', () => {
    const c = createCache();
    addEntry(c, entry(0, 4)); // low quality
    addEntry(c, entry(0, 2)); // high quality over its first half
    // equal starts keep arrival order: the kept tail first
    expect(spans(c)).toEqual([
      [0, 4, 2, Infinity],
      [0, 2, 0, Infinity],
    ]);
  });

  it('should keep the head of a fragment overlapped at its end, its window end moved', () => {
    const c = createCache();
    addEntry(c, entry(0, 4));
    addEntry(c, entry(3, 6));
    expect(spans(c)).toEqual([
      [0, 4, 0, 3],
      [3, 6, 0, Infinity],
    ]);
  });

  it('should drop a fragment the new one covers whole', () => {
    const c = createCache();
    addEntry(c, entry(1, 3));
    addEntry(c, entry(0, 4));
    expect(spans(c)).toEqual([[0, 4, 0, Infinity]]);
  });

  it('should keep a non-sync tail only from its next random access point (review fix 2)', () => {
    const c = createCache();
    addEntry(c, entry(0, 6, { syncs: [0, 3] }));
    expect(c.nonSync).toBe(true);
    addEntry(c, entry(0, 2, { syncs: [0] }));
    expect(spans(c)).toEqual([
      [0, 6, 3, Infinity],
      [0, 2, 0, Infinity],
    ]);
  });

  it('should drop a non-sync tail with no random access point left', () => {
    const c = createCache();
    addEntry(c, entry(0, 6, { syncs: [0] }));
    addEntry(c, entry(0, 2, { syncs: [0] }));
    expect(spans(c)).toEqual([[0, 2, 0, Infinity]]);
  });

  it('should not switch to random-access cuts for a fragment that is all non-sync', () => {
    const c = createCache();
    addEntry(c, entry(0, 2, { syncs: [] }));
    expect(c.nonSync).toBe(false);
  });

  it('should leave touching fragments alone', () => {
    const c = createCache();
    addEntry(c, entry(0, 2));
    addEntry(c, entry(2.003, 4));
    expect(c.entries).toHaveLength(2);
  });
});

describe('evict', () => {
  it('should drop entries ending more than 3 s behind the playhead', () => {
    const c = createCache();
    for (let t = 0; t < 20; t += 2) addEntry(c, entry(t, t + 2));
    evict(c, 10, 0);
    expect(c.entries[0].vStart).toBe(6); // ends at 8 > 10 - 3
  });

  it('should judge "behind" in both timelines while audio is shifted earlier', () => {
    const c = createCache();
    for (let t = 0; t < 20; t += 2) addEntry(c, entry(t, t + 2));
    evict(c, 10, -0.9);
    expect(c.entries[0].vStart).toBe(6);
  });

  it('should drop the entry farthest from the playhead over the cap', () => {
    const c = createCache();
    for (let t = 0; t < 10; t++) addEntry(c, entry(t, t + 1, { data: new Uint8Array(10) }));
    evict(c, 4, 0, 45);
    // [0,1] ends 3 s behind and goes first; then the farthest start from 4
    // goes (the earlier one on a tie) until no more than 45 bytes are left
    expect(c.entries.map((e) => e.vStart)).toEqual([3, 4, 5, 6]);
    expect(c.bytes).toBe(40);
  });

  it('should only apply the cap without a playhead', () => {
    const c = createCache();
    for (let t = 0; t < 4; t++) addEntry(c, entry(t, t + 1, { data: new Uint8Array(10) }));
    evict(c, null, 0, 25);
    expect(c.entries.map((e) => e.vStart)).toEqual([0, 1]);
  });
});

describe('forgetRange', () => {
  it('should forget entries inside a removed range only', () => {
    const c = createCache();
    addEntry(c, entry(0, 2));
    addEntry(c, entry(2, 4));
    addEntry(c, entry(4, 6));
    forgetRange(c, 2, 6);
    expect(c.entries.map((e) => e.vStart)).toEqual([0]);
    expect(c.bytes).toBe(100);
  });
});
