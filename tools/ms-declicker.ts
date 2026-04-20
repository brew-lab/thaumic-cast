/**
 * M/S Stereo Declicker — Proof of Concept
 *
 * Exploits the key property of Chrome capture artifacts: they appear
 * identically in both stereo channels (injected at the transport layer).
 *
 * Algorithm:
 * 1. Convert stereo to Mid/Side: M=(L+R)/2, S=(L-R)/2
 * 2. Compute prediction error for M and S using LPC (order 12)
 * 3. Detect: M has large error AND S has small error at same sample
 *    → capture artifact (identical in both channels = pure mid)
 * 4. Validate: Hermite interpolation improvement ratio confirms click
 * 5. Repair: replace flagged samples with Hermite interpolation
 *
 * Usage:
 *   bun run tools/ms-declicker.ts <input.wav> [options]
 *
 * Options:
 *   --lpc-order=12      LPC model order (default: 12)
 *   --frame=512         Frame size for LPC analysis (default: 512)
 *   --m-threshold=8     M-channel detection multiplier over median (default: 8)
 *   --ms-ratio=4        Required M/S error ratio to classify as artifact (default: 4)
 *   --min-improve=2     Minimum interpolation improvement ratio to confirm (default: 2)
 *   --max-run=8         Maximum click length in samples (default: 8)
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// WAV Parser / Writer
// ─────────────────────────────────────────────────────────────────────────────

interface WavData {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  formatTag: number;
  samples: Float32Array;
}

function parseWav(buffer: Buffer): WavData {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const riff = String.fromCharCode(...buffer.subarray(0, 4));
  if (riff !== 'RIFF') throw new Error('Not a RIFF file');

  let offset = 12;
  let formatTag = 0,
    channels = 0,
    sampleRate = 0,
    bitsPerSample = 0;
  let dataOffset = 0,
    dataSize = 0;

  while (offset < buffer.length - 8) {
    const chunkId = String.fromCharCode(...buffer.subarray(offset, offset + 4));
    const chunkSize = view.getUint32(offset + 4, true);
    if (chunkId === 'fmt ') {
      formatTag = view.getUint16(offset + 8, true);
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = chunkSize;
    }
    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++;
  }

  if (!sampleRate || !dataOffset) throw new Error('Invalid WAV');

  let samples: Float32Array;
  if (formatTag === 3 && bitsPerSample === 32) {
    samples = new Float32Array(buffer.buffer, buffer.byteOffset + dataOffset, dataSize / 4);
  } else if (formatTag === 1 && bitsPerSample === 16) {
    const int16 = new Int16Array(buffer.buffer, buffer.byteOffset + dataOffset, dataSize / 2);
    samples = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) samples[i] = int16[i]! / 32768;
  } else {
    throw new Error(`Unsupported: tag=${formatTag} bits=${bitsPerSample}`);
  }

  return { sampleRate, channels, bitsPerSample, formatTag, samples };
}

function writeWavFloat32(
  path: string,
  samples: Float32Array,
  sampleRate: number,
  channels: number,
): void {
  const dataSize = samples.length * 4;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const ws = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 4, true);
  v.setUint16(32, channels * 4, true);
  v.setUint16(34, 32, true);
  ws(36, 'data');
  v.setUint32(40, dataSize, true);
  const out = Buffer.concat([
    Buffer.from(header),
    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
  ]);
  writeFileSync(path, out);
}

// ─────────────────────────────────────────────────────────────────────────────
// Channel Helpers
// ─────────────────────────────────────────────────────────────────────────────

function deinterleave(samples: Float32Array, channels: number): Float32Array[] {
  const n = Math.floor(samples.length / channels);
  const out: Float32Array[] = [];
  for (let ch = 0; ch < channels; ch++) {
    const data = new Float32Array(n);
    for (let i = 0; i < n; i++) data[i] = samples[i * channels + ch]!;
    out.push(data);
  }
  return out;
}

function interleave(channelData: Float32Array[]): Float32Array {
  const n = channelData[0]!.length;
  const channels = channelData.length;
  const out = new Float32Array(n * channels);
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < channels; ch++) {
      out[i * channels + ch] = channelData[ch]![i]!;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// LPC (Levinson-Durbin)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute LPC coefficients using autocorrelation + Levinson-Durbin.
 * Returns the prediction coefficients a[1..order] (a[0] is implicitly 1).
 */
function computeLpc(
  signal: Float32Array,
  start: number,
  length: number,
  order: number,
): Float64Array {
  // Autocorrelation
  const r = new Float64Array(order + 1);
  const end = Math.min(start + length, signal.length);
  for (let lag = 0; lag <= order; lag++) {
    let sum = 0;
    for (let i = start; i < end - lag; i++) {
      sum += signal[i]! * signal[i + lag]!;
    }
    r[lag] = sum;
  }

  // Levinson-Durbin recursion
  const a = new Float64Array(order + 1);
  const aPrev = new Float64Array(order + 1);

  if (Math.abs(r[0]!) < 1e-10) return a; // silence

  a[0] = 1;
  let error = r[0]!;

  for (let i = 1; i <= order; i++) {
    // Compute reflection coefficient
    let lambda = 0;
    for (let j = 0; j < i; j++) {
      lambda += a[j]! * r[i - j]!;
    }
    lambda = -lambda / error;

    // Update coefficients
    aPrev.set(a);
    for (let j = 1; j <= i; j++) {
      a[j] = aPrev[j]! + lambda * aPrev[i - j]!;
    }

    error *= 1 - lambda * lambda;
    if (error <= 0) break; // numerical instability
  }

  return a;
}

/**
 * Compute LPC prediction error (residual) for a signal segment.
 * residual[n] = signal[n] + sum(a[k] * signal[n-k], k=1..order)
 */
function lpcResidual(
  signal: Float32Array,
  a: Float64Array,
  order: number,
  start: number,
  length: number,
): Float64Array {
  const residual = new Float64Array(length);
  const end = Math.min(start + length, signal.length);

  for (let n = start; n < end; n++) {
    let pred = 0;
    for (let k = 1; k <= order; k++) {
      const idx = n - k;
      if (idx >= 0) {
        pred += a[k]! * signal[idx]!;
      }
    }
    residual[n - start] = signal[n]! + pred; // a[0]=1, so residual = signal[n] + sum(a[k]*signal[n-k])
  }

  return residual;
}

// ─────────────────────────────────────────────────────────────────────────────
// Hermite Interpolation
// ─────────────────────────────────────────────────────────────────────────────

function hermite(t: number, v0: number, v1: number, m0: number, m1: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// M/S Declicker Core
// ─────────────────────────────────────────────────────────────────────────────

interface ClickDetection {
  position: number;
  length: number;
  mError: number;
  sError: number;
  msRatio: number;
  improveRatio: number;
}

interface DeclickResult {
  correctedL: Float32Array;
  correctedR: Float32Array;
  detections: ClickDetection[];
}

function msDeclick(
  left: Float32Array,
  right: Float32Array,
  opts: {
    lpcOrder: number;
    frameSize: number;
    mThreshold: number;
    msRatio: number;
    minImprove: number;
    maxRun: number;
  },
): DeclickResult {
  const n = left.length;

  // Step 1: Convert to M/S
  const mid = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    mid[i] = (left[i]! + right[i]!) * 0.5;
    side[i] = (left[i]! - right[i]!) * 0.5;
  }

  // Step 2: Frame-by-frame LPC analysis on M and S
  const { order, frameSize } = { order: opts.lpcOrder, frameSize: opts.frameSize };
  const hopSize = Math.floor(frameSize / 2); // 50% overlap
  const numFrames = Math.floor((n - frameSize) / hopSize) + 1;

  // Compute per-sample prediction error magnitude for M and S
  const mResidualPower = new Float64Array(n);
  const sResidualPower = new Float64Array(n);
  const frameCount = new Uint8Array(n); // how many frames cover each sample

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    const len = Math.min(frameSize, n - start);

    // LPC on mid
    const aM = computeLpc(mid, start, len, order);
    const resM = lpcResidual(mid, aM, order, start, len);

    // LPC on side
    const aS = computeLpc(side, start, len, order);
    const resS = lpcResidual(side, aS, order, start, len);

    // Accumulate squared residuals (we'll average later)
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      mResidualPower[idx] += resM[i]! * resM[i]!;
      sResidualPower[idx] += resS[i]! * resS[i]!;
      frameCount[idx]++;
    }
  }

  // Average overlapping frame contributions
  for (let i = 0; i < n; i++) {
    if (frameCount[i]! > 1) {
      mResidualPower[i] /= frameCount[i]!;
      sResidualPower[i] /= frameCount[i]!;
    }
  }

  // Step 3: Compute running median of M residual power for adaptive threshold
  const medianWindow = 256;
  const mMedian = new Float64Array(n);
  // Use a simple approximation: running mean of absolute residual (cheaper than true median)
  const cumMRes = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumMRes[i + 1] = cumMRes[i]! + Math.sqrt(mResidualPower[i]!);
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - medianWindow);
    const hi = Math.min(n, i + medianWindow);
    const meanAbsRes = (cumMRes[hi]! - cumMRes[lo]!) / (hi - lo);
    mMedian[i] = meanAbsRes * meanAbsRes; // square it back to power
  }

  // Step 4: Detect clicks — M spike with low S
  const candidates: Array<{ pos: number; mErr: number; sErr: number }> = [];

  for (let i = order; i < n - 2; i++) {
    const mErr = mResidualPower[i]!;
    const sErr = sResidualPower[i]! + 1e-15; // avoid division by zero
    const mThresh = mMedian[i]! * opts.mThreshold * opts.mThreshold; // squared because power

    // M must be large
    if (mErr < mThresh) continue;

    // M/S ratio must be high (artifact is mid-only)
    const ratio = mErr / sErr;
    if (ratio < opts.msRatio * opts.msRatio) continue; // squared because power

    candidates.push({ pos: i, mErr: Math.sqrt(mErr), sErr: Math.sqrt(sErr) });
  }

  // Step 5: Group adjacent candidates into click events
  const clicks: Array<{ start: number; end: number; peakMErr: number; peakSErr: number }> = [];
  let ci = 0;
  while (ci < candidates.length) {
    const clickStart = candidates[ci]!.pos;
    let clickEnd = clickStart + 1;
    let peakM = candidates[ci]!.mErr;
    let peakS = candidates[ci]!.sErr;

    while (ci + 1 < candidates.length && candidates[ci + 1]!.pos <= clickEnd + 1) {
      ci++;
      clickEnd = candidates[ci]!.pos + 1;
      peakM = Math.max(peakM, candidates[ci]!.mErr);
      peakS = Math.max(peakS, candidates[ci]!.sErr);
    }

    const len = clickEnd - clickStart;
    if (len <= opts.maxRun) {
      clicks.push({ start: clickStart, end: clickEnd, peakMErr: peakM, peakSErr: peakS });
    }
    ci++;
  }

  // Step 6: Validate with interpolation improvement and repair
  const correctedL = new Float32Array(left);
  const correctedR = new Float32Array(right);
  const detections: ClickDetection[] = [];

  for (const click of clicks) {
    const { start, end } = click;
    const len = end - start;

    // Need anchor points
    const anchorMargin = 2;
    if (start < anchorMargin || end >= n - anchorMargin) continue;

    // Compute interpolated values for both channels
    const a0 = start - 1;
    const a1 = end;
    const span = a1 - a0;
    if (span <= 1) continue;

    // For each channel, compute Hermite interpolation
    const channels = [left, right];
    const correctedChs = [correctedL, correctedR];
    let totalOrigD2 = 0;
    let totalInterpD2 = 0;

    for (let ch = 0; ch < 2; ch++) {
      const sig = channels[ch]!;
      const v0 = sig[a0]!;
      const v1 = sig[a1]!;
      const d0 = (sig[a0]! - sig[Math.max(0, a0 - 2)]!) * 0.5;
      const d1 = (sig[Math.min(n - 1, a1 + 2)]! - sig[a1]!) * 0.5;

      // Compute original d² sum and interpolated d² sum
      for (let k = start; k < end; k++) {
        if (k >= 2 && k < n) {
          totalOrigD2 += Math.abs(sig[k]! - 2 * sig[k - 1]! + sig[k - 2]!);
        }

        const t = (k - a0) / span;
        const interp = hermite(t, v0, v1, d0 * span, d1 * span);

        // For d² of interpolated: need to compute it properly
        // For now, just compute improvement at the boundary
        if (k === start && k >= 2) {
          const origBoundaryD2 = Math.abs(sig[k]! - 2 * sig[k - 1]! + sig[k - 2]!);
          const interpBoundaryD2 = Math.abs(interp - 2 * sig[k - 1]! + sig[k - 2]!);
          totalOrigD2 += origBoundaryD2;
          totalInterpD2 += interpBoundaryD2 + 1e-15;
        }
      }
    }

    const improveRatio = totalOrigD2 / (totalInterpD2 + 1e-15);

    if (improveRatio < opts.minImprove) continue;

    // Apply repair
    for (let ch = 0; ch < 2; ch++) {
      const sig = channels[ch]!;
      const corr = correctedChs[ch]!;
      const v0 = sig[a0]!;
      const v1 = sig[a1]!;
      const d0 = (sig[a0]! - sig[Math.max(0, a0 - 2)]!) * 0.5;
      const d1 = (sig[Math.min(n - 1, a1 + 2)]! - sig[a1]!) * 0.5;

      for (let k = start; k < end; k++) {
        const t = (k - a0) / span;
        corr[k] = hermite(t, v0, v1, d0 * span, d1 * span);
      }
    }

    detections.push({
      position: start,
      length: len,
      mError: click.peakMErr,
      sError: click.peakSErr,
      msRatio: click.peakMErr / (click.peakSErr + 1e-15),
      improveRatio,
    });
  }

  return { correctedL, correctedR, detections };
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

function printSmoothnessComparison(
  original: Float32Array,
  corrected: Float32Array,
  sampleRate: number,
): void {
  let origDiscont = 0,
    corrDiscont = 0;
  const threshold = 0.005;

  for (let i = 2; i < original.length; i++) {
    const origD2 = Math.abs(original[i]! - 2 * original[i - 1]! + original[i - 2]!);
    const corrD2 = Math.abs(corrected[i]! - 2 * corrected[i - 1]! + corrected[i - 2]!);
    if (origD2 > threshold) origDiscont++;
    if (corrD2 > threshold) corrDiscont++;
  }

  const durationSec = original.length / sampleRate;
  console.log(`\n═══ Smoothness Comparison (channel 0) ═══`);
  console.log(`  Discontinuities (|d²| > ${threshold}):`);
  console.log(`    Original:  ${origDiscont} (${(origDiscont / durationSec).toFixed(1)}/sec)`);
  console.log(`    Corrected: ${corrDiscont} (${(corrDiscont / durationSec).toFixed(1)}/sec)`);
  if (origDiscont > 0) {
    console.log(`    Reduction: ${((1 - corrDiscont / origDiscont) * 100).toFixed(1)}%`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));

function getOpt(name: string, def: number): number {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseFloat(arg.split('=')[1]!) : def;
}

const lpcOrder = getOpt('lpc-order', 12);
const frameSize = getOpt('frame', 512);
const mThreshold = getOpt('m-threshold', 8);
const msRatio = getOpt('ms-ratio', 4);
const minImprove = getOpt('min-improve', 2);
const maxRun = getOpt('max-run', 8);

if (!filePath) {
  console.error('Usage: bun run tools/ms-declicker.ts <input.wav> [options]');
  process.exit(1);
}

console.log(`\nM/S Stereo Declicker: ${filePath}`);
console.log(`  LPC order:      ${lpcOrder}`);
console.log(
  `  Frame size:     ${frameSize} samples (${((frameSize / 48000) * 1000).toFixed(1)}ms)`,
);
console.log(`  M threshold:    ${mThreshold}x median`);
console.log(`  M/S ratio:      ${msRatio}x`);
console.log(`  Min improve:    ${minImprove}x`);
console.log(`  Max click len:  ${maxRun} samples`);

const buffer = readFileSync(filePath);
const wav = parseWav(buffer);

console.log(`\n  Format: ${wav.formatTag === 3 ? 'Float32' : 'Int16'} ${wav.bitsPerSample}bit`);
console.log(`  Sample rate: ${wav.sampleRate}Hz, Channels: ${wav.channels}`);
console.log(`  Duration: ${(wav.samples.length / wav.channels / wav.sampleRate).toFixed(2)}s`);

if (wav.channels < 2) {
  console.error('Error: M/S declicker requires stereo input');
  process.exit(1);
}

const channels = deinterleave(wav.samples, wav.channels);
const left = channels[0]!;
const right = channels[1]!;

const t0 = performance.now();

const result = msDeclick(left, right, {
  lpcOrder,
  frameSize,
  mThreshold,
  msRatio,
  minImprove,
  maxRun,
});

const elapsed = performance.now() - t0;
const durationSec = left.length / wav.sampleRate;

console.log(`\n═══ Detection Results ═══`);
console.log(
  `  Processing time: ${elapsed.toFixed(0)}ms (${(durationSec / (elapsed / 1000)).toFixed(1)}x realtime)`,
);
console.log(
  `  Clicks detected: ${result.detections.length} (${(result.detections.length / durationSec).toFixed(1)}/sec)`,
);

if (result.detections.length > 0) {
  const totalSamples = result.detections.reduce((s, d) => s + d.length, 0);
  console.log(`  Samples repaired: ${totalSamples}`);
  console.log(
    `  Average click length: ${(totalSamples / result.detections.length).toFixed(1)} samples`,
  );

  // M/S ratio stats
  const ratios = result.detections.map((d) => d.msRatio);
  ratios.sort((a, b) => a - b);
  console.log(
    `  M/S ratio: min=${ratios[0]!.toFixed(1)}, median=${ratios[Math.floor(ratios.length / 2)]!.toFixed(1)}, max=${ratios[ratios.length - 1]!.toFixed(1)}`,
  );

  // Improve ratio stats
  const improves = result.detections.map((d) => d.improveRatio);
  improves.sort((a, b) => a - b);
  console.log(
    `  Improve ratio: min=${improves[0]!.toFixed(1)}, median=${improves[Math.floor(improves.length / 2)]!.toFixed(1)}, max=${improves[improves.length - 1]!.toFixed(1)}`,
  );

  // Show first 20 detections
  console.log(`\n  First ${Math.min(20, result.detections.length)} clicks:`);
  console.log('  Position   | Length | M Error  | S Error  | M/S Ratio | Improve');
  console.log('  ' + '-'.repeat(72));
  for (const d of result.detections.slice(0, 20)) {
    const timeMs = ((d.position / wav.sampleRate) * 1000).toFixed(1);
    console.log(
      `  ${String(d.position).padStart(9)} (${timeMs.padStart(8)}ms) | ${String(d.length).padStart(6)} | ${d.mError.toFixed(4).padStart(8)} | ${d.sError.toFixed(4).padStart(8)} | ${d.msRatio.toFixed(1).padStart(9)} | ${d.improveRatio.toFixed(1).padStart(7)}`,
    );
  }
}

// ─── Phase 2: Zero-dropout repair ─────────────────────────────────────────
// Detect contiguous runs of near-zero samples during active signal.
// These are buffer underruns where Chrome inserts silence.

let dropoutsFound = 0;
let dropoutSamplesFixed = 0;

for (let ch = 0; ch < 2; ch++) {
  const corr = ch === 0 ? result.correctedL : result.correctedR;
  const n = corr.length;
  const minActiveRms = 0.05; // signal must be clearly active around the dropout

  let i = 0;
  while (i < n) {
    // Check if sample is near-zero
    if (Math.abs(corr[i]!) > 0.0001) {
      i++;
      continue;
    }

    // Found a near-zero sample — scan for a run
    const runStart = i;
    while (i < n && Math.abs(corr[i]!) < 0.0001) i++;
    const runEnd = i;
    const runLen = runEnd - runStart;

    // Only fix if: run is 2-1024 samples and surrounded by active signal
    if (runLen < 2 || runLen > 1024) continue;
    if (runStart < 64 || runEnd > n - 64) continue;

    // Check RMS before and after — BOTH must be active (not just one)
    let rmsBefore = 0,
      rmsAfter = 0;
    for (let j = runStart - 32; j < runStart; j++) rmsBefore += corr[j]! * corr[j]!;
    for (let j = runEnd; j < Math.min(runEnd + 32, n); j++) rmsAfter += corr[j]! * corr[j]!;
    rmsBefore = Math.sqrt(rmsBefore / 32);
    rmsAfter = Math.sqrt(rmsAfter / Math.min(32, n - runEnd));

    // Both sides must have active signal — this filters natural silence/fades
    if (rmsBefore < minActiveRms || rmsAfter < minActiveRms) continue;

    // This is a dropout in active signal — interpolate across it
    const margin = Math.min(16, runStart); // include some IIR ringing samples
    const repairStart = Math.max(0, runStart - margin);
    const repairEnd = Math.min(n - 1, runEnd + margin);

    const a0 = Math.max(0, repairStart - 1);
    const a1 = Math.min(n - 1, repairEnd);
    const span = a1 - a0;
    if (span <= 1) continue;

    const v0 = corr[a0]!;
    const v1 = corr[a1]!;
    const d0 = (corr[a0]! - corr[Math.max(0, a0 - 2)]!) * 0.5;
    const d1 = (corr[Math.min(n - 1, a1 + 2)]! - corr[a1]!) * 0.5;

    for (let k = repairStart; k < repairEnd; k++) {
      const t = (k - a0) / span;
      corr[k] = hermite(t, v0, v1, d0 * span, d1 * span);
    }

    if (ch === 0) {
      dropoutsFound++;
      dropoutSamplesFixed += repairEnd - repairStart;
    }
  }
}

if (dropoutsFound > 0) {
  console.log(`\n═══ Zero-Dropout Repair ═══`);
  console.log(`  Dropouts found: ${dropoutsFound}`);
  console.log(`  Samples repaired: ${dropoutSamplesFixed}`);
}

// Smoothness comparison
printSmoothnessComparison(left, result.correctedL, wav.sampleRate);

// Write output
const correctedInterleaved = interleave([result.correctedL, result.correctedR]);
const dir = dirname(resolve(filePath));
const base = basename(filePath, '.wav');
const outPath = resolve(dir, `${base}-ms-repaired.wav`);
writeWavFloat32(outPath, correctedInterleaved, wav.sampleRate, wav.channels);
console.log(`\nRepaired WAV: ${outPath}`);

// Write difference signal (10x amplified)
const diffSignal = new Float32Array(left.length);
for (let i = 0; i < left.length; i++) {
  diffSignal[i] = (result.correctedL[i]! - left[i]!) * 10;
}
const diffPath = resolve(dir, `${base}-ms-diff.wav`);
writeWavFloat32(diffPath, diffSignal, wav.sampleRate, 1);
console.log(`Difference (10x): ${diffPath}`);

console.log('\nDone.');
