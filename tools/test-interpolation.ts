/**
 * Interpolation Quality Benchmark
 *
 * Compares three interpolation methods for repairing zeroed-out glitch regions:
 *   a) Hermite cubic (current approach — 2 anchor points + tangents)
 *   b) Catmull-Rom with subdivision (splits runs > 12 into sub-segments)
 *   c) Windowed sinc (bandlimited interpolation from surrounding clean samples)
 *
 * Usage:
 *   bun run tools/test-interpolation.ts
 */

import { readFileSync } from 'fs';

// ─────────────────────────────────────────────────────────────────────────────
// WAV Parser (copied from envelope-smooth.ts)
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
  const wave = String.fromCharCode(...buffer.subarray(8, 12));
  if (wave !== 'WAVE') throw new Error('Not a WAVE file');

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

function deinterleave(samples: Float32Array, channels: number, ch: number): Float32Array {
  const n = Math.floor(samples.length / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = samples[i * channels + ch]!;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Interpolation Methods
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Hermite interpolation between two points with tangents.
 * This is the current method used in envelope-smooth.ts.
 */
function hermite(t: number, v0: number, v1: number, m0: number, m1: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1
  );
}

/**
 * Method A: Current Hermite interpolation (2 anchor points + tangents).
 * Single cubic spline across the entire gap.
 */
function repairHermite(signal: Float32Array, glitchStart: number, glitchEnd: number): void {
  const a0 = glitchStart - 1;
  const a1 = glitchEnd;
  const span = a1 - a0;
  if (span <= 1) return;

  const v0 = signal[a0]!;
  const v1 = signal[a1]!;
  // 2-sample central difference for tangents (matches envelope-smooth.ts)
  const d0 = (signal[a0]! - signal[a0 - 2]!) * 0.5;
  const d1 = (signal[Math.min(signal.length - 1, a1 + 2)]! - signal[a1]!) * 0.5;

  for (let k = glitchStart; k < glitchEnd; k++) {
    const t = (k - a0) / span;
    signal[k] = hermite(t, v0, v1, d0 * span, d1 * span);
  }
}

/**
 * Method B: Catmull-Rom with subdivision.
 * For runs > 12, splits into sub-segments. Predicts intermediate anchor points
 * from the initial Hermite curve, then re-fits each sub-segment with its own
 * Catmull-Rom spline for better local accuracy.
 */
function repairCatmullRomSubdivided(
  signal: Float32Array,
  glitchStart: number,
  glitchEnd: number,
): void {
  const runLen = glitchEnd - glitchStart;
  const a0 = glitchStart - 1;
  const a1 = glitchEnd;
  const span = a1 - a0;
  if (span <= 1) return;

  const v0 = signal[a0]!;
  const v1 = signal[a1]!;
  const d0 = (signal[a0]! - signal[a0 - 2]!) * 0.5;
  const d1 = (signal[Math.min(signal.length - 1, a1 + 2)]! - signal[a1]!) * 0.5;

  const maxSubLen = 12;
  if (runLen <= maxSubLen) {
    // Short run: single Catmull-Rom (equivalent to Hermite with Catmull-Rom tangents)
    for (let k = glitchStart; k < glitchEnd; k++) {
      const t = (k - a0) / span;
      signal[k] = hermite(t, v0, v1, d0 * span, d1 * span);
    }
    return;
  }

  // Step 1: Generate initial Hermite prediction across full span
  const predicted = new Float64Array(runLen);
  for (let k = 0; k < runLen; k++) {
    const t = (k + 1) / span; // k+1 because glitchStart = a0+1
    predicted[k] = hermite(t, v0, v1, d0 * span, d1 * span);
  }

  // Step 2: Choose subdivision points
  const numSubs = Math.ceil(runLen / maxSubLen);
  const subLen = runLen / numSubs;

  // Build anchor array: [real_left, predicted_mid1, predicted_mid2, ..., real_right]
  // Each anchor has: index (in signal), value, tangent
  interface Anchor {
    idx: number; // absolute index in signal
    val: number;
    tangent: number;
  }

  const anchors: Anchor[] = [];

  // Left anchor (real)
  anchors.push({
    idx: a0,
    val: v0,
    tangent: d0,
  });

  // Intermediate anchors (from Hermite prediction)
  for (let s = 1; s < numSubs; s++) {
    const localK = Math.round(s * subLen); // offset within glitch region
    const absIdx = glitchStart + localK;
    const predVal = predicted[localK]!;

    // Tangent from predicted values (central difference)
    const prevK = Math.max(0, localK - 1);
    const nextK = Math.min(runLen - 1, localK + 1);
    const tangent = (predicted[nextK]! - predicted[prevK]!) / (nextK - prevK);

    anchors.push({ idx: absIdx, val: predVal, tangent });
  }

  // Right anchor (real)
  anchors.push({
    idx: a1,
    val: v1,
    tangent: d1,
  });

  // Step 3: Fit Catmull-Rom spline per sub-segment
  for (let s = 0; s < anchors.length - 1; s++) {
    const left = anchors[s]!;
    const right = anchors[s + 1]!;
    const segSpan = right.idx - left.idx;
    if (segSpan <= 0) continue;

    const segStart = Math.max(glitchStart, left.idx + (s === 0 ? 1 : 0));
    const segEnd = Math.min(glitchEnd, right.idx + (s === anchors.length - 2 ? 0 : 0));

    for (let k = segStart; k < segEnd; k++) {
      const t = (k - left.idx) / segSpan;
      signal[k] = hermite(t, left.val, right.val, left.tangent * segSpan, right.tangent * segSpan);
    }
  }
}

/**
 * Method C: Windowed sinc interpolation (bandlimited).
 *
 * Standard sinc interpolation assumes all samples are present. When there is a
 * gap, we use Papoulis-Gerchberg-style iterative extrapolation:
 *   1. Fill gap with an initial estimate (linear interpolation).
 *   2. Repeatedly lowpass-filter the full signal, then restore the known
 *      samples outside the gap, keeping only the filtered values inside the gap.
 *   3. After convergence the gap values are bandlimited-consistent with the
 *      surrounding clean samples.
 */
function repairSinc(signal: Float32Array, glitchStart: number, glitchEnd: number): void {
  const n = signal.length;
  const runLen = glitchEnd - glitchStart;

  // Work on a local window to keep cost manageable
  const wing = Math.max(64, runLen * 4);
  const wStart = Math.max(0, glitchStart - wing);
  const wEnd = Math.min(n, glitchEnd + wing);
  const wLen = wEnd - wStart;

  // Extract local window and save known values
  const buf = new Float64Array(wLen);
  const known = new Float64Array(wLen);
  for (let i = 0; i < wLen; i++) {
    buf[i] = signal[wStart + i]!;
    known[i] = signal[wStart + i]!;
  }

  // Initial estimate: linear interpolation across the gap
  const gS = glitchStart - wStart; // gap start in local coords
  const gE = glitchEnd - wStart; // gap end in local coords
  const vLeft = buf[gS - 1]!;
  const vRight = buf[gE]!;
  for (let i = gS; i < gE; i++) {
    buf[i] = vLeft + (vRight - vLeft) * ((i - gS + 1) / (gE - gS + 1));
  }

  // Lowpass via windowed-sinc convolution (cutoff just below Nyquist)
  const cutoff = 0.95;
  const filterHalf = Math.min(wing, 48);
  const iterations = 30;

  // Precompute sinc kernel
  const kernel = new Float64Array(2 * filterHalf + 1);
  let kernelSum = 0;
  for (let j = -filterHalf; j <= filterHalf; j++) {
    kernel[j + filterHalf] = windowedSinc(j, cutoff, filterHalf);
    kernelSum += kernel[j + filterHalf]!;
  }
  // Normalize kernel so it sums to 1 (unity gain at DC)
  for (let j = 0; j < kernel.length; j++) kernel[j] /= kernelSum;

  const filtered = new Float64Array(wLen);

  for (let iter = 0; iter < iterations; iter++) {
    // Convolve (only need to compute values inside the gap region,
    // plus a small margin to avoid edge effects on next iteration)
    const cStart = Math.max(0, gS - filterHalf);
    const cEnd = Math.min(wLen, gE + filterHalf);
    for (let i = cStart; i < cEnd; i++) {
      let sum = 0;
      for (let j = -filterHalf; j <= filterHalf; j++) {
        const idx = i + j;
        if (idx < 0 || idx >= wLen) continue;
        sum += buf[idx]! * kernel[j + filterHalf]!;
      }
      filtered[i] = sum;
    }

    // Replace gap with filtered values; restore known samples outside gap
    for (let i = cStart; i < cEnd; i++) {
      if (i >= gS && i < gE) {
        buf[i] = filtered[i]!;
      } else {
        buf[i] = known[i]!;
      }
    }
  }

  // Write repaired gap back
  for (let i = gS; i < gE; i++) {
    signal[wStart + i] = buf[i]!;
  }
}

/**
 * Windowed sinc function: sinc(x * cutoff) * blackmanHarris(x / wing).
 */
function windowedSinc(x: number, cutoff: number, wing: number): number {
  if (x === 0) return cutoff;

  const piX = Math.PI * x;
  const sincVal = Math.sin(piX * cutoff) / piX;

  // Blackman-Harris window
  const nx = x / wing;
  if (Math.abs(nx) > 1) return 0;
  const a0 = 0.35875;
  const a1 = 0.48829;
  const a2 = 0.14128;
  const a3 = 0.01168;
  const cosArg = Math.PI * (nx + 1); // map [-1,1] to [0, 2pi]
  const win = a0 - a1 * Math.cos(cosArg) + a2 * Math.cos(2 * cosArg) - a3 * Math.cos(3 * cosArg);

  return sincVal * win;
}

// ─────────────────────────────────────────────────────────────────────────────
// Test Harness
// ─────────────────────────────────────────────────────────────────────────────

interface TrialResult {
  runLength: number;
  method: string;
  mse: number;
  maxErr: number;
}

/**
 * Runs a single trial: zeros out a region, repairs it, measures error.
 */
function runTrial(
  clean: Float32Array,
  glitchStart: number,
  runLength: number,
  method: 'hermite' | 'catmull-rom' | 'sinc',
): { mse: number; maxErr: number } {
  const glitchEnd = glitchStart + runLength;

  // Make a copy and zero out the glitch region
  const damaged = new Float32Array(clean);
  for (let i = glitchStart; i < glitchEnd; i++) {
    damaged[i] = 0;
  }

  // Repair
  switch (method) {
    case 'hermite':
      repairHermite(damaged, glitchStart, glitchEnd);
      break;
    case 'catmull-rom':
      repairCatmullRomSubdivided(damaged, glitchStart, glitchEnd);
      break;
    case 'sinc':
      repairSinc(damaged, glitchStart, glitchEnd);
      break;
  }

  // Measure error vs clean original
  let sumSqErr = 0;
  let maxErr = 0;
  for (let i = glitchStart; i < glitchEnd; i++) {
    const err = Math.abs(damaged[i]! - clean[i]!);
    sumSqErr += err * err;
    if (err > maxErr) maxErr = err;
  }

  return {
    mse: sumSqErr / runLength,
    maxErr,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const TOOLS_DIR = new URL('.', import.meta.url).pathname;

console.log('Interpolation Quality Benchmark');
console.log('================================\n');

// Load WAV files
const goodPath = `${TOOLS_DIR}pcm-capture-float32-input-good.wav`;
const badPath = `${TOOLS_DIR}pcm-capture-float32-input-bad.wav`;

console.log(`Good file: ${goodPath}`);
console.log(`Bad file:  ${badPath}\n`);

const goodWav = parseWav(readFileSync(goodPath));
const badWav = parseWav(readFileSync(badPath));

console.log(
  `Good: ${goodWav.sampleRate}Hz, ${goodWav.channels}ch, ${(goodWav.samples.length / goodWav.channels / goodWav.sampleRate).toFixed(2)}s`,
);
console.log(
  `Bad:  ${badWav.sampleRate}Hz, ${badWav.channels}ch, ${(badWav.samples.length / badWav.channels / badWav.sampleRate).toFixed(2)}s\n`,
);

// Extract channel 0 from good file
const clean = deinterleave(goodWav.samples, goodWav.channels, 0);
console.log(`Channel 0: ${clean.length} samples\n`);

// Find regions with reasonable signal (avoid silence/near-silence)
// We need anchor margins of at least 3 on each side, plus wing for sinc
const margin = 100; // generous margin for sinc wing
const runLengths = [4, 8, 16, 32, 48];
const trialsPerConfig = 50;
const methods: Array<'hermite' | 'catmull-rom' | 'sinc'> = ['hermite', 'catmull-rom', 'sinc'];

// Find candidate positions: regions where local RMS is above a threshold
// so we are testing on actual audio content, not silence
function findCandidatePositions(signal: Float32Array, count: number, maxRun: number): number[] {
  const positions: number[] = [];
  const minRms = 0.01;
  const blockSize = 256;
  const step = Math.max(1, Math.floor((signal.length - 2 * margin - maxRun) / (count * 3)));

  for (let pos = margin; pos < signal.length - margin - maxRun; pos += step) {
    // Check local RMS around this position
    let sumSq = 0;
    const start = Math.max(0, pos - blockSize / 2);
    const end = Math.min(signal.length, pos + blockSize / 2);
    for (let i = start; i < end; i++) {
      sumSq += signal[i]! * signal[i]!;
    }
    const rms = Math.sqrt(sumSq / (end - start));

    if (rms >= minRms) {
      positions.push(pos);
      if (positions.length >= count) break;
    }
  }

  return positions;
}

const maxRun = Math.max(...runLengths);
const candidates = findCandidatePositions(clean, trialsPerConfig, maxRun);
console.log(`Found ${candidates.length} candidate positions with sufficient signal level.\n`);

if (candidates.length < trialsPerConfig) {
  console.log(`WARNING: Only ${candidates.length} candidates found, wanted ${trialsPerConfig}.\n`);
}

// Run trials
const results: TrialResult[] = [];

for (const runLen of runLengths) {
  for (const method of methods) {
    const mseValues: number[] = [];
    const maxErrValues: number[] = [];

    const numTrials = Math.min(trialsPerConfig, candidates.length);
    for (let t = 0; t < numTrials; t++) {
      const pos = candidates[t]!;
      const { mse, maxErr } = runTrial(clean, pos, runLen, method);
      mseValues.push(mse);
      maxErrValues.push(maxErr);
    }

    // Compute mean MSE and mean max error
    const meanMse = mseValues.reduce((a, b) => a + b, 0) / mseValues.length;
    const meanMaxErr = maxErrValues.reduce((a, b) => a + b, 0) / maxErrValues.length;

    results.push({
      runLength: runLen,
      method,
      mse: meanMse,
      maxErr: meanMaxErr,
    });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────

console.log('Results (mean over all trials)');
console.log('='.repeat(80));
console.log(
  'Run Length'.padEnd(12) +
    'Method'.padEnd(16) +
    'MSE'.padEnd(16) +
    'Max Error'.padEnd(16) +
    'MSE (dB)',
);
console.log('-'.repeat(80));

for (const r of results) {
  const mseDb = 10 * Math.log10(r.mse + 1e-20);
  console.log(
    String(r.runLength).padEnd(12) +
      r.method.padEnd(16) +
      r.mse.toExponential(4).padEnd(16) +
      r.maxErr.toExponential(4).padEnd(16) +
      mseDb.toFixed(2),
  );
}

// Determine winner per run length
console.log('\n' + '='.repeat(80));
console.log('Best Method per Run Length');
console.log('-'.repeat(80));

for (const runLen of runLengths) {
  const group = results.filter((r) => r.runLength === runLen);
  group.sort((a, b) => a.mse - b.mse);
  const best = group[0]!;
  const worst = group[group.length - 1]!;
  const improvement = ((1 - best.mse / worst.mse) * 100).toFixed(1);

  console.log(
    `  Run ${String(runLen).padStart(2)}: ${best.method.padEnd(14)} ` +
      `(MSE ${best.mse.toExponential(3)}, ${improvement}% better than ${worst.method})`,
  );

  // Show all methods ranked
  for (let i = 0; i < group.length; i++) {
    const r = group[i]!;
    const marker = i === 0 ? ' <-- BEST' : '';
    const relativeToWinner = i === 0 ? '' : ` (+${((r.mse / best.mse - 1) * 100).toFixed(1)}%)`;
    console.log(
      `           ${i + 1}. ${r.method.padEnd(14)} MSE=${r.mse.toExponential(3)}  MaxErr=${r.maxErr.toExponential(3)}${relativeToWinner}${marker}`,
    );
  }
}

console.log('\nDone.');
