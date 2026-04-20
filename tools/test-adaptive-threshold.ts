/**
 * Adaptive d² Threshold Test
 *
 * Tests whether an adaptive |d²| threshold (based on local running median)
 * catches more real glitches than the fixed |d²| > 0.005 threshold.
 *
 * A sine wave's natural d² varies with amplitude: near zero crossings d² is
 * near 0, near peaks it's higher. A fixed threshold may miss glitches near
 * peaks (where d² is naturally elevated) or false-positive near zero crossings.
 *
 * This script:
 * 1. Reads the bad WAV file and extracts channel 0
 * 2. Computes |d²| at every sample
 * 3. Computes a running median of |d²| over ±64 samples as "expected d²"
 * 4. Computes the ratio: actual_d2 / expected_d2
 * 5. Flags samples where the ratio exceeds 3.0, 4.0, and 5.0
 * 6. Compares with the fixed-threshold approach (|d²| > 0.005)
 *
 * Usage:
 *   bun run tools/test-adaptive-threshold.ts
 */

import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';

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

// ─────────────────────────────────────────────────────────────────────────────
// Channel Helper
// ─────────────────────────────────────────────────────────────────────────────

function deinterleave(samples: Float32Array, channels: number, ch: number): Float32Array {
  const n = Math.floor(samples.length / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = samples[i * channels + ch]!;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Running Median (insertion sort into sorted window for efficiency)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes a running median of the given array over a window of +-halfWidth.
 * Uses a simple sorted-window approach.
 */
function runningMedian(values: Float64Array, halfWidth: number): Float64Array {
  const n = values.length;
  const result = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWidth);
    const hi = Math.min(n - 1, i + halfWidth);
    const windowSize = hi - lo + 1;

    // Collect window values
    const window: number[] = new Array(windowSize);
    for (let j = 0; j < windowSize; j++) {
      window[j] = values[lo + j]!;
    }
    window.sort((a, b) => a - b);

    // Median
    const mid = windowSize >> 1;
    result[i] = windowSize % 2 === 1 ? window[mid]! : (window[mid - 1]! + window[mid]!) / 2;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const inputPath = resolve(
  dirname(new URL(import.meta.url).pathname),
  'pcm-capture-float32-input-bad.wav',
);

console.log(`\nAdaptive d2 Threshold Test`);
console.log(`Input: ${inputPath}\n`);

const buffer = readFileSync(inputPath);
const wav = parseWav(buffer);

console.log(`Format: ${wav.formatTag === 3 ? 'Float32' : 'Int16'} ${wav.bitsPerSample}bit`);
console.log(`Sample rate: ${wav.sampleRate}Hz, Channels: ${wav.channels}`);
const totalSamplesPerChannel = Math.floor(wav.samples.length / wav.channels);
const durationSec = totalSamplesPerChannel / wav.sampleRate;
console.log(`Duration: ${durationSec.toFixed(2)}s (${totalSamplesPerChannel} samples/ch)`);

// Extract channel 0
const ch0 = deinterleave(wav.samples, wav.channels, 0);
const n = ch0.length;

// ─── Step 1: Compute |d2| at every sample ────────────────────────────────────

console.log(`\n--- Step 1: Computing |d2| for all ${n} samples ---`);

const d2 = new Float64Array(n);
for (let i = 2; i < n; i++) {
  d2[i] = Math.abs(ch0[i]! - 2 * ch0[i - 1]! + ch0[i - 2]!);
}

// Basic stats on d2
let d2Sum = 0;
let d2Max = 0;
let d2Nonzero = 0;
for (let i = 2; i < n; i++) {
  d2Sum += d2[i]!;
  if (d2[i]! > d2Max) d2Max = d2[i]!;
  if (d2[i]! > 0) d2Nonzero++;
}
console.log(`  Mean |d2|: ${(d2Sum / (n - 2)).toExponential(4)}`);
console.log(`  Max  |d2|: ${d2Max.toExponential(4)}`);

// ─── Step 2: Compute running median of |d2| over +-64 samples ───────────────

const HALF_WIDTH = 64;
console.log(`\n--- Step 2: Computing running median of |d2| (+-${HALF_WIDTH} samples) ---`);
console.log(`  This may take a moment...`);

const expectedD2 = runningMedian(d2, HALF_WIDTH);

// Stats on expected d2
let expSum = 0;
let expMax = 0;
let expZeroCount = 0;
for (let i = 2; i < n; i++) {
  expSum += expectedD2[i]!;
  if (expectedD2[i]! > expMax) expMax = expectedD2[i]!;
  if (expectedD2[i]! === 0) expZeroCount++;
}
console.log(`  Mean expected d2: ${(expSum / (n - 2)).toExponential(4)}`);
console.log(`  Max  expected d2: ${expMax.toExponential(4)}`);
console.log(`  Zero expected d2: ${expZeroCount} samples (ratio undefined here)`);

// ─── Step 3: Compute ratio and flag at different thresholds ──────────────────

const EPS = 1e-12; // avoid division by zero
const RATIO_THRESHOLDS = [3.0, 4.0, 5.0];

console.log(`\n--- Step 3: Adaptive threshold analysis ---`);

// Also compute fixed threshold flags
const FIXED_THRESHOLD = 0.005;
const fixedFlagged = new Uint8Array(n);
let fixedCount = 0;
for (let i = 2; i < n; i++) {
  if (d2[i]! > FIXED_THRESHOLD) {
    fixedFlagged[i] = 1;
    fixedCount++;
  }
}
console.log(
  `\nFixed threshold (|d2| > ${FIXED_THRESHOLD}): ${fixedCount} flagged samples (${(fixedCount / durationSec).toFixed(1)}/sec)`,
);

for (const ratioThresh of RATIO_THRESHOLDS) {
  const adaptiveFlagged = new Uint8Array(n);
  let adaptiveCount = 0;

  for (let i = 2; i < n; i++) {
    const expected = expectedD2[i]!;
    if (expected < EPS) continue; // skip where expected is zero (ratio undefined)
    const ratio = d2[i]! / expected;
    if (ratio > ratioThresh) {
      adaptiveFlagged[i] = 1;
      adaptiveCount++;
    }
  }

  // Compute overlap with fixed threshold
  let bothFlagged = 0;
  let onlyAdaptive = 0;
  let onlyFixed = 0;
  for (let i = 2; i < n; i++) {
    const a = adaptiveFlagged[i]!;
    const f = fixedFlagged[i]!;
    if (a && f) bothFlagged++;
    else if (a && !f) onlyAdaptive++;
    else if (!a && f) onlyFixed++;
  }

  console.log(`\nAdaptive threshold (ratio > ${ratioThresh.toFixed(1)}):`);
  console.log(
    `  Flagged samples:    ${adaptiveCount} (${(adaptiveCount / durationSec).toFixed(1)}/sec)`,
  );
  console.log(`  Overlap with fixed: ${bothFlagged} samples flagged by BOTH`);
  console.log(
    `  Only adaptive:      ${onlyAdaptive} samples (caught by adaptive, missed by fixed)`,
  );
  console.log(`  Only fixed:         ${onlyFixed} samples (caught by fixed, missed by adaptive)`);
  console.log(
    `  Jaccard similarity: ${((bothFlagged / (bothFlagged + onlyAdaptive + onlyFixed)) * 100).toFixed(1)}%`,
  );

  // Show some examples of samples caught only by adaptive (potential misses by fixed)
  if (onlyAdaptive > 0) {
    const examples: { idx: number; d2Val: number; expected: number; ratio: number }[] = [];
    for (let i = 2; i < n && examples.length < 10; i++) {
      if (adaptiveFlagged[i]! && !fixedFlagged[i]!) {
        const expected = expectedD2[i]!;
        examples.push({
          idx: i,
          d2Val: d2[i]!,
          expected,
          ratio: d2[i]! / (expected + EPS),
        });
      }
    }
    console.log(`  Examples caught ONLY by adaptive (first ${examples.length}):`);
    console.log(
      `    ${'Sample'.padEnd(10)} | ${'|d2|'.padEnd(14)} | ${'Expected'.padEnd(14)} | Ratio`,
    );
    console.log(`    ${'-'.repeat(60)}`);
    for (const ex of examples) {
      console.log(
        `    ${String(ex.idx).padEnd(10)} | ${ex.d2Val.toExponential(4).padEnd(14)} | ${ex.expected.toExponential(4).padEnd(14)} | ${ex.ratio.toFixed(2)}`,
      );
    }
  }

  // Show some examples of samples caught only by fixed (potential false positives?)
  if (onlyFixed > 0) {
    const examples: { idx: number; d2Val: number; expected: number; ratio: number }[] = [];
    for (let i = 2; i < n && examples.length < 10; i++) {
      if (!adaptiveFlagged[i]! && fixedFlagged[i]!) {
        const expected = expectedD2[i]!;
        examples.push({
          idx: i,
          d2Val: d2[i]!,
          expected,
          ratio: expected > EPS ? d2[i]! / expected : Infinity,
        });
      }
    }
    console.log(`  Examples caught ONLY by fixed (first ${examples.length}):`);
    console.log(
      `    ${'Sample'.padEnd(10)} | ${'|d2|'.padEnd(14)} | ${'Expected'.padEnd(14)} | Ratio`,
    );
    console.log(`    ${'-'.repeat(60)}`);
    for (const ex of examples) {
      const ratioStr = ex.ratio === Infinity ? 'Inf' : ex.ratio.toFixed(2);
      console.log(
        `    ${String(ex.idx).padEnd(10)} | ${ex.d2Val.toExponential(4).padEnd(14)} | ${ex.expected.toExponential(4).padEnd(14)} | ${ratioStr}`,
      );
    }
  }
}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${'='.repeat(70)}`);
console.log(`SUMMARY`);
console.log(`${'='.repeat(70)}`);
console.log(`Fixed (|d2| > 0.005):         ${fixedCount} flagged`);
for (const ratioThresh of RATIO_THRESHOLDS) {
  let count = 0;
  for (let i = 2; i < n; i++) {
    const expected = expectedD2[i]!;
    if (expected < EPS) continue;
    if (d2[i]! / expected > ratioThresh) count++;
  }
  console.log(
    `Adaptive (ratio > ${ratioThresh.toFixed(1)}):       ${String(count).padStart(5)} flagged`,
  );
}
console.log(`\nDone.`);
