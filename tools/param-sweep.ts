/**
 * Parameter sweep for the 2nd-derivative declicker.
 *
 * Tests combinations of d2-threshold, passes, and adaptive multiplier
 * on both the BAD file (to measure effectiveness) and the GOOD file
 * (to measure false positives). Prints a ranked summary.
 *
 * Usage:
 *   bun run tools/param-sweep.ts
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
// Declicker core (copied from envelope-smooth.ts, with configurable adaptive multiplier)
// ─────────────────────────────────────────────────────────────────────────────

function hermite(t: number, v0: number, v1: number, m0: number, m1: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1
  );
}

function declickPass(
  mono: Float32Array,
  baseD2Threshold: number,
  maxRunLength: number,
  adaptiveMult: number,
): { corrected: Float32Array; glitchCount: number; samplesFixed: number } {
  const n = mono.length;
  const corrected = new Float32Array(mono);

  const d2 = new Float64Array(n);
  for (let i = 2; i < n; i++) {
    d2[i] = Math.abs(mono[i]! - 2 * mono[i - 1]! + mono[i - 2]!);
  }

  const rmsHalf = 64;
  const localRms = new Float64Array(n);
  const cumSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumSq[i + 1] = cumSq[i]! + mono[i]! * mono[i]!;
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - rmsHalf);
    const hi = Math.min(n, i + rmsHalf);
    localRms[i] = Math.sqrt((cumSq[hi]! - cumSq[lo]!) / (hi - lo));
  }

  let glitchCount = 0;
  let samplesFixed = 0;
  const anchorMargin = 3;
  let i = anchorMargin;

  while (i < n - anchorMargin) {
    const adaptiveThreshold = Math.max(baseD2Threshold, localRms[i]! * adaptiveMult);

    if (d2[i]! <= adaptiveThreshold) {
      i++;
      continue;
    }

    const glitchStart = Math.max(anchorMargin, i - 2);
    let j = i + 1;
    while (j < n - anchorMargin && j - glitchStart < maxRunLength) {
      const thr = Math.max(baseD2Threshold, localRms[j]! * adaptiveMult);
      if (d2[j]! <= thr && d2[Math.min(n - 1, j + 1)]! <= thr && d2[Math.min(n - 1, j + 2)]! <= thr)
        break;
      j++;
    }

    const glitchEnd = Math.min(n - anchorMargin, j + 1);
    const runLen = glitchEnd - glitchStart;

    if (
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
        const d0 = (mono[a0]! - mono[a0 - 2]!) * 0.5;
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

function declickChannel(
  mono: Float32Array,
  baseD2Threshold: number,
  maxRunLength: number,
  passes: number,
  adaptiveMult: number,
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
      adaptiveMult,
    );
    current = corrected;
    totalGlitchCount += glitchCount;
    totalSamplesFixed += samplesFixed;
  }

  return { corrected: current, glitchCount: totalGlitchCount, samplesFixed: totalSamplesFixed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metrics
// ─────────────────────────────────────────────────────────────────────────────

interface Metrics {
  remainingDiscontinuities: number;
  meanD2: number;
  samplesReplaced: number;
  glitchCount: number;
}

/** Measure the quality of a declicked signal against a fixed |d2| > 0.005 threshold. */
function measure(original: Float32Array, corrected: Float32Array): Metrics {
  const n = corrected.length;
  let d2Sum = 0;
  let discont = 0;
  const discThreshold = 0.005;

  for (let i = 2; i < n; i++) {
    const d2 = Math.abs(corrected[i]! - 2 * corrected[i - 1]! + corrected[i - 2]!);
    d2Sum += d2;
    if (d2 > discThreshold) discont++;
  }

  // Count samples that differ
  let replaced = 0;
  for (let i = 0; i < n; i++) {
    if (corrected[i] !== original[i]) replaced++;
  }

  return {
    remainingDiscontinuities: discont,
    meanD2: d2Sum / (n - 2),
    samplesReplaced: replaced,
    glitchCount: 0, // filled in by caller
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sweep
// ─────────────────────────────────────────────────────────────────────────────

const BAD_FILE = '/home/skezo/projects/thaumic-cast/tools/pcm-capture-float32-input-bad.wav';
const GOOD_FILE = '/home/skezo/projects/thaumic-cast/tools/pcm-capture-float32-input-good.wav';

const d2Thresholds = [0.003, 0.004, 0.005, 0.006, 0.007];
const passesValues = [1, 2, 3];
const adaptiveMultipliers = [0.005, 0.008, 0.01, 0.015];

console.log('Loading WAV files...');
const badWav = parseWav(readFileSync(BAD_FILE));
const goodWav = parseWav(readFileSync(GOOD_FILE));

const badCh0 = deinterleave(badWav.samples, badWav.channels, 0);
const goodCh0 = deinterleave(goodWav.samples, goodWav.channels, 0);

// Baseline metrics (no processing)
const badBaseline = measure(badCh0, badCh0);
const goodBaseline = measure(goodCh0, goodCh0);

console.log(`\nBaseline (no processing):`);
console.log(
  `  BAD  file: ${badBaseline.remainingDiscontinuities} discontinuities, mean|d2|=${badBaseline.meanD2.toExponential(4)}`,
);
console.log(
  `  GOOD file: ${goodBaseline.remainingDiscontinuities} discontinuities, mean|d2|=${goodBaseline.meanD2.toExponential(4)}`,
);

const totalCombos = d2Thresholds.length * passesValues.length * adaptiveMultipliers.length;
console.log(`\nRunning ${totalCombos} parameter combinations...`);

interface Result {
  d2Threshold: number;
  passes: number;
  adaptiveMult: number;
  bad: Metrics;
  good: Metrics;
}

const results: Result[] = [];
const maxRun = 64; // fixed
let done = 0;

for (const d2t of d2Thresholds) {
  for (const passes of passesValues) {
    for (const aMult of adaptiveMultipliers) {
      // Process BAD file
      const badResult = declickChannel(badCh0, d2t, maxRun, passes, aMult);
      const badMetrics = measure(badCh0, badResult.corrected);
      badMetrics.glitchCount = badResult.glitchCount;

      // Process GOOD file
      const goodResult = declickChannel(goodCh0, d2t, maxRun, passes, aMult);
      const goodMetrics = measure(goodCh0, goodResult.corrected);
      goodMetrics.glitchCount = goodResult.glitchCount;

      results.push({
        d2Threshold: d2t,
        passes,
        adaptiveMult: aMult,
        bad: badMetrics,
        good: goodMetrics,
      });

      done++;
      if (done % 10 === 0 || done === totalCombos) {
        process.stdout.write(`  ${done}/${totalCombos}\r`);
      }
    }
  }
}

console.log(`\nDone.\n`);

// ─────────────────────────────────────────────────────────────────────────────
// Results table
// ─────────────────────────────────────────────────────────────────────────────

// Sort by: fewest BAD discontinuities, then fewest GOOD false positives, then fewest samples replaced
results.sort((a, b) => {
  if (a.bad.remainingDiscontinuities !== b.bad.remainingDiscontinuities)
    return a.bad.remainingDiscontinuities - b.bad.remainingDiscontinuities;
  if (a.good.samplesReplaced !== b.good.samplesReplaced)
    return a.good.samplesReplaced - b.good.samplesReplaced;
  return a.bad.samplesReplaced - b.bad.samplesReplaced;
});

const hdr = [
  'Rank',
  'd2-thresh',
  'passes',
  'adapt-mult',
  'BAD discont',
  'BAD mean|d2|',
  'BAD replaced',
  'GOOD FP (replaced)',
  'GOOD discont',
]
  .map((h, i) => h.padStart(i === 0 ? 4 : i <= 3 ? 10 : 18))
  .join(' | ');

console.log('='.repeat(hdr.length));
console.log(
  'PARAMETER SWEEP RESULTS (sorted: fewest BAD discontinuities, fewest GOOD false positives, fewest BAD samples replaced)',
);
console.log('='.repeat(hdr.length));
console.log(hdr);
console.log('-'.repeat(hdr.length));

for (let i = 0; i < results.length; i++) {
  const r = results[i]!;
  const row = [
    String(i + 1).padStart(4),
    r.d2Threshold.toFixed(3).padStart(10),
    String(r.passes).padStart(10),
    r.adaptiveMult.toFixed(3).padStart(10),
    String(r.bad.remainingDiscontinuities).padStart(18),
    r.bad.meanD2.toExponential(4).padStart(18),
    String(r.bad.samplesReplaced).padStart(18),
    String(r.good.samplesReplaced).padStart(18),
    String(r.good.remainingDiscontinuities).padStart(18),
  ].join(' | ');
  console.log(row);
}

console.log('='.repeat(hdr.length));

// ─────────────────────────────────────────────────────────────────────────────
// Top picks
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n--- TOP 5 OVERALL ---');
for (let i = 0; i < Math.min(5, results.length); i++) {
  const r = results[i]!;
  console.log(
    `  #${i + 1}: d2-threshold=${r.d2Threshold}, passes=${r.passes}, adaptive-mult=${r.adaptiveMult}`,
  );
  console.log(
    `       BAD:  ${r.bad.remainingDiscontinuities} discont, ${r.bad.samplesReplaced} replaced, mean|d2|=${r.bad.meanD2.toExponential(4)}`,
  );
  console.log(
    `       GOOD: ${r.good.samplesReplaced} false-positive samples, ${r.good.remainingDiscontinuities} discont`,
  );
}

// Also find the best combo that has ZERO false positives on good file
const zeroFP = results.filter((r) => r.good.samplesReplaced === 0);
if (zeroFP.length > 0) {
  console.log('\n--- BEST WITH ZERO FALSE POSITIVES ON GOOD FILE ---');
  for (let i = 0; i < Math.min(3, zeroFP.length); i++) {
    const r = zeroFP[i]!;
    console.log(
      `  #${i + 1}: d2-threshold=${r.d2Threshold}, passes=${r.passes}, adaptive-mult=${r.adaptiveMult}`,
    );
    console.log(
      `       BAD:  ${r.bad.remainingDiscontinuities} discont, ${r.bad.samplesReplaced} replaced, mean|d2|=${r.bad.meanD2.toExponential(4)}`,
    );
  }
} else {
  console.log('\n  (No combo had zero false positives on good file)');
  // Show lowest FP combos
  const byFP = [...results].sort((a, b) => a.good.samplesReplaced - b.good.samplesReplaced);
  console.log('\n--- LOWEST FALSE POSITIVES ON GOOD FILE ---');
  for (let i = 0; i < Math.min(3, byFP.length); i++) {
    const r = byFP[i]!;
    console.log(
      `  #${i + 1}: d2-threshold=${r.d2Threshold}, passes=${r.passes}, adaptive-mult=${r.adaptiveMult}`,
    );
    console.log(
      `       GOOD: ${r.good.samplesReplaced} FP samples, ${r.good.remainingDiscontinuities} discont`,
    );
    console.log(
      `       BAD:  ${r.bad.remainingDiscontinuities} discont, ${r.bad.samplesReplaced} replaced`,
    );
  }
}
