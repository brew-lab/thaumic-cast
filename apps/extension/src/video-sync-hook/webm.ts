/**
 * WebM (EBML / Matroska) parsing for the video sync hook.
 *
 * Block headers are never encrypted, so encrypted WebM parses like clear
 * WebM, except that an encrypted Opus frame's TOC byte cannot be read.
 */

/** EBML element IDs the hook reads. */
export const EBML_ID = {
  EBML: 0x1a45dfa3,
  Segment: 0x18538067,
  SeekHead: 0x114d9b74,
  Info: 0x1549a966,
  TimecodeScale: 0x2ad7b1,
  Tracks: 0x1654ae6b,
  TrackEntry: 0xae,
  TrackType: 0x83,
  CodecID: 0x86,
  DefaultDuration: 0x23e383,
  ContentEncodings: 0x6d80,
  Cluster: 0x1f43b675,
  Timecode: 0xe7,
  SimpleBlock: 0xa3,
  BlockGroup: 0xa0,
  Block: 0xa1,
  BlockDuration: 0x9b,
  Cues: 0x1c53bb6b,
  Tags: 0x1254c367,
  Attachments: 0x1941a469,
  Chapters: 0x1043a770,
  Void: 0xec,
} as const;

/** Children of Segment: seeing one closes a Cluster of unknown size. */
export const EBML_LEVEL1: ReadonlySet<number> = new Set([
  EBML_ID.SeekHead,
  EBML_ID.Info,
  EBML_ID.Tracks,
  EBML_ID.Cluster,
  EBML_ID.Cues,
  EBML_ID.Tags,
  EBML_ID.Attachments,
  EBML_ID.Chapters,
]);

/** Matroska TrackType values. */
export const TRACK_TYPE = { video: 1, audio: 2 } as const;

/**
 * A variable-length integer read by {@link vint}.
 */
export interface Vint {
  /** The value (for an ID, the marker bits are kept). */
  v: number;
  /** Bytes used. */
  len: number;
  /** A size field of all ones: the element runs to the end of its parent. */
  unknown: boolean;
}

/**
 * Reads an EBML variable-length integer.
 * @param b - The bytes
 * @param o - Offset of the first byte
 * @param isId - True for an element ID (keeps the length marker)
 * @returns The integer, or null when the bytes run out or it is malformed
 */
export function vint(b: Uint8Array, o: number, isId: boolean): Vint | null {
  if (o >= b.length) return null;
  const f = b[o];
  let len = 1;
  let m = 0x80;
  while (len <= 8 && !(f & m)) {
    len++;
    m >>= 1;
  }
  if (len > 8 || o + len > b.length) return null;
  let v = isId ? f : f & (m - 1);
  let allOnes = (f & (m - 1)) === m - 1;
  for (let i = 1; i < len; i++) {
    v = v * 256 + b[o + i];
    if (b[o + i] !== 255) allOnes = false;
  }
  return { v, len, unknown: !isId && allOnes };
}

/**
 * Reads a big-endian unsigned integer of any length up to 2^53.
 * @param b - The bytes
 * @param s - Offset of the first byte
 * @param e - Offset just past the last byte
 * @returns The value
 */
export function readUint(b: Uint8Array, s: number, e: number): number {
  let v = 0;
  for (let i = s; i < e; i++) v = v * 256 + b[i];
  return v;
}

/**
 * Walks the elements laid end to end between two offsets.
 * @param b - The bytes
 * @param s - Offset of the first element
 * @param e - Offset just past the last byte
 * @param fn - Called with each element's ID and the offsets of its data
 */
function walk(
  b: Uint8Array,
  s: number,
  e: number,
  fn: (id: number, ds: number, de: number) => void,
): void {
  let p = s;
  while (p < e) {
    const id = vint(b, p, true);
    if (!id) return;
    const sz = vint(b, p + id.len, false);
    if (!sz) return;
    const ds = p + id.len + sz.len;
    const de = sz.unknown ? e : Math.min(e, ds + sz.v);
    fn(id.v, ds, de);
    p = de;
  }
}

/**
 * Offset of an element's data, past its ID and size.
 * @param b - Bytes starting with the element
 * @returns The offset, or -1 when the header is malformed
 */
export function dataStart(b: Uint8Array): number {
  const id = vint(b, 0, true);
  if (!id) return -1;
  const sz = vint(b, id.len, false);
  if (!sz) return -1;
  return id.len + sz.len;
}

/**
 * One track of a WebM Tracks element.
 */
export interface WebmTrack {
  codec: string;
  /** DefaultDuration in nanoseconds, 0 when absent. */
  defaultDuration: number;
  /** ContentEncodings present (WebM encryption). */
  encrypted: boolean;
  /** TrackType: 1 video, 2 audio. */
  type: number;
}

/**
 * The tracks of a WebM init segment.
 */
export interface WebmTracksInfo {
  tracks: WebmTrack[];
  hasAudio: boolean;
  hasVideo: boolean;
  muxed: boolean;
  encrypted: boolean;
}

/**
 * Parses a Tracks element.
 * @param b - Bytes of the whole Tracks element, header included
 * @returns Its tracks
 */
export function webmTrackInfo(b: Uint8Array): WebmTracksInfo {
  const tracks: WebmTrack[] = [];
  const s = dataStart(b);
  if (s >= 0) {
    walk(b, s, b.length, (id, ds, de) => {
      if (id !== EBML_ID.TrackEntry) return;
      const t: WebmTrack = { codec: '', defaultDuration: 0, encrypted: false, type: 0 };
      walk(b, ds, de, (cid, cs, ce) => {
        if (cid === EBML_ID.CodecID) t.codec = String.fromCharCode(...b.subarray(cs, ce));
        else if (cid === EBML_ID.DefaultDuration) t.defaultDuration = readUint(b, cs, ce);
        else if (cid === EBML_ID.TrackType) t.type = readUint(b, cs, ce);
        else if (cid === EBML_ID.ContentEncodings) t.encrypted = true;
      });
      tracks.push(t);
    });
  }
  const hasAudio = tracks.some((t) => t.type === TRACK_TYPE.audio);
  const hasVideo = tracks.some((t) => t.type === TRACK_TYPE.video);
  return {
    tracks,
    hasAudio,
    hasVideo,
    muxed: hasAudio && hasVideo,
    encrypted: tracks.some((t) => t.encrypted),
  };
}

/**
 * Reads TimecodeScale from an Info element.
 * @param b - Bytes of the whole Info element, header included
 * @returns Nanoseconds per timecode unit (1e6 when absent)
 */
export function webmTimecodeScale(b: Uint8Array): number {
  let scale = 1e6;
  const s = dataStart(b);
  if (s < 0) return scale;
  walk(b, s, b.length, (id, ds, de) => {
    if (id === EBML_ID.TimecodeScale) scale = readUint(b, ds, de);
  });
  return scale || 1e6;
}

/**
 * Duration of an Opus packet from its TOC byte (RFC 6716 section 3.1).
 * @param b - The bytes
 * @param p - Offset of the TOC byte
 * @returns The duration in seconds, or null when it cannot be read
 */
export function opusDur(b: Uint8Array, p: number): number | null {
  if (p >= b.length) return null;
  const toc = b[p];
  const config = toc >> 3;
  const frameMs =
    config < 12
      ? [10, 20, 40, 60][config & 3]
      : config < 16
        ? config & 1
          ? 20
          : 10
        : [2.5, 5, 10, 20][config & 3];
  const code = toc & 3;
  const count = code === 0 ? 1 : code < 3 ? 2 : p + 1 < b.length ? b[p + 1] & 0x3f : 0;
  return count ? (frameMs * count) / 1000 : null;
}

/**
 * What a cluster parse needs to know about the stream.
 */
export interface ClusterContext {
  /** TimecodeScale in nanoseconds. */
  timecodeScale: number;
  /** The SourceBuffer's track, or null when the Tracks element was not read. */
  track: WebmTrack | null;
}

/**
 * Presentation span of a Cluster, in seconds before timestampOffset.
 */
export interface ClusterSpan {
  s: number;
  e: number;
  /** Duration of the first block, 0 when unknown. */
  frameDur: number;
  /** The last block's duration had to be estimated. */
  estimated: boolean;
}

/**
 * Reads a Cluster's presentation span from its Timecode and every SimpleBlock
 * and BlockGroup: relative timecode, then BlockDuration, the Opus packet
 * duration, DefaultDuration, or the gap to the next block. The last block of
 * a cluster with none of these is estimated, from the smallest gap for audio
 * and the largest for video.
 * @param b - The bytes
 * @param p0 - Offset of the Cluster's first child
 * @param ctx - Stream context
 * @returns The span, or null without a Timecode or blocks
 */
export function clusterSpan(b: Uint8Array, p0: number, ctx: ClusterContext): ClusterSpan | null {
  const tk = ctx.track;
  const sc = (ctx.timecodeScale || 1e6) / 1e9;
  let tc: number | null = null;
  const blocks: { rel: number; dur: number | null }[] = [];
  const block = (s: number, e: number, durUnits: number | null): void => {
    const tn = vint(b, s, false);
    if (!tn) return;
    const q = s + tn.len;
    if (q + 3 > e) return;
    const rel = (((b[q] << 8) | b[q + 1]) << 16) >> 16;
    const flags = b[q + 2];
    const lacing = (flags >> 1) & 3;
    let dur = durUnits !== null ? durUnits * sc : null;
    if (dur === null && !lacing && tk?.codec === 'A_OPUS') {
      let d = q + 3;
      if (tk.encrypted) {
        const signal = b[d];
        d += 1;
        if (signal & 1) d = -1; // encrypted frame: the TOC is unreadable
      }
      if (d > 0) dur = opusDur(b, d);
    }
    if (dur === null && tk?.defaultDuration) {
      dur = (tk.defaultDuration / 1e9) * (lacing ? b[q + 3] + 1 : 1);
    }
    blocks.push({ rel, dur });
  };
  walk(b, p0, b.length, (id, ds, de) => {
    if (id === EBML_ID.Timecode) tc = readUint(b, ds, de);
    else if (id === EBML_ID.SimpleBlock) block(ds, de, null);
    else if (id === EBML_ID.BlockGroup) {
      let bs = -1;
      let be = -1;
      let du: number | null = null;
      walk(b, ds, de, (cid, cs, ce) => {
        if (cid === EBML_ID.Block) {
          bs = cs;
          be = ce;
        } else if (cid === EBML_ID.BlockDuration) du = readUint(b, cs, ce);
      });
      if (bs >= 0) block(bs, be, du);
    }
  });
  if (tc === null || !blocks.length) return null;
  const base: number = tc;
  const starts = blocks.map((x) => (base + x.rel) * sc);
  const order = starts.map((_, i) => i).sort((i, j) => starts[i] - starts[j]);
  const gaps: number[] = [];
  for (let k = 0; k + 1 < order.length; k++) gaps.push(starts[order[k + 1]] - starts[order[k]]);
  let estimated = false;
  let s = Infinity;
  let e = -Infinity;
  for (let k = 0; k < order.length; k++) {
    const i = order[k];
    let d = blocks[i].dur;
    if (d === null) {
      if (k + 1 < order.length) d = starts[order[k + 1]] - starts[i];
      else {
        estimated = true;
        d = gaps.length
          ? tk?.type === TRACK_TYPE.audio
            ? Math.min(...gaps)
            : Math.max(...gaps)
          : 0;
      }
    }
    s = Math.min(s, starts[i]);
    e = Math.max(e, starts[i] + d);
  }
  return e > s ? { s, e, frameDur: blocks[0].dur ?? 0, estimated } : null;
}

/**
 * The span the cache keys a Cluster by: from its Timecode to its last
 * SimpleBlock's relative timecode plus 20 ms.
 * @param b - The bytes
 * @param p0 - Offset of the Cluster's first child
 * @param timecodeScale - TimecodeScale in nanoseconds
 * @returns Start and end in seconds, or null without a Timecode
 */
export function clusterCacheSpan(
  b: Uint8Array,
  p0: number,
  timecodeScale: number,
): { start: number; end: number } | null {
  let tc: number | null = null;
  let maxRel = 0;
  walk(b, p0, b.length, (id, ds, de) => {
    if (id === EBML_ID.Timecode) tc = readUint(b, ds, de);
    else if (id === EBML_ID.SimpleBlock) maxRel = Math.max(maxRel, blockRel(b, ds));
  });
  if (tc === null) return null;
  const sc = (timecodeScale || 1e6) / 1e9;
  const base: number = tc;
  return { start: base * sc, end: (base + maxRel) * sc + 0.02 };
}

/**
 * Reads a SimpleBlock's relative timecode.
 * @param b - The bytes
 * @param ds - Offset of the block's data
 * @returns The signed relative timecode, 0 when unreadable
 */
export function blockRel(b: Uint8Array, ds: number): number {
  const tn = vint(b, ds, false);
  if (!tn || ds + tn.len + 2 > b.length) return 0;
  const q = ds + tn.len;
  return (((b[q] << 8) | b[q + 1]) << 16) >> 16;
}
