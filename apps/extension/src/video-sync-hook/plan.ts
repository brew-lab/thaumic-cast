/**
 * Decisions behind the audio lead: what offset to aim for, and how to get
 * there from the offset in force.
 *
 * Offsets are native minus virtual time, in seconds: an audio lead of L
 * seconds of wall time at playback rate r is an offset of -L*r. A change of
 * offset is applied as an "immediate switch": the native audio from a cut
 * point just ahead of the playhead is removed and the cached fragments are
 * appended again under the new offset. When that cannot be done safely the
 * switch either drains (the new offset applies to future appends only) or
 * defers (keeps the current offset and is retried).
 */

import type { CacheEntry } from './cache';

/** A time range, [start, end) in seconds. */
export type Range = readonly [number, number];

/** Rescale for a new playback rate only when the error would exceed this, in seconds. */
export const RATE_RESCALE_ERROR_S = 0.02;

/** Shortest distance from the playhead to a switch's cut, in seconds of media time. */
export const MIN_CUT_MARGIN_S = 0.15;

/** Distance from the playhead to a switch's cut at rate 1, in seconds of media time. */
export const CUT_MARGIN_S = 0.5;

/**
 * What decides the target offset of one audio SourceBuffer.
 */
export interface TargetInput {
  /** A lead is wanted and the buffer may be shifted. */
  active: boolean;
  /** Lead in seconds of wall time. */
  leadS: number;
  /** The playback rate the offset is scaled by. */
  rate: number;
  /** The audio is encrypted (it cannot be trimmed inside a frame). */
  encrypted: boolean;
  /** Frame duration in media seconds, 0 when unknown. */
  frameDur: number;
}

/**
 * The offset an audio SourceBuffer should have: -lead x rate. Encrypted
 * audio cannot be trimmed inside a frame (measured: each switch moved it by
 * one AAC frame), so its shift is kept a whole number of frames, which makes
 * the old and new frame grids coincide: 900 ms at 1024/48000 is 896 ms.
 * @param t - The inputs
 * @returns The offset in seconds (0 or negative)
 */
export function targetOffset(t: TargetInput): number {
  if (!t.active || !(t.leadS > 0)) return 0;
  let s = t.leadS * (t.rate || 1);
  if (t.encrypted && t.frameDur > 0) s = Math.round(s / t.frameDur) * t.frameDur;
  return s === 0 ? 0 : -s;
}

/**
 * The playback rate to scale the lead by after the element's rate changed.
 * The offset is re-placed only when the error from keeping the old scale
 * would exceed {@link RATE_RESCALE_ERROR_S}, or when nothing is shifted.
 * @param rate - The element's playback rate now
 * @param applied - The rate the offset was last scaled by
 * @param leadS - The lead in seconds of wall time
 * @param off - The offset in force
 * @returns The rate to scale by from now on
 */
export function rescaleRate(rate: number, applied: number, leadS: number, off: number): number {
  if (Math.abs(rate - applied) * (leadS || 0) > RATE_RESCALE_ERROR_S) return rate;
  if (off === 0 && rate !== applied) return rate;
  return applied;
}

/**
 * The random access points of a cached fragment inside its append window,
 * in virtual time: its sync frames when it has non-sync frames, else its
 * frame grid, else its start.
 * @param e - The cached fragment
 * @param fallbackFrameDur - Frame duration to use when the entry has none
 * @returns Ascending times
 */
export function rapTimes(e: CacheEntry, fallbackFrameDur: number): number[] {
  const ws = Math.max(e.vStart, e.vAWS);
  const we = Math.min(e.vEnd, e.vAWE);
  if (!(we > ws)) return [];
  if (e.syncs) return e.syncs.filter((t) => t >= ws - 1e-4 && t < we - 1e-4);
  const fd = e.frameDur || fallbackFrameDur || 0;
  if (!(fd > 0)) return e.vStart >= ws - 1e-4 ? [e.vStart] : [];
  const out: number[] = [];
  const first = e.vStart + Math.max(0, Math.ceil((ws - e.vStart) / fd - 1e-6)) * fd;
  for (let t = first; t < we - 1e-4 && out.length < 4000; t += fd) out.push(t);
  return out;
}

/**
 * The first random access point of the shifted placement at or after a time.
 * @param entries - Cached fragments
 * @param want - Native time to search from
 * @param newOff - The offset the fragments would be placed under
 * @param fallbackFrameDur - Frame duration for entries without one
 * @returns The native time of the point, or null when the cache has none
 */
export function rapAhead(
  entries: readonly CacheEntry[],
  want: number,
  newOff: number,
  fallbackFrameDur: number,
): number | null {
  let best: number | null = null;
  for (const e of entries) {
    if (e.vEnd + newOff <= want || (best !== null && e.vStart + newOff >= best)) continue;
    for (const t of rapTimes(e, fallbackFrameDur)) {
      const c = t + newOff;
      if (c >= want - 1e-6) {
        if (best === null || c < best) best = c;
        break;
      }
    }
  }
  return best;
}

/**
 * The latest end of the native ranges that reach beyond a time.
 * @param native - Native buffered ranges
 * @param t - The time
 * @returns The end, or null when nothing is buffered more than 50 ms beyond `t`
 */
export function natEndAfter(native: readonly Range[], t: number): number | null {
  let e: number | null = null;
  for (const [, end] of native) if (end > t + 0.05) e = Math.max(e ?? 0, end);
  return e;
}

/**
 * Whether the fragments to re-append cover everything natively buffered
 * beyond the cut, in virtual time from (cut - newOff) on. A switch must
 * never remove data it cannot put back.
 * @param native - Native buffered ranges
 * @param list - Fragments to re-append
 * @param cut - Native time the switch removes from
 * @param fromOff - The offset the buffered data was placed under
 * @param newOff - The offset the fragments will be placed under
 * @returns True when covered
 */
export function cacheCovers(
  native: readonly Range[],
  list: readonly CacheEntry[],
  cut: number,
  fromOff: number,
  newOff: number,
): boolean {
  const vA = cut - newOff;
  const TOL = 0.1;
  const ext = list
    .map((e) => [Math.max(e.vStart, e.vAWS), Math.min(e.vEnd, e.vAWE)] as const)
    .filter((x) => x[1] > x[0])
    .sort((a, b) => a[0] - b[0]);
  for (const [ns, ne] of native) {
    const ve = ne - fromOff;
    const vs = Math.max(ns - fromOff, vA);
    if (!(ve > vs + TOL)) continue;
    let pos = vs;
    for (const [s, en] of ext) {
      if (en <= pos) continue;
      if (s > pos + TOL) break;
      pos = Math.max(pos, en);
      if (pos >= ve - TOL) break;
    }
    if (pos < ve - TOL) return false;
  }
  return true;
}

/**
 * Everything a switch decision looks at.
 */
export interface SwitchInput {
  /** The playhead (element currentTime), or null without an element. */
  ct: number | null;
  /** The element's playback rate. */
  rate: number;
  /** The walker and cache are usable. */
  canCache: boolean;
  fromOff: number;
  newOff: number;
  /** The audio has non-sync frames (xHE-AAC): cuts must land on random access points. */
  nonSync: boolean;
  /** The audio is encrypted with a known frame duration: cuts land on frame boundaries. */
  encrypted: boolean;
  frameDur: number;
  /** Cached fragments, ascending. */
  entries: readonly CacheEntry[];
  /** Native buffered ranges. */
  native: readonly Range[];
}

/**
 * Outcome of a switch decision.
 */
export type SwitchPlan =
  | {
      action: 'switch';
      /** Native time to remove from and re-append after. */
      cut: number;
      /** Fragments to re-append, ascending. */
      list: CacheEntry[];
      /** Pulls each re-append's window start just before the cut. */
      awsEps: number;
    }
  | { action: 'drain'; why: string }
  | { action: 'defer'; why: string };

/**
 * Decides how to move one audio SourceBuffer from `fromOff` to `newOff`.
 *
 * - Without a playhead or a usable cache only future appends can move:
 *   that drains, unless the move is later and data is buffered ahead, which
 *   would leave a hole playback cannot cross, so it defers.
 * - Non-sync audio cuts on the first random access point of the shifted
 *   data at or beyond the margin; when there is none in the cache, or it lies
 *   beyond the buffered audio, moving earlier drains and moving later defers.
 * - Encrypted audio cuts on a frame boundary of the new placement.
 * - A cut whose fragments do not cover what is buffered ahead drains when
 *   moving earlier (that only overlaps) and defers when moving later.
 * @param s - The inputs
 * @returns The plan
 */
export function planSwitch(s: SwitchInput): SwitchPlan {
  const later = s.newOff > s.fromOff + 1e-6;
  const earlier = s.newOff < s.fromOff;
  if (s.ct === null || !s.canCache) {
    const why = s.ct === null ? 'no-playhead' : 'no-cache';
    if (later && natEndAfter(s.native, s.ct ?? 0) !== null) return { action: 'defer', why };
    return { action: 'drain', why };
  }
  const ct = s.ct;
  let cut = ct + Math.max(MIN_CUT_MARGIN_S, CUT_MARGIN_S * s.rate);
  let awsEps = 0;
  if (s.nonSync) {
    const c = rapAhead(s.entries, cut, s.newOff, s.frameDur);
    const at = s.native.find(([a, b]) => a <= ct + 0.05 && b > ct);
    if (c === null || (at && c > at[1] - 0.005)) {
      const why =
        c === null
          ? 'no random access point ahead in the cache'
          : 'the buffered audio ends before the next random access point';
      if (earlier || natEndAfter(s.native, ct) === null) return { action: 'drain', why };
      return { action: 'defer', why };
    }
    cut = c;
    awsEps = 0.001;
  } else if (s.encrypted && s.frameDur > 0) {
    const e0 = s.entries.find((e) => e.vStart + s.newOff <= cut && e.vEnd + s.newOff > cut);
    if (e0) {
      const k = Math.ceil((cut - (e0.vStart + s.newOff)) / s.frameDur - 1e-6);
      cut = e0.vStart + s.newOff + k * s.frameDur;
      awsEps = 0.001;
    }
  }
  const list = s.entries.filter((e) => e.vEnd + s.newOff > cut + 0.001);
  if (!cacheCovers(s.native, list, cut, s.fromOff, s.newOff)) {
    const why = 'cache does not cover what is buffered ahead';
    return earlier ? { action: 'drain', why } : { action: 'defer', why };
  }
  return { action: 'switch', cut, list, awsEps };
}
