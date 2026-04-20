/**
 * Quantum Dip Repair — Proof of Concept
 *
 * Detects and corrects per-quantum amplitude dips caused by Chrome's audio
 * renderer producing attenuated render quanta on low-end devices.
 *
 * Algorithm:
 * 1. Compute RMS per 128-sample block (Chrome render quantum)
 * 2. Convert to dB: e[n] = 20*log10(rms[n] + eps)
 * 3. Compute robust local baseline via median over ±K blocks
 * 4. Flag blocks where e[n] is significantly below baseline (downward outliers only)
 * 5. Compute bounded gain correction in dB for flagged blocks only
 * 6. Interpolate gain in dB space across block centers for continuity
 * 7. Apply linked stereo envelope (max RMS across channels per block)
 *
 * Key design choices:
 * - Only boosts dips, never attenuates peaks (asymmetric — targets the defect)
 * - Median baseline resists transients better than moving average
 * - Threshold prevents false positives on legitimate dynamics
 * - Max boost clamp prevents noise pumping near silence
 * - dB-space interpolation for perceptually smooth gain transitions
 * - Silence gating: no correction applied below a noise floor
 *
 * Usage:
 *   bun run tools/envelope-smooth.ts <input.wav> [options]
 *
 * Options:
 *   --block=128       Block size in samples (default: 128 = render quantum)
 *   --median-half=4   Half-width of median window in blocks (default: 4, total 9 blocks)
 *   --threshold=1.5   Minimum dip in dB below baseline to trigger correction (default: 1.5)
 *   --max-boost=4     Maximum boost in dB (default: 4)
 *   --silence=-60     Silence gate threshold in dBFS (default: -60)
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

function deinterleave(samples: Float32Array, channels: number, ch: number): Float32Array {
  const n = Math.floor(samples.length / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = samples[i * channels + ch]!;
  return out;
}

function interleave(channelData: Float32Array[], channels: number): Float32Array {
  const n = channelData[0]!.length;
  const out = new Float32Array(n * channels);
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < channels; ch++) {
      out[i * channels + ch] = channelData[ch]![i]!;
    }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Core Algorithm
// ─────────────────────────────────────────────────────────────────────────────

const EPS = 1e-10;

function toDb(linear: number): number {
  return 20 * Math.log10(linear + EPS);
}

function fromDb(db: number): number {
  return Math.pow(10, db / 20);
}

/**
 * Computes RMS per block for a single channel.
 */
function computeBlockRms(mono: Float32Array, blockSize: number): Float64Array {
  const numBlocks = Math.floor(mono.length / blockSize);
  const rms = new Float64Array(numBlocks);
  for (let b = 0; b < numBlocks; b++) {
    const start = b * blockSize;
    let sumSq = 0;
    for (let i = 0; i < blockSize; i++) {
      const s = mono[start + i]!;
      sumSq += s * s;
    }
    rms[b] = Math.sqrt(sumSq / blockSize);
  }
  return rms;
}

/**
 * Computes linked stereo RMS: max(rmsL[n], rmsR[n]) per block.
 * This ensures both channels get the same gain correction, preventing
 * stereo image shifts.
 */
function computeLinkedRms(channelRms: Float64Array[]): Float64Array {
  const numBlocks = channelRms[0]!.length;
  const linked = new Float64Array(numBlocks);
  for (let b = 0; b < numBlocks; b++) {
    let maxRms = 0;
    for (const rms of channelRms) {
      if (rms[b]! > maxRms) maxRms = rms[b]!;
    }
    linked[b] = maxRms;
  }
  return linked;
}

/**
 * Computes a running percentile over ±halfWidth blocks.
 *
 * Using a high percentile (e.g., 0.75-0.85) instead of median for the baseline
 * makes it resistant to contamination when a large fraction of blocks are damaged.
 * If 40% of blocks are attenuated, the median is pulled down, but P80 still
 * reflects the healthy level.
 */
function runningPercentile(
  values: Float64Array,
  halfWidth: number,
  percentile: number,
): Float64Array {
  const n = values.length;
  const result = new Float64Array(n);

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - halfWidth);
    const hi = Math.min(n - 1, i + halfWidth);
    const windowSize = hi - lo + 1;

    const window: number[] = new Array(windowSize);
    for (let j = 0; j < windowSize; j++) {
      window[j] = values[lo + j]!;
    }
    window.sort((a, b) => a - b);

    const idx = Math.min(windowSize - 1, Math.floor(windowSize * percentile));
    result[i] = window[idx]!;
  }

  return result;
}

interface DipInfo {
  /** Block index. */
  block: number;
  /** How far below baseline in dB. */
  dipDb: number;
  /** Gain correction applied in dB. */
  boostDb: number;
}

/**
 * Detects dips and computes per-block gain correction in dB.
 *
 * Uses a high percentile (P80) as the baseline so it's resistant to
 * contamination even when a large fraction of blocks are damaged.
 * Only boosts, never attenuates. No neighbor check — the high percentile
 * baseline + threshold already provides transient protection.
 */
function computeGainCurve(
  linkedRms: Float64Array,
  medianHalf: number,
  thresholdDb: number,
  maxBoostDb: number,
  silenceDbFs: number,
  baselinePercentile: number,
): { gainDb: Float64Array; dips: DipInfo[] } {
  const numBlocks = linkedRms.length;

  // Convert to dB
  const levelDb = new Float64Array(numBlocks);
  for (let b = 0; b < numBlocks; b++) {
    levelDb[b] = toDb(linkedRms[b]!);
  }

  // Compute robust baseline via running high percentile.
  // P80 means the baseline tracks the top 20% of blocks in each window,
  // which represents the "healthy" level even if most blocks are damaged.
  const baselineDb = runningPercentile(levelDb, medianHalf, baselinePercentile);

  // Compute gain correction
  const gainDb = new Float64Array(numBlocks); // 0 = no correction
  const dips: DipInfo[] = [];

  for (let b = 0; b < numBlocks; b++) {
    // Skip silent blocks entirely
    if (levelDb[b]! < silenceDbFs) continue;

    const delta = baselineDb[b]! - levelDb[b]!;

    // Only correct downward outliers exceeding threshold
    if (delta <= thresholdDb) continue;

    // Compute bounded boost: restore toward baseline minus a small margin
    // The margin (threshold * 0.5) prevents overcorrection to exact baseline
    const boost = Math.min(delta - thresholdDb * 0.3, maxBoostDb);

    if (boost > 0) {
      gainDb[b] = boost;
      dips.push({ block: b, dipDb: delta, boostDb: boost });
    }
  }

  return { gainDb, dips };
}

/**
 * 2nd-derivative declicker with adaptive threshold and context density filter.
 *
 * Detection: |d²| > max(baseThreshold, localRMS * rmsMultiplier)
 * Music safety: context density filter rejects samples in dense transient regions
 * Transient safety: hitLimit rejects runs that reach maxRunLength (likely music)
 * Repair: Hermite cubic interpolation from boundary anchor points
 * Two-pass: second pass at 60% threshold catches repair-boundary artifacts
 */
function declickChannel(
  mono: Float32Array,
  baseD2Threshold: number,
  maxRunLength: number,
  passes: number,
  maxContextDensity: number,
): { corrected: Float32Array; glitchCount: number; samplesFixed: number } {
  let current = new Float32Array(mono);
  let totalGlitchCount = 0;
  let totalSamplesFixed = 0;

  for (let pass = 0; pass < passes; pass++) {
    const thresholdMult = pass === 0 ? 1.0 : 0.6;
    const { corrected, glitchCount, samplesFixed } = declickPass(
      current,
      baseD2Threshold * thresholdMult,
      maxRunLength,
      maxContextDensity,
    );
    current = corrected;
    totalGlitchCount += glitchCount;
    totalSamplesFixed += samplesFixed;
  }

  return { corrected: current, glitchCount: totalGlitchCount, samplesFixed: totalSamplesFixed };
}

function declickPass(
  mono: Float32Array,
  baseD2Threshold: number,
  maxRunLength: number,
  maxContextDensity: number,
): { corrected: Float32Array; glitchCount: number; samplesFixed: number } {
  const n = mono.length;
  const corrected = new Float32Array(mono);

  // Compute |2nd derivative| for all samples
  const d2 = new Float64Array(n);
  for (let i = 2; i < n; i++) {
    d2[i] = Math.abs(mono[i]! - 2 * mono[i - 1]! + mono[i - 2]!);
  }

  // Compute local RMS for adaptive threshold
  const rmsHalf = 64;
  const cumSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumSq[i + 1] = cumSq[i]! + mono[i]! * mono[i]!;
  }
  function localRms(idx: number): number {
    const lo = Math.max(0, idx - rmsHalf);
    const hi = Math.min(n, idx + rmsHalf);
    return Math.sqrt((cumSq[hi]! - cumSq[lo]!) / (hi - lo));
  }

  // Context density: fraction of ±128 samples exceeding threshold
  const densityHalf = 128;
  const aboveThreshold = new Uint8Array(n);
  for (let i = 2; i < n; i++) {
    const thr = Math.max(baseD2Threshold, localRms(i) * 0.008);
    aboveThreshold[i] = d2[i]! > thr ? 1 : 0;
  }
  const cumAbove = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumAbove[i + 1] = cumAbove[i]! + aboveThreshold[i]!;
  }
  function contextDensity(idx: number): number {
    const lo = Math.max(0, idx - densityHalf);
    const hi = Math.min(n, idx + densityHalf);
    return (cumAbove[hi]! - cumAbove[lo]!) / (hi - lo);
  }

  let glitchCount = 0;
  let samplesFixed = 0;
  const anchorMargin = 3;

  let i = anchorMargin;
  while (i < n - anchorMargin) {
    const adaptiveThreshold = Math.max(baseD2Threshold, localRms(i) * 0.008);

    if (d2[i]! <= adaptiveThreshold) {
      i++;
      continue;
    }

    // Context density filter: reject dense transient regions
    if (contextDensity(i) > maxContextDensity) {
      i++;
      continue;
    }

    // Found start of a glitch region
    const glitchStart = Math.max(anchorMargin, i - 1);

    // Find end: scan forward until d² drops below adaptive threshold for 3 consecutive samples
    let j = i + 1;
    while (j < n - anchorMargin && j - glitchStart < maxRunLength) {
      const thr = Math.max(baseD2Threshold, localRms(j) * 0.008);
      if (d2[j]! <= thr && d2[Math.min(n - 1, j + 1)]! <= thr && d2[Math.min(n - 1, j + 2)]! <= thr)
        break;
      j++;
    }

    const glitchEnd = Math.min(n - anchorMargin, j + 1);
    const runLen = glitchEnd - glitchStart;
    const hitLimit = j - glitchStart >= maxRunLength;

    if (
      !hitLimit &&
      runLen > 0 &&
      runLen <= maxRunLength &&
      glitchStart >= anchorMargin &&
      glitchEnd < n - anchorMargin
    ) {
      const a0 = glitchStart - 1;
      const a1 = glitchEnd;
      const span = a1 - a0;

      if (span > 1) {
        const v0 = mono[a0]!;
        const v1 = mono[a1]!;
        const d0 = (mono[a0]! - mono[Math.max(0, a0 - 2)]!) * 0.5;
        const d1 = (mono[Math.min(n - 1, a1 + 2)]! - mono[a1]!) * 0.5;

        for (let k = glitchStart; k < glitchEnd; k++) {
          const t = (k - a0) / span;
          corrected[k] = hermite(t, v0, v1, d0 * span, d1 * span);
        }

        glitchCount++;
        samplesFixed += runLen;
      }
    }

    i = glitchEnd + 1;
  }

  return { corrected, glitchCount, samplesFixed };
}

/**
 * Hermite interpolation between two points with tangents.
 */
function hermite(t: number, v0: number, v1: number, m0: number, m1: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Diagnostics
// ─────────────────────────────────────────────────────────────────────────────

function printDipStats(
  dips: DipInfo[],
  numBlocks: number,
  blockSize: number,
  sampleRate: number,
): void {
  const durationSec = (numBlocks * blockSize) / sampleRate;
  const blockMs = ((blockSize / sampleRate) * 1000).toFixed(2);

  console.log(`\n═══ Dip Detection ═══`);
  console.log(`  Total blocks: ${numBlocks} (${blockMs}ms each)`);
  console.log(`  Dips found: ${dips.length}`);
  console.log(`  Dip rate: ${(dips.length / durationSec).toFixed(2)}/sec`);

  if (dips.length === 0) return;

  // Dip severity distribution
  const dipDbs = dips.map((d) => d.dipDb);
  dipDbs.sort((a, b) => a - b);
  console.log(`\n  Dip severity (dB below baseline):`);
  console.log(`    Min:    ${dipDbs[0]!.toFixed(2)} dB`);
  console.log(`    Median: ${dipDbs[Math.floor(dipDbs.length / 2)]!.toFixed(2)} dB`);
  console.log(`    Max:    ${dipDbs[dipDbs.length - 1]!.toFixed(2)} dB`);

  // Boost applied distribution
  const boosts = dips.map((d) => d.boostDb);
  boosts.sort((a, b) => a - b);
  console.log(`\n  Boost applied:`);
  console.log(`    Min:    ${boosts[0]!.toFixed(2)} dB`);
  console.log(`    Median: ${boosts[Math.floor(boosts.length / 2)]!.toFixed(2)} dB`);
  console.log(`    Max:    ${boosts[boosts.length - 1]!.toFixed(2)} dB`);

  // Histogram of dip sizes
  console.log(`\n  Dip severity histogram:`);
  const bucketEdges = [1.5, 2, 3, 4, 6, 8, 10, 15, 20, 30];
  const counts = new Array(bucketEdges.length + 1).fill(0);
  for (const d of dips) {
    let placed = false;
    for (let b = 0; b < bucketEdges.length; b++) {
      if (d.dipDb < bucketEdges[b]!) {
        counts[b]++;
        placed = true;
        break;
      }
    }
    if (!placed) counts[bucketEdges.length]++;
  }
  const labels = bucketEdges.map((e, i) => (i === 0 ? `<${e}dB` : `${bucketEdges[i - 1]}-${e}dB`));
  labels.push(`≥${bucketEdges[bucketEdges.length - 1]}dB`);

  const maxCount = Math.max(...counts);
  for (let b = 0; b < labels.length; b++) {
    if (counts[b] === 0) continue;
    const bar = '█'.repeat(Math.max(1, Math.round((counts[b] / maxCount) * 40)));
    console.log(`    ${labels[b]!.padStart(10)}: ${bar} ${counts[b]}`);
  }

  // Show first 20 dips
  console.log(`\n  First ${Math.min(20, dips.length)} dips:`);
  console.log('  Block  | Time (ms)    | Dip (dB) | Boost (dB)');
  console.log('  ' + '-'.repeat(50));
  for (const d of dips.slice(0, 20)) {
    const timeMs = ((d.block * blockSize) / sampleRate) * 1000;
    console.log(
      `  ${String(d.block).padStart(6)} | ${timeMs.toFixed(1).padStart(12)} | ${d.dipDb.toFixed(2).padStart(8)} | ${d.boostDb.toFixed(2).padStart(10)}`,
    );
  }
}

function printSmoothnessComparison(
  original: Float32Array,
  corrected: Float32Array,
  sampleRate: number,
): void {
  let origJerkSum = 0,
    corrJerkSum = 0;
  let origDiscont = 0,
    corrDiscont = 0;
  const threshold = 0.005;

  for (let i = 2; i < original.length; i++) {
    const origD2 = Math.abs(original[i]! - 2 * original[i - 1]! + original[i - 2]!);
    const corrD2 = Math.abs(corrected[i]! - 2 * corrected[i - 1]! + corrected[i - 2]!);
    origJerkSum += origD2;
    corrJerkSum += corrD2;
    if (origD2 > threshold) origDiscont++;
    if (corrD2 > threshold) corrDiscont++;
  }

  const n = original.length - 2;
  const durationSec = n / sampleRate;
  console.log(`\n═══ Smoothness Comparison (channel 0) ═══`);
  console.log(`  Mean |2nd derivative|:`);
  console.log(`    Original:  ${(origJerkSum / n).toExponential(4)}`);
  console.log(`    Corrected: ${(corrJerkSum / n).toExponential(4)}`);
  const jerkImprove = (1 - corrJerkSum / origJerkSum) * 100;
  console.log(`    ${jerkImprove > 0 ? 'Improvement' : 'Change'}: ${jerkImprove.toFixed(1)}%`);
  console.log(`  Discontinuities (|d²| > ${threshold}):`);
  console.log(`    Original:  ${origDiscont} (${(origDiscont / durationSec).toFixed(1)}/sec)`);
  console.log(`    Corrected: ${corrDiscont} (${(corrDiscont / durationSec).toFixed(1)}/sec)`);
  if (origDiscont > 0) {
    console.log(`    Reduction: ${((1 - corrDiscont / origDiscont) * 100).toFixed(1)}%`);
  }

  // Peak amplitude consistency (CV of local maxima)
  const origPeaks: number[] = [];
  const corrPeaks: number[] = [];
  for (let i = 1; i < original.length - 1; i++) {
    if (original[i]! > original[i - 1]! && original[i]! > original[i + 1]! && original[i]! > 0.1) {
      origPeaks.push(original[i]!);
    }
    if (
      corrected[i]! > corrected[i - 1]! &&
      corrected[i]! > corrected[i + 1]! &&
      corrected[i]! > 0.1
    ) {
      corrPeaks.push(corrected[i]!);
    }
  }
  function cv(arr: number[]): number {
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const std = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length);
    return (std / mean) * 100;
  }
  if (origPeaks.length > 10 && corrPeaks.length > 10) {
    console.log(`  Peak amplitude consistency (CV):`);
    console.log(`    Original:  ${cv(origPeaks).toFixed(2)}%`);
    console.log(`    Corrected: ${cv(corrPeaks).toFixed(2)}%`);
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

const blockSize = getOpt('block', 128);
const medianHalf = getOpt('median-half', 8);
const thresholdDb = getOpt('threshold', 0.8);
const maxBoostDb = getOpt('max-boost', 12);
const silenceDbFs = getOpt('silence', -60);
const baselinePercentile = getOpt('percentile', 0.8);

if (!filePath) {
  console.error(
    'Usage: bun run tools/envelope-smooth.ts <input.wav> [--block=128] [--median-half=8] [--threshold=0.8] [--max-boost=12] [--percentile=0.8] [--silence=-60]',
  );
  process.exit(1);
}

console.log(`\nQuantum Dip Repair: ${filePath}`);
console.log(
  `  Block size:    ${blockSize} samples (${((blockSize / 48000) * 1000).toFixed(2)}ms at 48kHz)`,
);
console.log(
  `  Median window: ±${medianHalf} blocks (${2 * medianHalf + 1} blocks = ${((((2 * medianHalf + 1) * blockSize) / 48000) * 1000).toFixed(1)}ms)`,
);
console.log(`  Dip threshold: ${thresholdDb} dB below baseline`);
console.log(`  Max boost:     ${maxBoostDb} dB`);
console.log(`  Silence gate:  ${silenceDbFs} dBFS`);
console.log(`  Baseline pctl: P${(baselinePercentile * 100).toFixed(0)}`);

const buffer = readFileSync(filePath);
const wav = parseWav(buffer);

console.log(`\n  Format: ${wav.formatTag === 3 ? 'Float32' : 'Int16'} ${wav.bitsPerSample}bit`);
console.log(`  Sample rate: ${wav.sampleRate}Hz, Channels: ${wav.channels}`);
console.log(`  Duration: ${(wav.samples.length / wav.channels / wav.sampleRate).toFixed(2)}s`);

// ─── Step 1: Deinterleave channels ───────────────────────────────────────────

const channelData: Float32Array[] = [];
for (let ch = 0; ch < wav.channels; ch++) {
  channelData.push(deinterleave(wav.samples, wav.channels, ch));
}

// ─── Step 2: Block-level analysis (for diagnostics) ──────────────────────────

const channelRms: Float64Array[] = [];
for (let ch = 0; ch < wav.channels; ch++) {
  channelRms.push(computeBlockRms(channelData[ch]!, blockSize));
}
const linkedRms = wav.channels > 1 ? computeLinkedRms(channelRms) : channelRms[0]!;

const { dips } = computeGainCurve(
  linkedRms,
  medianHalf,
  thresholdDb,
  maxBoostDb,
  silenceDbFs,
  baselinePercentile,
);

printDipStats(dips, linkedRms.length, blockSize, wav.sampleRate);

// ─── Step 3: Quantum-boundary-aware declicker ─────────────────────────────────

const d2Threshold = getOpt('d2-threshold', 0.004);

console.log(`\n═══ 2nd-Derivative Declicker ═══`);

const maxRun = getOpt('max-run', 48);
const numPasses = getOpt('passes', 2);
const maxDensity = getOpt('density', 0.25);

console.log(`  d² threshold: ${d2Threshold} (adaptive: max(base, RMS*0.008))`);
console.log(`  Max run: ${maxRun} samples`);
console.log(`  Passes: ${numPasses} (pass 2+ at 60% threshold)`);
console.log(`  Max context density: ${maxDensity}`);

const durationSec = channelData[0]!.length / wav.sampleRate;

const correctedChannels: Float32Array[] = [];
let totalGlitches = 0;
let totalSamplesFixed = 0;

for (let ch = 0; ch < wav.channels; ch++) {
  const { corrected, glitchCount, samplesFixed } = declickChannel(
    channelData[ch]!,
    d2Threshold,
    maxRun,
    numPasses,
    maxDensity,
  );
  correctedChannels.push(corrected);
  totalGlitches += glitchCount;
  totalSamplesFixed += samplesFixed;
}

const avgGlitches = totalGlitches / wav.channels;
const avgSamples = totalSamplesFixed / wav.channels;
const avgRunLen = totalGlitches > 0 ? totalSamplesFixed / totalGlitches : 0;
console.log(
  `\n  Glitches found: ${avgGlitches.toFixed(0)}/ch (${(avgGlitches / durationSec).toFixed(1)}/sec)`,
);
console.log(`  Samples repaired: ${avgSamples.toFixed(0)}/ch`);
console.log(`  Average run length: ${avgRunLen.toFixed(1)} samples`);

// ─── Step 4: Envelope equalization (post-declicker) ──────────────────────────
// Now that sharp transitions are removed, we can safely apply gentle per-block
// gain correction to fix the sustained amplitude modulation (~0.9 dB dips).
// The Gaussian-smoothed gain curve won't create new discontinuities because
// the underlying signal is already smooth.

const doEnvelope = getOpt('envelope', 0) !== 0;

if (doEnvelope) {
  console.log(`\n═══ Envelope Equalization ═══`);

  for (let ch = 0; ch < wav.channels; ch++) {
    const mono = correctedChannels[ch]!;
    const numBlocks = Math.floor(mono.length / blockSize);

    // Compute per-block RMS on the declicked signal
    const rms = new Float64Array(numBlocks);
    for (let b = 0; b < numBlocks; b++) {
      let sumSq = 0;
      for (let s = 0; s < blockSize; s++) {
        const v = mono[b * blockSize + s]!;
        sumSq += v * v;
      }
      rms[b] = Math.sqrt(sumSq / blockSize);
    }

    // Compute baseline via running high percentile
    const levelDb = new Float64Array(numBlocks);
    for (let b = 0; b < numBlocks; b++) levelDb[b] = toDb(rms[b]!);
    const baseDb = runningPercentile(levelDb, medianHalf, baselinePercentile);

    // Compute per-block gain (boost only, bounded)
    const envMaxBoost = 3.0; // conservative — just fixing larger dips
    const envThreshold = 1.5; // higher threshold to skip natural RMS variation (~0.8-0.9 dB)
    const rawGain = new Float64Array(numBlocks);
    let envDips = 0;

    for (let b = 0; b < numBlocks; b++) {
      if (levelDb[b]! < silenceDbFs) continue;
      const delta = baseDb[b]! - levelDb[b]!;
      if (delta > envThreshold) {
        rawGain[b] = Math.min(delta - envThreshold * 0.3, envMaxBoost);
        if (rawGain[b]! > 0) envDips++;
      }
    }

    // Gaussian smooth the gain curve — wide kernel for ultra-smooth transitions
    const sigma = 4; // blocks
    const kHalf = Math.ceil(sigma * 3);
    const kernel = new Float64Array(2 * kHalf + 1);
    let kSum = 0;
    for (let k = 0; k < kernel.length; k++) {
      const x = k - kHalf;
      kernel[k] = Math.exp((-x * x) / (2 * sigma * sigma));
      kSum += kernel[k]!;
    }
    for (let k = 0; k < kernel.length; k++) kernel[k] /= kSum;

    const smoothGain = new Float64Array(numBlocks);
    for (let b = 0; b < numBlocks; b++) {
      let sum = 0;
      for (let k = 0; k < kernel.length; k++) {
        const j = Math.max(0, Math.min(numBlocks - 1, b + k - kHalf));
        sum += rawGain[j]! * kernel[k]!;
      }
      smoothGain[b] = sum;
    }

    // Apply smoothed gain with per-sample linear interpolation between block centers
    const halfBlock = blockSize / 2;
    for (let i = 0; i < mono.length; i++) {
      const blockFloat = (i - halfBlock) / blockSize;
      const bA = Math.max(0, Math.min(numBlocks - 1, Math.floor(blockFloat)));
      const bB = Math.min(numBlocks - 1, bA + 1);
      const frac = Math.max(0, Math.min(1, blockFloat - bA));
      const interpDb = smoothGain[bA]! * (1 - frac) + smoothGain[bB]! * frac;

      if (interpDb > 0.01) {
        const g = fromDb(interpDb);
        correctedChannels[ch]![i] = Math.max(-1, Math.min(1, mono[i]! * g));
      }
    }

    if (ch === 0) {
      console.log(
        `  Blocks with amplitude dips: ${envDips} (${(envDips / ((numBlocks * blockSize) / wav.sampleRate)).toFixed(1)}/sec)`,
      );
      console.log(`  Envelope max boost: ${envMaxBoost} dB, threshold: ${envThreshold} dB`);
      console.log(
        `  Gain smoothing: Gaussian σ=${sigma} blocks (${(((sigma * blockSize) / wav.sampleRate) * 1000).toFixed(1)}ms)`,
      );
    }
  }
}

// ─── Step 5: Diagnostics ─────────────────────────────────────────────────────

printSmoothnessComparison(channelData[0]!, correctedChannels[0]!, wav.sampleRate);

// ─── Step 6: Write outputs ───────────────────────────────────────────────────

const correctedInterleaved = interleave(correctedChannels, wav.channels);

const dir = dirname(resolve(filePath));
const base = basename(filePath, '.wav');

const outPath = resolve(dir, `${base}-repaired.wav`);
writeWavFloat32(outPath, correctedInterleaved, wav.sampleRate, wav.channels);
console.log(`\nRepaired WAV: ${outPath}`);

// Write difference signal as mono WAV for Audacity inspection
// Shows what changed: corrected - original (scaled up for visibility)
const diffSignal = new Float32Array(channelData[0]!.length);
for (let i = 0; i < diffSignal.length; i++) {
  diffSignal[i] = (correctedChannels[0]![i]! - channelData[0]![i]!) * 10;
}

const diffPath = resolve(dir, `${base}-diff.wav`);
writeWavFloat32(diffPath, diffSignal, wav.sampleRate, 1);
console.log(`Difference (10x): ${diffPath}`);

console.log('\nDone. Compare original vs repaired in Audacity.');
