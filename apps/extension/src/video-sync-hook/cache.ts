/**
 * The audio fragment cache behind the immediate switch.
 *
 * A switch removes the native audio ahead of the playhead and appends it
 * again under the new offset, so the hook keeps a copy of what the player
 * appended, mirroring the player's buffer. Times here are virtual: the
 * player's own timeline, before the hook's shift. Video is never cached.
 */

/** Cap on the cached bytes of one audio SourceBuffer. */
export const AUDIO_CACHE_LIMIT_BYTES = 24e6;

/** Seconds of audio kept behind the playhead. */
export const KEEP_BEHIND_S = 3;

/**
 * An init segment as appended by the player. Compared by identity: a
 * re-append only appends an init again when it differs from the last one.
 */
export interface InitRef {
  bytes: Uint8Array;
  encrypted: boolean;
}

/**
 * One cached fragment, with the player's settings at the time it appended it.
 */
export interface CacheEntry {
  data: Uint8Array;
  init: InitRef;
  /** The player's timestampOffset for this append. */
  vTO: number;
  /** The player's append window for this append (trimmed when overlapped). */
  vAWS: number;
  vAWE: number;
  /** Virtual span: track times plus vTO. */
  vStart: number;
  vEnd: number;
  /** Duration of the first frame, 0 when unknown. */
  frameDur: number;
  /** Virtual sync frame times, when the fragment has non-sync frames; else null. */
  syncs: number[] | null;
}

/**
 * The cache of one audio SourceBuffer.
 */
export interface AudioCache {
  /** Entries in ascending vStart order. */
  entries: CacheEntry[];
  bytes: number;
  /** Set once a fragment showed non-sync frames between sync frames (xHE-AAC). */
  nonSync: boolean;
}

/**
 * Creates an empty cache.
 * @returns The cache
 */
export function createCache(): AudioCache {
  return { entries: [], bytes: 0, nonSync: false };
}

/**
 * Sums the cached bytes.
 * @param cache - The cache
 */
function recount(cache: AudioCache): void {
  let n = 0;
  for (const x of cache.entries) n += x.data.length;
  cache.bytes = n;
}

/**
 * Adds a fragment. It replaces the cached fragments it overlaps (a quality
 * switch or a refetch), but for audio the part of a partly overlapped
 * fragment that lies outside the new one is kept, trimmed by its append
 * window on re-append, as MSE keeps it natively; dropping it would leave a
 * hole after a switch. With non-sync audio Chrome keeps a later part only
 * from its next random access point after the overlap, so the kept part
 * starts there, or is dropped when there is none.
 * @param cache - The cache
 * @param e - The new entry
 */
export function addEntry(cache: AudioCache, e: CacheEntry): void {
  // A fragment that is all non-sync says nothing: Chrome treats such frames
  // as keyframes for most codecs, so only one with sync frames among
  // non-sync ones switches the cache to random-access cuts.
  if (e.syncs && e.syncs.length) cache.nonSync = true;
  const kept: CacheEntry[] = [];
  for (const x of cache.entries) {
    if (x.vEnd <= e.vStart + 0.005 || x.vStart >= e.vEnd - 0.005) {
      kept.push(x);
      continue;
    }
    if (x.vEnd > e.vEnd + 0.05) {
      let from = Math.max(x.vAWS, e.vEnd);
      if (cache.nonSync && x.syncs) {
        const rap = x.syncs.find((t) => t >= from - 1e-4);
        if (rap === undefined || rap >= x.vEnd - 0.005) continue;
        from = rap;
      }
      kept.push({ ...x, vAWS: from });
    } else if (x.vStart < e.vStart - 0.05) {
      kept.push({ ...x, vAWE: Math.min(x.vAWE, e.vStart) });
    }
  }
  let i = kept.length;
  while (i > 0 && kept[i - 1].vStart > e.vStart) i--;
  kept.splice(i, 0, e);
  cache.entries = kept;
  recount(cache);
}

/**
 * Drops entries the player will not need again: those ending more than
 * {@link KEEP_BEHIND_S} behind the playhead (in both the virtual and the
 * shifted sense), then, over the size cap, the entries farthest from the
 * playhead, one at a time.
 * @param cache - The cache
 * @param ct - The playhead (element currentTime), or null when unknown
 * @param off - The shift in force (native minus virtual)
 * @param limit - The byte cap
 */
export function evict(
  cache: AudioCache,
  ct: number | null,
  off: number,
  limit: number = AUDIO_CACHE_LIMIT_BYTES,
): void {
  if (ct !== null) {
    const keepFrom = Math.min(ct, ct - off) - KEEP_BEHIND_S;
    cache.entries = cache.entries.filter((x) => x.vEnd > keepFrom);
  }
  recount(cache);
  const ref = ct !== null ? ct - off : 0;
  while (cache.bytes > limit && cache.entries.length > 1) {
    let far = 0;
    for (let i = 1; i < cache.entries.length; i++) {
      if (Math.abs(cache.entries[i].vStart - ref) > Math.abs(cache.entries[far].vStart - ref)) {
        far = i;
      }
    }
    cache.bytes -= cache.entries[far].data.length;
    cache.entries.splice(far, 1);
  }
}

/**
 * Forgets entries lying wholly inside a range the player removed.
 * @param cache - The cache
 * @param a - Virtual start of the removal
 * @param b - Virtual end of the removal
 */
export function forgetRange(cache: AudioCache, a: number, b: number): void {
  cache.entries = cache.entries.filter((x) => !(x.vStart >= a - 0.01 && x.vEnd <= b + 0.01));
  recount(cache);
}
