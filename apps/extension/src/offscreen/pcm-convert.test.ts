import { describe, expect, it } from 'bun:test';
import { INT16_MAX, tpdfDither } from '@thaumic-cast/protocol';

import { convertPlanarToInt16 } from './pcm-convert';

/**
 * The dither comes from a fixed table that repeats every 4096 values, so a
 * reference run and the run under test see the same dither once the table has
 * been stepped round to where the reference started.
 */
const DITHER_PERIOD = 4096;

/**
 * Steps the dither table on until it is back where it was `consumed` values ago.
 * @param consumed - Dither values drawn since the point to return to
 */
function rewindDither(consumed: number): void {
  const remaining = (DITHER_PERIOD - (consumed % DITHER_PERIOD)) % DITHER_PERIOD;
  for (let i = 0; i < remaining; i++) tpdfDither();
}

/**
 * Clamp, dither and saturate one sample, as the relay did before the downmix.
 * @param x - Float sample
 * @returns The Int16 value
 */
function quantise(x: number): number {
  const c = x >= -1 ? (x <= 1 ? x : 1) : x === x ? -1 : 0;
  let q = Math.round(c * INT16_MAX + tpdfDither());
  if (q < -32768) q = -32768;
  else if (q > 32767) q = 32767;
  return q;
}

/**
 * The stereo loop as it stood in the relay worker before the conversion was extracted.
 * @param l - Left plane
 * @param r - Right plane, or null for a mono source
 * @returns Interleaved Int16 samples
 */
function referenceStereo(l: Float32Array, r: Float32Array | null): Int16Array {
  const out = new Int16Array(l.length * 2);
  let dst = 0;
  for (let i = 0; i < l.length; i++) {
    const lv = l[i]!;
    const rv = r ? r[i]! : lv;
    const cl = lv >= -1 ? (lv <= 1 ? lv : 1) : lv === lv ? -1 : 0;
    const cr = rv >= -1 ? (rv <= 1 ? rv : 1) : rv === rv ? -1 : 0;
    let ql = Math.round(cl * INT16_MAX + tpdfDither());
    let qr = Math.round(cr * INT16_MAX + tpdfDither());
    if (ql < -32768) ql = -32768;
    else if (ql > 32767) ql = 32767;
    if (qr < -32768) qr = -32768;
    else if (qr > 32767) qr = 32767;
    out[dst++] = ql;
    out[dst++] = qr;
  }
  return out;
}

/**
 * Expected mono output for a list of already-mixed float samples, drawing the
 * same dither values the run under test will draw.
 * @param mixed - One float per output sample
 * @returns The Int16 values
 */
function expectedMono(mixed: number[]): number[] {
  // Through an Int16Array so a rounded -0 reads back as 0, as it does in the output.
  const out = Array.from(Int16Array.from(mixed.map(quantise)));
  rewindDither(mixed.length);
  return out;
}

/**
 * The raw bytes of an Int16 buffer, as they would go out on the socket.
 * @param samples - Int16 samples
 * @returns The bytes
 */
function bytes(samples: Int16Array): number[] {
  return Array.from(new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength));
}

const SIGNAL_L = [0, 0.25, -0.25, 0.999, -0.999, 1, -1, 1.5, -1.5, 0.1234567, NaN, Infinity];
const SIGNAL_R = [0.5, -0.75, 0.3, -1, 1, 0.999, -0.5, -2, 2, NaN, 0.4, -Infinity];

describe('convertPlanarToInt16', () => {
  describe('mono output from a stereo source', () => {
    it('should cancel opposite channels to silence', () => {
      const l = new Float32Array(64).fill(1);
      const r = new Float32Array(64).fill(-1);
      const expected = expectedMono(new Array<number>(64).fill(0));
      const dst = new Int16Array(64);

      const end = convertPlanarToInt16(l, r, 64, 1, dst, 0);

      expect(end).toBe(64);
      expect(Array.from(dst)).toEqual(expected);
      // Silence plus dither stays within one step of zero.
      for (const v of dst) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    });

    it('should pass equal channels through at their own level', () => {
      const values = [0.5, -0.5, 0.25, -0.125, 0];
      const l = Float32Array.from(values);
      const r = Float32Array.from(values);
      const expected = expectedMono(values);
      const dst = new Int16Array(values.length);

      convertPlanarToInt16(l, r, values.length, 1, dst, 0);

      expect(Array.from(dst)).toEqual(expected);
    });

    it('should average the two channels, not take the left one', () => {
      const l = Float32Array.from([0.5, 0, -0.25, 0.75]);
      const r = Float32Array.from([0, 0.5, 0.75, -0.25]);
      const expected = expectedMono([0.25, 0.25, 0.25, 0.25]);
      const dst = new Int16Array(4);

      convertPlanarToInt16(l, r, 4, 1, dst, 0);

      expect(Array.from(dst)).toEqual(expected);
      for (const v of dst) expect(Math.abs(v - 0.25 * INT16_MAX)).toBeLessThanOrEqual(1.5);
    });

    it('should silence a sample that is NaN in either channel', () => {
      const l = Float32Array.from([NaN, 0.5, NaN, 0.5]);
      const r = Float32Array.from([0.5, NaN, NaN, 0.5]);
      const expected = expectedMono([0, 0, 0, 0.5]);
      const dst = new Int16Array(4);

      convertPlanarToInt16(l, r, 4, 1, dst, 0);

      expect(Array.from(dst)).toEqual(expected);
      expect(Math.abs(dst[0]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(dst[1]!)).toBeLessThanOrEqual(1);
      expect(Math.abs(dst[2]!)).toBeLessThanOrEqual(1);
    });

    it('should clip at full scale when both channels are at or past it', () => {
      const l = Float32Array.from([1, -1, 2, -2, Infinity, -Infinity]);
      const r = Float32Array.from([1, -1, 2, -2, Infinity, -Infinity]);
      const expected = expectedMono([1, -1, 1, -1, 1, -1]);
      const dst = new Int16Array(6);

      convertPlanarToInt16(l, r, 6, 1, dst, 0);

      expect(Array.from(dst)).toEqual(expected);
      for (let i = 0; i < 6; i += 2) {
        expect(dst[i]!).toBeGreaterThanOrEqual(INT16_MAX - 1);
        expect(dst[i]!).toBeLessThanOrEqual(32767);
        expect(dst[i + 1]!).toBeLessThanOrEqual(-INT16_MAX + 1);
        expect(dst[i + 1]!).toBeGreaterThanOrEqual(-32768);
      }
    });

    it('should not wrap when dither pushes a full-scale sample past Int16', () => {
      const n = DITHER_PERIOD;
      const l = new Float32Array(n).fill(1);
      const r = new Float32Array(n).fill(1);
      const dst = new Int16Array(n);

      convertPlanarToInt16(l, r, n, 1, dst, 0);

      // A wrapped sample would come out near -32768.
      for (const v of dst) expect(v).toBeGreaterThanOrEqual(INT16_MAX - 1);
    });
  });

  describe('mono output from a mono source', () => {
    it('should pass the single channel through unchanged', () => {
      const values = [0, 0.5, -0.5, 1, -1, 1.5, -1.5, NaN];
      const src = Float32Array.from(values);
      const expected = expectedMono([0, 0.5, -0.5, 1, -1, 1, -1, 0]);
      const dst = new Int16Array(values.length);

      const end = convertPlanarToInt16(src, null, values.length, 1, dst, 0);

      expect(end).toBe(values.length);
      expect(Array.from(dst)).toEqual(expected);
    });
  });

  describe('stereo output', () => {
    it('should match the previous stereo loop byte for byte given the same dither', () => {
      const l = Float32Array.from(SIGNAL_L);
      const r = Float32Array.from(SIGNAL_R);
      const expected = referenceStereo(l, r);
      rewindDither(expected.length);
      const dst = new Int16Array(expected.length);

      const end = convertPlanarToInt16(l, r, l.length, 2, dst, 0);

      expect(end).toBe(expected.length);
      expect(bytes(dst)).toEqual(bytes(expected));
    });

    it('should keep the channels apart rather than mixing them', () => {
      const l = new Float32Array(8).fill(0.5);
      const r = new Float32Array(8).fill(-0.5);
      const dst = new Int16Array(16);

      convertPlanarToInt16(l, r, 8, 2, dst, 0);

      for (let i = 0; i < 16; i += 2) {
        expect(Math.abs(dst[i]! - 0.5 * INT16_MAX)).toBeLessThanOrEqual(1.5);
        expect(Math.abs(dst[i + 1]! + 0.5 * INT16_MAX)).toBeLessThanOrEqual(1.5);
      }
    });

    it('should duplicate a mono source into both channels as before', () => {
      const l = Float32Array.from(SIGNAL_L);
      const expected = referenceStereo(l, null);
      rewindDither(expected.length);
      const dst = new Int16Array(expected.length);

      convertPlanarToInt16(l, null, l.length, 2, dst, 0);

      expect(bytes(dst)).toEqual(bytes(expected));
    });
  });

  describe('destination handling', () => {
    it('should write from the given offset and leave earlier samples alone', () => {
      const l = Float32Array.from([0.5, 0.5]);
      const r = Float32Array.from([0.5, 0.5]);
      const dst = new Int16Array(6).fill(1234);

      const end = convertPlanarToInt16(l, r, 2, 1, dst, 3);

      expect(end).toBe(5);
      expect(Array.from(dst.subarray(0, 3))).toEqual([1234, 1234, 1234]);
      expect(dst[5]).toBe(1234);
      expect(Math.abs(dst[3]! - 0.5 * INT16_MAX)).toBeLessThanOrEqual(1.5);
    });

    it('should convert only the first count samples of a larger plane', () => {
      const l = new Float32Array(1024).fill(0.5);
      const r = new Float32Array(1024).fill(0.5);
      const dst = new Int16Array(8);

      const end = convertPlanarToInt16(l, r, 4, 1, dst, 0);

      expect(end).toBe(4);
      expect(Array.from(dst.subarray(4))).toEqual([0, 0, 0, 0]);
    });
  });
});
