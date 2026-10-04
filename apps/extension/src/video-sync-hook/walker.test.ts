import { describe, expect, it } from 'bun:test';

import {
  NON_SYNC,
  SYNC,
  box,
  cluster,
  mp4Fragment,
  mp4Init,
  opusToc,
  simpleBlock,
  webmHeader,
} from '../test-support/media-fixtures';
import { concat } from './bytes';
import { SegmentWalker, type WalkedFragment, type WalkedInit, type WalkerFormat } from './walker';

interface Seen {
  inits: WalkedInit[];
  frags: WalkedFragment[];
  walker: SegmentWalker;
}

function walker(fmt: WalkerFormat, fragments = true): Seen {
  const seen: Omit<Seen, 'walker'> = { inits: [], frags: [] };
  const w = new SegmentWalker(
    fmt,
    { onInit: (i) => seen.inits.push(i), onFragment: (f) => seen.frags.push(f) },
    { fragments },
  );
  return { ...seen, walker: w };
}

/** Feeds the stream in pieces, the caller's buffer reused (zeroed) after each append. */
function feedSplit(fmt: WalkerFormat, stream: Uint8Array, cuts: number[]): Seen {
  const s = walker(fmt);
  let prev = 0;
  for (const c of [...cuts, stream.length]) {
    const piece = stream.slice(prev, c);
    s.walker.feed(piece);
    piece.fill(0); // a player may reuse its buffer once appendBuffer returns
    prev = c;
  }
  return s;
}

/** A comparable summary of what a walker found. */
function summary(s: Seen) {
  return {
    inits: s.inits.map((i) => ({ bytes: [...i.bytes], muxed: i.muxed, encrypted: i.encrypted })),
    frags: s.frags.map((f) => ({ ...f, data: [...f.data] })),
  };
}

const mp4Stream = concat([
  mp4Init([{ id: 1, handler: 'soun', timescale: 48000, defaultDuration: 1024, editShift: 2112 }]),
  mp4Fragment({
    trackId: 1,
    baseTime: 0,
    prefix: [box('styp', new Uint8Array(8))],
    samples: [{ flags: SYNC }, { flags: NON_SYNC }, { flags: NON_SYNC }],
  }),
  mp4Fragment({ trackId: 1, baseTime: 3072, samples: [{}, {}], sampleBytes: 7 }),
]);

const toc = new Uint8Array([opusToc(19, 0), 1, 2]);
const webmStream = concat([
  webmHeader(1e6, [{ type: 2, codec: 'A_OPUS' }]),
  cluster(0, [simpleBlock(0, 0x80, toc), simpleBlock(20, 0x80, toc)]),
  cluster(40, [simpleBlock(0, 0x80, toc)], true),
  cluster(60, [simpleBlock(0, 0x80, toc), simpleBlock(20, 0x80, toc)]),
]);

/** A small deterministic random generator. */
function rng(seed: number): () => number {
  let x = seed;
  return () => {
    x = (x * 1103515245 + 12345) & 0x7fffffff;
    return x / 0x7fffffff;
  };
}

describe('SegmentWalker (mp4)', () => {
  const whole = summary(feedSplit('mp4', mp4Stream, []));

  it('should find the init and every fragment with their prefix boxes', () => {
    expect(whole.inits).toHaveLength(1);
    expect(whole.frags).toHaveLength(2);
    expect(whole.frags[0].nonSync).toBe(2);
    expect(whole.frags[0].start).toBe(0);
    expect(whole.frags[1].start).toBeCloseTo(3072 / 48000, 9);
    // the styp travels with its fragment
    expect(String.fromCharCode(...whole.frags[0].data.slice(4, 8))).toBe('styp');
  });

  it('should give the same result split at every byte offset', () => {
    for (let c = 1; c < mp4Stream.length; c++) {
      expect(summary(feedSplit('mp4', mp4Stream, [c]))).toEqual(whole);
    }
  });

  it('should give the same result in random chunk sizes', () => {
    const r = rng(7);
    for (let run = 0; run < 50; run++) {
      const cuts: number[] = [];
      let p = 0;
      while (p < mp4Stream.length) {
        p += 1 + Math.floor(r() * 40);
        if (p < mp4Stream.length) cuts.push(p);
      }
      expect(summary(feedSplit('mp4', mp4Stream, cuts))).toEqual(whole);
    }
  });

  it('should be at a boundary only between fragments', () => {
    const s = walker('mp4');
    expect(s.walker.atBoundary()).toBe(true);
    s.walker.feed(mp4Stream.subarray(0, 10));
    expect(s.walker.atBoundary()).toBe(false);
    s.walker.feed(mp4Stream.subarray(10));
    expect(s.walker.atBoundary()).toBe(true);
  });

  it('should mark itself broken on a corrupt header without throwing', () => {
    const s = walker('mp4');
    const bad = new Uint8Array([0, 0, 0, 4, 1, 2, 3, 4, 5, 6]);
    expect(() => s.walker.feed(bad)).not.toThrow();
    expect(s.walker.broken).toBe(true);
    s.walker.feed(mp4Stream);
    expect(s.inits).toHaveLength(0);
  });

  it('should mark itself broken on a 64-bit box size smaller than its header', () => {
    const s = walker('mp4');
    // size 1 = 64-bit size follows; 12 is less than the 16-byte header
    const bad = new Uint8Array([0, 0, 0, 1, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 0, 0, 0, 0, 12]);
    expect(() => s.walker.feed(bad)).not.toThrow();
    expect(s.walker.broken).toBe(true);
  });

  it('should drop a partial box on reset, as abort() does, and carry on', () => {
    const s = walker('mp4');
    s.walker.feed(mp4Stream.subarray(0, mp4Stream.length - 5));
    s.walker.reset();
    expect(s.walker.atBoundary()).toBe(true);
    const next = mp4Fragment({ trackId: 1, baseTime: 9216, samples: [{}] });
    s.walker.feed(next);
    // the init survives the reset, so the new fragment is still timed
    expect(s.frags.at(-1)?.start).toBeCloseTo(9216 / 48000, 9);
  });

  it('should report inits only, keeping no fragment bytes, when told to', () => {
    const s = walker('mp4', false);
    s.walker.feed(mp4Stream);
    expect(s.inits).toHaveLength(1);
    expect(s.frags).toHaveLength(0);
    expect(s.walker.atBoundary()).toBe(true);
  });
});

describe('SegmentWalker (webm)', () => {
  const whole = summary(feedSplit('webm', webmStream, []));

  it('should find the init and every cluster, including one of unknown size', () => {
    expect(whole.inits).toHaveLength(1);
    expect(whole.frags.map((f) => f.start)).toEqual([0, 0.04, 0.06]);
    expect(whole.frags[0].frameDur).toBe(0.02);
  });

  it('should give the same result split at every byte offset', () => {
    for (let c = 1; c < webmStream.length; c++) {
      expect(summary(feedSplit('webm', webmStream, [c]))).toEqual(whole);
    }
  });

  it('should give the same result in random chunk sizes', () => {
    const r = rng(11);
    for (let run = 0; run < 50; run++) {
      const cuts: number[] = [];
      let p = 0;
      while (p < webmStream.length) {
        p += 1 + Math.floor(r() * 30);
        if (p < webmStream.length) cuts.push(p);
      }
      expect(summary(feedSplit('webm', webmStream, cuts))).toEqual(whole);
    }
  });

  it('should mark itself broken on an unknown size it cannot follow', () => {
    const s = walker('webm');
    s.walker.feed(webmHeader(1e6, [{ type: 2, codec: 'A_OPUS' }]));
    // a Cues element of unknown size
    expect(() => s.walker.feed(new Uint8Array([0x1c, 0x53, 0xbb, 0x6b, 0xff]))).not.toThrow();
    expect(s.walker.broken).toBe(true);
  });
});
