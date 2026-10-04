import { describe, expect, it } from 'bun:test';

import {
  blockGroup,
  cluster,
  el,
  opusToc,
  simpleBlock,
  uintBytes,
  webmHeader,
} from '../test-support/media-fixtures';
import { SegmentWalker, type WalkedFragment, type WalkedInit } from './walker';
import {
  clusterCacheSpan,
  clusterSpan,
  dataStart,
  opusDur,
  vint,
  webmTimecodeScale,
  webmTrackInfo,
  type WebmTrack,
} from './webm';

const OPUS: WebmTrack = { codec: 'A_OPUS', defaultDuration: 0, encrypted: false, type: 2 };

/** Spans a Cluster as the hook does: from its first child. */
function span(bytes: Uint8Array, track: WebmTrack | null, scale = 1e6) {
  return clusterSpan(bytes, dataStart(bytes), { timecodeScale: scale, track });
}

describe('vint', () => {
  it('should read sizes and IDs of every length', () => {
    expect(vint(new Uint8Array([0x81]), 0, false)).toEqual({ v: 1, len: 1, unknown: false });
    expect(vint(new Uint8Array([0x40, 0x02]), 0, false)).toEqual({ v: 2, len: 2, unknown: false });
    expect(vint(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]), 0, true)?.v).toBe(0x1a45dfa3);
  });

  it('should flag the unknown-size marker', () => {
    expect(vint(new Uint8Array([0xff]), 0, false)?.unknown).toBe(true);
    expect(vint(new Uint8Array([0x01, 255, 255, 255, 255, 255, 255, 255]), 0, false)?.unknown).toBe(
      true,
    );
  });

  it('should give null when the bytes run out', () => {
    expect(vint(new Uint8Array([0x40]), 0, false)).toBeNull();
    expect(vint(new Uint8Array([0x00]), 0, false)).toBeNull();
  });
});

describe('Info and Tracks', () => {
  it('should read TimecodeScale', () => {
    expect(webmTimecodeScale(el(0x1549a966, el(0x2ad7b1, uintBytes(500000))))).toBe(500000);
    expect(webmTimecodeScale(el(0x1549a966, new Uint8Array(0)))).toBe(1e6);
  });

  it('should read each track and call audio with video muxed', () => {
    const header = webmHeader(1e6, [
      { type: 2, codec: 'A_OPUS', encrypted: true },
      { type: 1, codec: 'V_VP9', defaultDuration: 40e6 },
    ]);
    // Tracks is the last element of the header
    const walker = new SegmentWalker(
      'webm',
      { onInit: (i) => inits.push(i), onFragment: () => {} },
      { fragments: true },
    );
    const inits: WalkedInit[] = [];
    walker.feed(header);
    expect(inits).toHaveLength(1);
    expect(inits[0].muxed).toBe(true);
    expect(inits[0].encrypted).toBe(true);
    const tracksStart = header.length - findTracksLength(header);
    const info = webmTrackInfo(header.subarray(tracksStart));
    expect(info.tracks.map((t) => t.codec)).toEqual(['A_OPUS', 'V_VP9']);
    expect(info.tracks[1].defaultDuration).toBe(40e6);
  });
});

/** Length of the trailing Tracks element of a fixture header. */
function findTracksLength(header: Uint8Array): number {
  for (let i = 0; i + 4 <= header.length; i++) {
    if (
      header[i] === 0x16 &&
      header[i + 1] === 0x54 &&
      header[i + 2] === 0xae &&
      header[i + 3] === 0x6b
    ) {
      return header.length - i;
    }
  }
  throw new Error('no Tracks');
}

describe('opusDur', () => {
  it('should give the frame size of each config range', () => {
    const one = (config: number) => opusDur(new Uint8Array([opusToc(config, 0)]), 0);
    // SILK-only 0..11: 10, 20, 40, 60 ms
    expect([0, 1, 2, 3].map(one)).toEqual([0.01, 0.02, 0.04, 0.06]);
    expect(one(11)).toBe(0.06);
    // Hybrid 12..15: 10, 20 ms
    expect([12, 13, 14, 15].map(one)).toEqual([0.01, 0.02, 0.01, 0.02]);
    // CELT-only 16..31: 2.5, 5, 10, 20 ms
    expect([16, 17, 18, 19].map(one)).toEqual([0.0025, 0.005, 0.01, 0.02]);
    expect(one(31)).toBe(0.02);
  });

  it('should count frames for codes 1, 2 and 3', () => {
    expect(opusDur(new Uint8Array([opusToc(19, 1)]), 0)).toBe(0.04);
    expect(opusDur(new Uint8Array([opusToc(19, 2)]), 0)).toBe(0.04);
    expect(opusDur(new Uint8Array([opusToc(19, 3), 3]), 0)).toBeCloseTo(0.06, 9);
    expect(opusDur(new Uint8Array([opusToc(19, 3), 0]), 0)).toBeNull();
    expect(opusDur(new Uint8Array([]), 0)).toBeNull();
  });
});

describe('clusterSpan', () => {
  it('should time Opus blocks from their TOC bytes', () => {
    const toc = new Uint8Array([opusToc(19, 0), 0, 0]);
    const c = cluster(1000, [simpleBlock(0, 0x80, toc), simpleBlock(20, 0x80, toc)]);
    const s = span(c, OPUS)!;
    expect(s.s).toBe(1);
    expect(s.e).toBeCloseTo(1.04, 9);
    expect(s.frameDur).toBe(0.02);
    expect(s.estimated).toBe(false);
  });

  it('should honour TimecodeScale', () => {
    const toc = new Uint8Array([opusToc(19, 0)]);
    const s = span(cluster(2000, [simpleBlock(0, 0x80, toc)]), OPUS, 500000)!;
    expect(s.s).toBe(1);
  });

  it('should multiply DefaultDuration by the frames in a laced block', () => {
    const track: WebmTrack = {
      codec: 'A_VORBIS',
      defaultDuration: 10e6,
      encrypted: false,
      type: 2,
    };
    // Xiph lacing (flags bit 1), 3 frames: lace count byte = 2
    const c = cluster(0, [simpleBlock(0, 0x82, new Uint8Array([2, 1, 1, 9, 9, 9]))]);
    const s = span(c, track)!;
    expect(s.e).toBeCloseTo(0.03, 9);
  });

  it('should take a BlockGroup duration', () => {
    const s = span(cluster(0, [blockGroup(0, new Uint8Array([1]), 33)]), {
      codec: 'V_VP9',
      defaultDuration: 0,
      encrypted: false,
      type: 1,
    })!;
    expect(s.e).toBeCloseTo(0.033, 9);
    expect(s.estimated).toBe(false);
  });

  it('should not read the TOC of an encrypted Opus frame', () => {
    const enc: WebmTrack = { ...OPUS, encrypted: true };
    // signal byte 1: encrypted, so the next byte is an IV, not a TOC
    const blocks = [
      simpleBlock(0, 0x80, new Uint8Array([1, opusToc(19, 3), 9])),
      simpleBlock(20, 0x80, new Uint8Array([1, opusToc(19, 3), 9])),
    ];
    const s = span(cluster(0, blocks), enc)!;
    // first block takes the gap to the next; the last is estimated from the gaps
    expect(s.e).toBeCloseTo(0.04, 9);
    expect(s.estimated).toBe(true);
    // a clear frame (signal 0) has its TOC right after the signal byte
    const clear = span(
      cluster(0, [simpleBlock(0, 0x80, new Uint8Array([0, opusToc(19, 0)]))]),
      enc,
    )!;
    expect(clear.e).toBeCloseTo(0.02, 9);
  });

  it('should estimate the last video block from the largest gap', () => {
    const video: WebmTrack = { codec: 'V_VP9', defaultDuration: 0, encrypted: false, type: 1 };
    const one = new Uint8Array([1]);
    const s = span(
      cluster(0, [simpleBlock(0, 0x80, one), simpleBlock(33, 0, one), simpleBlock(100, 0, one)]),
      video,
    )!;
    expect(s.estimated).toBe(true);
    expect(s.e).toBeCloseTo(0.1 + 0.067, 9);
  });

  it('should give null without a Timecode or blocks', () => {
    expect(span(cluster(0, []), OPUS)).toBeNull();
  });
});

describe('clusterCacheSpan', () => {
  it('should key a Cluster by its Timecode and last block', () => {
    const one = new Uint8Array([opusToc(19, 0)]);
    const c = cluster(3000, [simpleBlock(0, 0x80, one), simpleBlock(980, 0x80, one)]);
    expect(clusterCacheSpan(c, dataStart(c), 1e6)).toEqual({ start: 3, end: 3.98 + 0.02 });
  });

  it('should read a Cluster of unknown size', () => {
    const one = new Uint8Array([opusToc(19, 0)]);
    const c = cluster(1000, [simpleBlock(0, 0x80, one), simpleBlock(20, 0x80, one)], true);
    const got = clusterCacheSpan(c, dataStart(c), 1e6)!;
    expect(got.start).toBe(1);
    expect(got.end).toBeCloseTo(1.04, 9);
    const frags: WalkedFragment[] = [];
    const w = new SegmentWalker(
      'webm',
      { onInit: () => {}, onFragment: (f) => frags.push(f) },
      { fragments: true },
    );
    w.feed(webmHeader(1e6, [{ type: 2, codec: 'A_OPUS' }]));
    w.feed(c);
    expect(w.atBoundary()).toBe(false); // still open until the next level-1 element
    w.feed(cluster(2000, [simpleBlock(0, 0x80, one)]));
    expect(frags.map((f) => f.start)).toEqual([1, 2]);
  });
});
