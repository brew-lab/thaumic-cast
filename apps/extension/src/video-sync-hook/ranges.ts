/**
 * Buffered ranges as the player sees them.
 *
 * A shifted SourceBuffer holds its audio at native = virtual + off. The
 * player must keep seeing its own (virtual) timeline, or it would refetch or
 * evict the wrong data, so the hook reports native ranges minus the offset.
 */

import type { Range } from './plan';

/**
 * Maps native buffered ranges to the player's timeline.
 *
 * With audio moved earlier, the native start can be clamped at 0 (the
 * append window cannot start below it), which would make the player think
 * the first `-off` seconds are missing and refetch them forever. For a range
 * starting at native 0 the player's own window start, or the first cached
 * fragment's start, is reported instead. Times never go negative and
 * touching ranges merge.
 * @param native - Native ranges, ascending
 * @param off - The offset in force (native minus virtual)
 * @param vAws - The player's appendWindowStart
 * @param firstCachedStart - Virtual start of the first cached fragment, or null
 * @returns Virtual ranges, ascending
 */
export function virtualRanges(
  native: readonly Range[],
  off: number,
  vAws: number,
  firstCachedStart: number | null,
): [number, number][] {
  const out: [number, number][] = [];
  for (const [ns, ne] of native) {
    let s = ns - off;
    const e = ne - off;
    if (off < 0 && ns <= 0.05 && vAws + off < 0) {
      s = Math.max(vAws, Math.min(s, firstCachedStart ?? s));
    }
    s = Math.max(0, s);
    if (!(e > s)) continue;
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/**
 * Intersects two lists of ascending ranges.
 * @param a - First list
 * @param b - Second list
 * @returns The ranges covered by both
 */
export function intersectRanges(a: readonly Range[], b: readonly Range[]): [number, number][] {
  const out: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const s = Math.max(a[i][0], b[j][0]);
    const e = Math.min(a[i][1], b[j][1]);
    if (e > s) out.push([s, e]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

/**
 * The element's buffered ranges: the intersection of its SourceBuffers'
 * ranges, as HTMLMediaElement.buffered defines it. Once the MediaSource has
 * ended, each buffer's last range counts as reaching the highest end.
 * @param lists - Each SourceBuffer's (virtual) ranges
 * @param ended - The MediaSource's readyState is `ended`
 * @returns The element's ranges
 */
export function elementRanges(lists: readonly (readonly Range[])[], ended: boolean): Range[] {
  let hi = 0;
  for (const l of lists) if (l.length) hi = Math.max(hi, l[l.length - 1][1]);
  let acc: Range[] | null = null;
  for (const l0 of lists) {
    const l = l0.map((x) => [x[0], x[1]] as [number, number]);
    if (ended && l.length) l[l.length - 1][1] = hi;
    acc = acc ? intersectRanges(acc, l) : l;
  }
  return acc ?? [];
}
