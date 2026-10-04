/**
 * Byte helpers for the video sync hook's container parsers.
 *
 * The hook runs inside web pages, so these stay small and allocation-light:
 * big-endian reads, ISO BMFF box iteration and buffer concatenation.
 */

/**
 * One ISO BMFF box found by {@link boxes}.
 */
export interface Box {
  /** Four-character box type, e.g. `moof`. */
  t: string;
  /** Offset of the first byte after the box header. */
  s: number;
  /** Offset just past the end of the box. */
  e: number;
}

/**
 * Reads an unsigned 32-bit big-endian integer.
 * @param b - The bytes
 * @param o - Offset of the first byte
 * @returns The value, 0..2^32-1
 */
export function rd32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

/**
 * Reads a four-character box type.
 * @param b - The bytes
 * @param o - Offset of the first character
 * @returns The type as a string
 */
export function typ(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
}

/**
 * Iterates the boxes laid end to end between two offsets. Stops at the first
 * box whose size is impossible or runs past `e`, so truncated data yields
 * only the complete boxes before it.
 * @param b - The bytes
 * @param s - Offset of the first box header
 * @param e - Offset just past the last byte to read
 * @yields Each complete box, in order
 */
export function* boxes(b: Uint8Array, s: number, e: number): Generator<Box> {
  let o = s;
  while (o + 8 <= e) {
    let size = rd32(b, o);
    const t = typ(b, o + 4);
    let h = 8;
    if (size === 1) {
      if (o + 16 > e) return;
      size = rd32(b, o + 8) * 4294967296 + rd32(b, o + 12);
      h = 16;
    } else if (size === 0) {
      size = e - o;
    }
    if (size < h || o + size > e) return;
    yield { t, s: o + h, e: o + size };
    o += size;
  }
}

/**
 * Finds the first child box of a given type.
 * @param b - The bytes
 * @param box - The parent box
 * @param t - The child type to find
 * @returns The child box, or null when there is none
 */
export function child(b: Uint8Array, box: Box, t: string): Box | null {
  for (const c of boxes(b, box.s, box.e)) if (c.t === t) return c;
  return null;
}

/**
 * Joins byte arrays into one new array. Always copies, so the result never
 * shares memory with the inputs.
 * @param parts - The arrays, in order
 * @returns A new array holding every byte of every part
 */
export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}
