/**
 * Float32 planar → Int16 conversion for the PCM relay (MSTP path).
 *
 * Kept apart from the worker so the sample maths can be tested without a
 * worker scope. This is the latency-sensitive path: no allocation, one pass.
 */

import { tpdfDither, INT16_MAX } from '@thaumic-cast/protocol';

/**
 * Converts planar Float32 samples to Int16 with a NaN-safe clamp to [-1, 1],
 * TPDF dither and Int16 saturation, writing into `dst` from `dstOffset`.
 *
 * - Stereo output interleaves L and R. A mono source (`srcCh1` null) is
 *   duplicated into both channels.
 * - Mono output from a source with a second channel is a downmix, `(l + r) / 2`
 *   per sample, the same average the AudioWorklet path uses for the compressed
 *   codecs. A NaN in either channel makes that sample silent, as it does there.
 * - Mono output from a mono source (`srcCh1` null) passes through.
 *
 * The caller must make sure `dst` has room for `count * outChannels` samples.
 * @param srcCh0 - First (left) channel plane
 * @param srcCh1 - Second (right) channel plane, or null when the source is mono
 * @param count - Number of frames to convert
 * @param outChannels - Channels to write per frame (1 or 2)
 * @param dst - Destination Int16 buffer
 * @param dstOffset - Index in `dst` to start writing at
 * @returns The index in `dst` just past the last sample written
 */
export function convertPlanarToInt16(
  srcCh0: Float32Array,
  srcCh1: Float32Array | null,
  count: number,
  outChannels: number,
  dst: Int16Array,
  dstOffset: number,
): number {
  let out = dstOffset;
  if (outChannels === 1) {
    if (srcCh1) {
      for (let i = 0; i < count; i++) {
        const m = (srcCh0[i]! + srcCh1[i]!) * 0.5;
        // NaN-safe clamp: NaN comparisons return false, so NaN → 0
        const cm = m >= -1 ? (m <= 1 ? m : 1) : m === m ? -1 : 0;
        let qm = Math.round(cm * INT16_MAX + tpdfDither());
        if (qm < -32768) qm = -32768;
        else if (qm > 32767) qm = 32767;
        dst[out++] = qm;
      }
    } else {
      for (let i = 0; i < count; i++) {
        const l = srcCh0[i]!;
        const cl = l >= -1 ? (l <= 1 ? l : 1) : l === l ? -1 : 0;
        let ql = Math.round(cl * INT16_MAX + tpdfDither());
        if (ql < -32768) ql = -32768;
        else if (ql > 32767) ql = 32767;
        dst[out++] = ql;
      }
    }
  } else {
    for (let i = 0; i < count; i++) {
      const l = srcCh0[i]!;
      const r = srcCh1 ? srcCh1[i]! : l;
      const cl = l >= -1 ? (l <= 1 ? l : 1) : l === l ? -1 : 0;
      const cr = r >= -1 ? (r <= 1 ? r : 1) : r === r ? -1 : 0;
      let ql = Math.round(cl * INT16_MAX + tpdfDither());
      let qr = Math.round(cr * INT16_MAX + tpdfDither());
      if (ql < -32768) ql = -32768;
      else if (ql > 32767) ql = 32767;
      if (qr < -32768) qr = -32768;
      else if (qr > 32767) qr = 32767;
      dst[out++] = ql;
      dst[out++] = qr;
    }
  }
  return out;
}
