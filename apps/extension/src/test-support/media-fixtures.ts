/**
 * Builds small fragmented-MP4 and WebM byte streams in code for the video
 * sync hook's parser tests. Only the boxes and elements the hook reads are
 * filled in; sample data is filler.
 */

import { concat } from '../video-sync-hook/bytes';

/**
 * Big-endian 32-bit unsigned.
 * @param v - The value
 * @returns Four bytes
 */
export function u32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0);
  return b;
}

/**
 * Big-endian 32-bit signed.
 * @param v - The value
 * @returns Four bytes
 */
export function i32(v: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v);
  return b;
}

/**
 * Big-endian 64-bit unsigned.
 * @param v - The value
 * @returns Eight bytes
 */
export function u64(v: number): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(v));
  return b;
}

/**
 * ASCII bytes.
 * @param s - The text
 * @returns One byte per character
 */
export function ascii(s: string): Uint8Array {
  return new Uint8Array([...s].map((c) => c.charCodeAt(0)));
}

/**
 * An ISO BMFF box.
 * @param t - The box type
 * @param parts - The body, in pieces
 * @returns The box
 */
export function box(t: string, ...parts: Uint8Array[]): Uint8Array {
  const body = concat(parts);
  return concat([u32(body.length + 8), ascii(t), body]);
}

/**
 * An ISO BMFF full box (version and flags).
 * @param t - The box type
 * @param v - The version
 * @param flags - The 24-bit flags
 * @param parts - The rest of the body, in pieces
 * @returns The box
 */
export function fullBox(t: string, v: number, flags: number, ...parts: Uint8Array[]): Uint8Array {
  return box(
    t,
    new Uint8Array([v, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255]),
    ...parts,
  );
}

/** Sample flags: a sync sample. */
export const SYNC = 0x02000000;
/** Sample flags: a non-sync sample (depends on others). */
export const NON_SYNC = 0x01010000;

/** One track of an fMP4 init segment. */
export interface TrackSpec {
  id: number;
  handler: 'soun' | 'vide';
  timescale: number;
  defaultDuration?: number;
  defaultFlags?: number;
  /** First edit's media_time. */
  editShift?: number;
  /** Write the elst as version 1. */
  editV1?: boolean;
  /** Use an `enca` / `encv` sample entry. */
  encrypted?: boolean;
  /** Write mdhd as version 1. */
  mdhdV1?: boolean;
}

/**
 * Builds an fMP4 init segment (ftyp + moov).
 * @param tracks - The tracks
 * @returns The init segment
 */
export function mp4Init(tracks: TrackSpec[]): Uint8Array {
  const traks = tracks.map((t) => {
    const tkhd = fullBox(
      'tkhd',
      0,
      3,
      u32(0),
      u32(0),
      u32(t.id),
      u32(0),
      u32(0),
      new Uint8Array(60),
    );
    const mdhd = t.mdhdV1
      ? fullBox('mdhd', 1, 0, u64(0), u64(0), u32(t.timescale), u64(0), u32(0))
      : fullBox('mdhd', 0, 0, u32(0), u32(0), u32(t.timescale), u32(0), u32(0));
    const hdlr = fullBox('hdlr', 0, 0, u32(0), ascii(t.handler), new Uint8Array(12), ascii('h\0'));
    const entry =
      t.handler === 'soun' ? (t.encrypted ? 'enca' : 'mp4a') : t.encrypted ? 'encv' : 'avc1';
    const stsd = fullBox('stsd', 0, 0, u32(1), box(entry, new Uint8Array(28)));
    const stbl = box('stbl', stsd);
    const minf = box('minf', stbl);
    const mdia = box('mdia', mdhd, hdlr, minf);
    const parts = [tkhd];
    if (t.editShift !== undefined) {
      const elst = t.editV1
        ? fullBox('elst', 1, 0, u32(1), u64(0), u64(t.editShift), u32(0x00010000))
        : fullBox('elst', 0, 0, u32(1), u32(0), u32(t.editShift), u32(0x00010000));
      parts.push(box('edts', elst));
    }
    parts.push(mdia);
    return box('trak', ...parts);
  });
  const trex = tracks.map((t) =>
    fullBox(
      'trex',
      0,
      0,
      u32(t.id),
      u32(1),
      u32(t.defaultDuration ?? 0),
      u32(0),
      u32(t.defaultFlags ?? 0),
    ),
  );
  return concat([
    box('ftyp', ascii('iso6'), u32(0), ascii('iso6mp41')),
    box('moov', fullBox('mvhd', 0, 0, new Uint8Array(96)), ...traks, box('mvex', ...trex)),
  ]);
}

/** One sample of a trun. Fields given on any sample are written for all. */
export interface SampleSpec {
  dur?: number;
  size?: number;
  flags?: number;
  cto?: number;
}

/** One media fragment. */
export interface FragmentSpec {
  trackId: number;
  /** tfdt base media decode time, in ticks. */
  baseTime: number;
  tfdtV1?: boolean;
  /** tfhd default-sample-duration. */
  defaultDuration?: number;
  /** tfhd default-sample-flags. */
  defaultFlags?: number;
  /** trun first-sample-flags. */
  firstSampleFlags?: number;
  /** Write trun as version 1 (signed composition offsets). */
  trunV1?: boolean;
  samples: SampleSpec[];
  /** Boxes before the moof (styp, sidx...). */
  prefix?: Uint8Array[];
  /** Bytes of filler per sample in the mdat. */
  sampleBytes?: number;
}

/**
 * Builds a media fragment (optional prefix, moof, mdat).
 * @param f - The fragment
 * @returns Its bytes
 */
export function mp4Fragment(f: FragmentSpec): Uint8Array {
  const has = (k: keyof SampleSpec): boolean => f.samples.some((s) => s[k] !== undefined);
  let tfhdFlags = 0x020000; // default-base-is-moof
  const tfhdParts = [u32(f.trackId)];
  if (f.defaultDuration !== undefined) {
    tfhdFlags |= 0x8;
    tfhdParts.push(u32(f.defaultDuration));
  }
  if (f.defaultFlags !== undefined) {
    tfhdFlags |= 0x20;
    tfhdParts.push(u32(f.defaultFlags));
  }
  let trunFlags = 0x1; // data offset
  if (f.firstSampleFlags !== undefined) trunFlags |= 0x4;
  if (has('dur')) trunFlags |= 0x100;
  if (has('size') || f.sampleBytes) trunFlags |= 0x200;
  if (has('flags')) trunFlags |= 0x400;
  if (has('cto')) trunFlags |= 0x800;
  const per = f.sampleBytes ?? 4;
  const entries: Uint8Array[] = [];
  for (const s of f.samples) {
    if (trunFlags & 0x100) entries.push(u32(s.dur ?? 0));
    if (trunFlags & 0x200) entries.push(u32(s.size ?? per));
    if (trunFlags & 0x400) entries.push(u32(s.flags ?? 0));
    if (trunFlags & 0x800) entries.push(f.trunV1 ? i32(s.cto ?? 0) : u32(s.cto ?? 0));
  }
  const mk = (dataOffset: number): Uint8Array => {
    const trunHead = [u32(f.samples.length), u32(dataOffset)];
    if (f.firstSampleFlags !== undefined) trunHead.push(u32(f.firstSampleFlags));
    return box(
      'moof',
      fullBox('mfhd', 0, 0, u32(1)),
      box(
        'traf',
        fullBox('tfhd', 0, tfhdFlags, ...tfhdParts),
        f.tfdtV1 ? fullBox('tfdt', 1, 0, u64(f.baseTime)) : fullBox('tfdt', 0, 0, u32(f.baseTime)),
        fullBox('trun', f.trunV1 ? 1 : 0, trunFlags, ...trunHead, ...entries),
      ),
    );
  };
  const moofLen = mk(0).length;
  const moof = mk(moofLen + 8);
  const mdatBody = new Uint8Array(f.samples.reduce((n, s) => n + (s.size ?? per), 0)).fill(0xab);
  return concat([...(f.prefix ?? []), moof, box('mdat', mdatBody)]);
}

// ───────────────────────────────────────────────────────────── WebM

/**
 * Bytes of an EBML ID (the marker bits are part of the value).
 * @param id - The ID
 * @returns Its bytes
 */
function idBytes(id: number): Uint8Array {
  const out: number[] = [];
  let v = id;
  while (v > 0) {
    out.unshift(v & 255);
    v = Math.floor(v / 256);
  }
  return new Uint8Array(out);
}

/**
 * An 8-byte EBML size, or the unknown-size marker.
 * @param n - The size, or null for unknown
 * @returns Eight bytes
 */
function sizeBytes(n: number | null): Uint8Array {
  if (n === null) return new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const b = new Uint8Array(8);
  b[0] = 0x01;
  let v = n;
  for (let i = 7; i >= 1; i--) {
    b[i] = v & 255;
    v = Math.floor(v / 256);
  }
  return b;
}

/**
 * An EBML element.
 * @param id - The element ID
 * @param data - The body, whole or in pieces
 * @param unknown - Write the unknown-size marker
 * @returns The element
 */
export function el(id: number, data: Uint8Array | Uint8Array[], unknown = false): Uint8Array {
  const body = Array.isArray(data) ? concat(data) : data;
  return concat([idBytes(id), sizeBytes(unknown ? null : body.length), body]);
}

/**
 * A big-endian unsigned integer of minimal length.
 * @param v - The value
 * @returns Its bytes
 */
export function uintBytes(v: number): Uint8Array {
  const out: number[] = [];
  let x = v;
  do {
    out.unshift(x & 255);
    x = Math.floor(x / 256);
  } while (x > 0);
  return new Uint8Array(out);
}

/** One WebM track. */
export interface WebmTrackSpec {
  /** 1 video, 2 audio. */
  type: number;
  codec: string;
  defaultDuration?: number;
  encrypted?: boolean;
}

/**
 * EBML header, Segment start (unknown size), Info and Tracks.
 * @param timecodeScale - TimecodeScale in ns
 * @param tracks - The tracks
 * @returns The init segment
 */
export function webmHeader(timecodeScale: number, tracks: WebmTrackSpec[]): Uint8Array {
  const entries = tracks.map((t, i) => {
    const kids = [
      el(0xd7, uintBytes(i + 1)),
      el(0x83, uintBytes(t.type)),
      el(0x86, ascii(t.codec)),
    ];
    if (t.defaultDuration) kids.push(el(0x23e383, uintBytes(t.defaultDuration)));
    if (t.encrypted) kids.push(el(0x6d80, el(0x6240, el(0x5035, el(0x47e1, uintBytes(5))))));
    return el(0xae, kids);
  });
  return concat([
    el(0x1a45dfa3, el(0x4282, ascii('webm'))),
    concat([idBytes(0x18538067), sizeBytes(null)]),
    el(0x1549a966, el(0x2ad7b1, uintBytes(timecodeScale))),
    el(0x1654ae6b, entries),
  ]);
}

/**
 * A SimpleBlock on track 1.
 * @param rel - Relative timecode
 * @param flags - Block flags
 * @param payload - Frame bytes
 * @returns The element
 */
export function simpleBlock(rel: number, flags: number, payload: Uint8Array): Uint8Array {
  const head = new Uint8Array([0x81, (rel >> 8) & 255, rel & 255, flags]);
  return el(0xa3, concat([head, payload]));
}

/**
 * A BlockGroup with a Block on track 1 and an optional BlockDuration.
 * @param rel - Relative timecode
 * @param payload - Frame bytes
 * @param duration - BlockDuration in timecode units
 * @returns The element
 */
export function blockGroup(rel: number, payload: Uint8Array, duration?: number): Uint8Array {
  const head = new Uint8Array([0x81, (rel >> 8) & 255, rel & 255, 0]);
  const kids = [el(0xa1, concat([head, payload]))];
  if (duration !== undefined) kids.push(el(0x9b, uintBytes(duration)));
  return el(0xa0, kids);
}

/**
 * A Cluster with a Timecode and the given block elements.
 * @param timecode - Cluster Timecode
 * @param blocks - Block elements
 * @param unknown - Write the unknown-size marker
 * @returns The element
 */
export function cluster(timecode: number, blocks: Uint8Array[], unknown = false): Uint8Array {
  return el(0x1f43b675, [el(0xe7, uintBytes(timecode)), ...blocks], unknown);
}

/**
 * An Opus TOC byte.
 * @param config - Configuration number, 0..31
 * @param code - Frame-count code, 0..3
 * @param stereo - Stereo flag
 * @returns The byte
 */
export function opusToc(config: number, code: number, stereo = false): number {
  return (config << 3) | (stereo ? 4 : 0) | code;
}
