/**
 * Fragmented MP4 (ISO BMFF) parsing for the video sync hook.
 *
 * Only the timing boxes are read: they are never encrypted, so encrypted
 * media parses the same as clear media.
 */

import { boxes, child, rd32, typ } from './bytes';

/** sample_is_non_sync_sample, in a sample-flags word. */
const NON_SYNC_FLAG = 0x10000;

/**
 * One track of an init segment.
 */
export interface Mp4Track {
  /** track_ID from tkhd. */
  id: number;
  /** Media timescale from mdhd (ticks per second). */
  timescale: number;
  /** Handler type from hdlr: `soun`, `vide`, ... */
  handler: string;
  /** default_sample_duration from trex, in ticks. */
  defaultDuration: number;
  /** default_sample_flags from trex. */
  defaultFlags: number;
  /** First edit's media_time (ticks), which Chromium subtracts from every timestamp. */
  editShift: number;
}

/**
 * What the hook needs from an init segment.
 */
export interface Mp4InitInfo {
  tracks: Mp4Track[];
  hasAudio: boolean;
  hasVideo: boolean;
  /** An `enca` or `encv` sample entry is present. */
  encrypted: boolean;
  /** Audio and video in the one init: a muxed SourceBuffer, never shifted. */
  muxed: boolean;
}

/**
 * Timing of one media fragment (moof), in track seconds before the player's
 * timestampOffset.
 */
export interface FragmentSpan {
  /** Decode start (tfdt). */
  start: number;
  /** Decode end (tfdt plus the sample durations). */
  end: number;
  /** Presentation time of the first sample (composition offset and edit list applied). */
  presStart: number;
  /** Duration of the first sample, 0 when unknown. */
  frameDur: number;
  /** Number of samples. */
  frames: number;
  /** Number of samples flagged non-sync. */
  nonSync: number;
  /** Presentation times of the sync samples, ascending; empty unless `nonSync > 0`. */
  syncs: number[];
}

/**
 * Reads the version byte and 24-bit flags of a full box.
 * @param b - The bytes
 * @param s - Offset of the box body
 * @returns The flags
 */
function fullFlags(b: Uint8Array, s: number): number {
  return (b[s + 1] << 16) | (b[s + 2] << 8) | b[s + 3];
}

/**
 * Reads the first edit's media_time from an elst box.
 * @param b - The bytes
 * @param s - Offset of the elst body
 * @returns media_time in ticks, or 0 for none or an empty edit
 */
function editShift(b: Uint8Array, s: number): number {
  const v1 = b[s] === 1;
  const count = rd32(b, s + 4);
  if (!count) return 0;
  const o = s + 8 + (v1 ? 8 : 4);
  if (v1) {
    if (rd32(b, o) === 0xffffffff) return 0; // -1: an empty edit
    const mt = rd32(b, o) * 4294967296 + rd32(b, o + 4);
    return mt > 0 ? mt : 0;
  }
  const mt = rd32(b, o) | 0;
  return mt > 0 ? mt : 0;
}

/**
 * Parses an init segment (ftyp + moov): its tracks, trex defaults, timescales,
 * handlers and edit lists, and whether it is encrypted or muxed.
 * @param b - The init segment
 * @returns The init's description
 */
export function parseInit(b: Uint8Array): Mp4InitInfo {
  const info: Mp4InitInfo = {
    tracks: [],
    hasAudio: false,
    hasVideo: false,
    encrypted: false,
    muxed: false,
  };
  // 'enca' / 'encv' anywhere: the sample entries sit deep in stsd.
  for (let i = 0; i + 4 <= b.length; i++) {
    if (
      b[i] === 0x65 &&
      b[i + 1] === 0x6e &&
      b[i + 2] === 0x63 &&
      (b[i + 3] === 0x61 || b[i + 3] === 0x76)
    ) {
      info.encrypted = true;
      break;
    }
  }
  for (const top of boxes(b, 0, b.length)) {
    if (top.t !== 'moov') continue;
    const trex = new Map<number, { dur: number; flags: number }>();
    const mvex = child(b, top, 'mvex');
    if (mvex) {
      for (const c of boxes(b, mvex.s, mvex.e)) {
        if (c.t !== 'trex' || c.e - c.s < 24) continue;
        trex.set(rd32(b, c.s + 4), { dur: rd32(b, c.s + 12), flags: rd32(b, c.s + 20) });
      }
    }
    for (const trak of boxes(b, top.s, top.e)) {
      if (trak.t !== 'trak') continue;
      const tkhd = child(b, trak, 'tkhd');
      const mdia = child(b, trak, 'mdia');
      if (!tkhd || !mdia) continue;
      const id = rd32(b, tkhd.s + (b[tkhd.s] === 1 ? 20 : 12));
      const mdhd = child(b, mdia, 'mdhd');
      const hdlr = child(b, mdia, 'hdlr');
      const timescale = mdhd ? rd32(b, mdhd.s + (b[mdhd.s] === 1 ? 20 : 12)) : 0;
      const handler = hdlr ? typ(b, hdlr.s + 8) : '';
      if (handler === 'soun') info.hasAudio = true;
      if (handler === 'vide') info.hasVideo = true;
      const edts = child(b, trak, 'edts');
      const elst = edts ? child(b, edts, 'elst') : null;
      const t = trex.get(id);
      info.tracks.push({
        id,
        timescale,
        handler,
        defaultDuration: t ? t.dur : 0,
        defaultFlags: t ? t.flags : 0,
        editShift: elst ? editShift(b, elst.s) : 0,
      });
    }
  }
  info.muxed = info.hasAudio && info.hasVideo;
  return info;
}

/**
 * Reads the timing of a media fragment: every sample of every trun, with
 * durations, flags and composition offsets from trun, else tfhd, else trex
 * defaults, as Chromium applies them. A sample is a sync sample unless its
 * flags set sample_is_non_sync_sample; Chromium honours that for xHE-AAC and
 * drops non-sync audio frames until the next sync frame after a cut.
 * @param b - Bytes holding the moof box (and possibly more)
 * @param init - The init segment in force
 * @returns The fragment's timing, or null when it has no usable track fragment
 */
export function fragmentSpan(b: Uint8Array, init: Mp4InitInfo): FragmentSpan | null {
  let start = Infinity;
  let end = -Infinity;
  let presStart: number | null = null;
  let frameDur = 0;
  let frames = 0;
  let nonSync = 0;
  const syncs: number[] = [];
  for (const top of boxes(b, 0, b.length)) {
    if (top.t !== 'moof') continue;
    for (const traf of boxes(b, top.s, top.e)) {
      if (traf.t !== 'traf') continue;
      const tfhd = child(b, traf, 'tfhd');
      const tfdt = child(b, traf, 'tfdt');
      if (!tfhd || !tfdt) continue;
      const fl = fullFlags(b, tfhd.s);
      const id = rd32(b, tfhd.s + 4);
      const tr = init.tracks.find((x) => x.id === id) ?? init.tracks[0];
      if (!tr || !tr.timescale) continue;
      const ts = tr.timescale;
      let o = tfhd.s + 8;
      if (fl & 0x1) o += 8; // base-data-offset
      if (fl & 0x2) o += 4; // sample-description-index
      let defDur = tr.defaultDuration;
      if (fl & 0x8) {
        defDur = rd32(b, o);
        o += 4;
      }
      if (fl & 0x10) o += 4; // default-sample-size
      const defFlags = fl & 0x20 ? rd32(b, o) : tr.defaultFlags;
      const base =
        b[tfdt.s] === 1
          ? rd32(b, tfdt.s + 4) * 4294967296 + rd32(b, tfdt.s + 8)
          : rd32(b, tfdt.s + 4);
      let dt = base;
      for (const trun of boxes(b, traf.s, traf.e)) {
        if (trun.t !== 'trun') continue;
        const v1 = b[trun.s] === 1;
        const tf = fullFlags(b, trun.s);
        const n = rd32(b, trun.s + 4);
        let p = trun.s + 8;
        if (tf & 0x1) p += 4; // data-offset
        let firstFlags: number | null = null;
        if (tf & 0x4) {
          firstFlags = rd32(b, p);
          p += 4;
        }
        for (let i = 0; i < n && p <= trun.e; i++) {
          let d = defDur;
          let cto = 0;
          let sf = defFlags;
          if (tf & 0x100) {
            d = rd32(b, p);
            p += 4;
          }
          if (tf & 0x200) p += 4; // size
          if (tf & 0x400) {
            sf = rd32(b, p);
            p += 4;
          }
          if (tf & 0x800) {
            cto = v1 ? rd32(b, p) | 0 : rd32(b, p);
            p += 4;
          }
          if (i === 0 && firstFlags !== null) sf = firstFlags;
          const pts = (dt + cto - tr.editShift) / ts;
          if (presStart === null) presStart = pts;
          if (!frameDur && d) frameDur = d / ts;
          frames++;
          if (sf & NON_SYNC_FLAG) nonSync++;
          else syncs.push(pts);
          dt += d;
        }
      }
      start = Math.min(start, base / ts);
      end = Math.max(end, dt / ts);
    }
  }
  if (start === Infinity) return null;
  return {
    start,
    end: end > start ? end : start + 0.02,
    presStart: presStart ?? start,
    frameDur,
    frames,
    nonSync,
    syncs: nonSync ? syncs.sort((x, y) => x - y) : [],
  };
}
