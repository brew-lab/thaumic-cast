/**
 * Micro-Glitch Detector
 *
 * Compares three WAV files (bad, repaired, good) using metrics that go beyond
 * the |d2| > 0.005 threshold to detect subtle residual artifacts in repaired audio.
 *
 * Metrics computed on channel 0:
 *   a. Zero-crossing interval regularity (std dev)
 *   b. Instantaneous frequency stability (histogram)
 *   c. Peak amplitude consistency (std dev of local maxima/minima)
 *   d. Sub-threshold |d2| percentile distribution
 *   e. 3rd derivative |d3| percentile distribution
 *
 * Usage:
 *   bun run tools/detect-micro-glitches.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// WAV Parser (copied from tools/envelope-smooth.ts)
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
// Channel Helpers
// ─────────────────────────────────────────────────────────────────────────────

function deinterleave(samples: Float32Array, channels: number, ch: number): Float32Array {
  const n = Math.floor(samples.length / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = samples[i * channels + ch]!;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Percentile helper
// ─────────────────────────────────────────────────────────────────────────────

function percentile(sorted: Float64Array, p: number): number {
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * p)));
  return sorted[idx]!;
}

function sortedCopy(arr: Float64Array): Float64Array {
  const copy = new Float64Array(arr);
  copy.sort();
  return copy;
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric a: Zero-crossing interval regularity
// ─────────────────────────────────────────────────────────────────────────────

interface ZeroCrossingResult {
  count: number;
  intervals: Float64Array;
  meanInterval: number;
  stdDevInterval: number;
  expectedInterval: number;
}

function analyzeZeroCrossings(mono: Float32Array, sampleRate: number): ZeroCrossingResult {
  // For 440Hz at 48kHz, expected zero-crossing interval is sampleRate / (2 * freq)
  // = 48000 / 880 = ~54.545 samples (each half-cycle)
  // But the user says ~109 samples apart, which is full-cycle (two consecutive
  // same-direction crossings). Let's track all zero crossings.
  const crossings: number[] = [];

  for (let i = 1; i < mono.length; i++) {
    // Detect sign change (positive-going or negative-going)
    if ((mono[i - 1]! < 0 && mono[i]! >= 0) || (mono[i - 1]! >= 0 && mono[i]! < 0)) {
      // Linear interpolation for sub-sample accuracy
      const frac = Math.abs(mono[i - 1]!) / (Math.abs(mono[i - 1]!) + Math.abs(mono[i]!));
      crossings.push(i - 1 + frac);
    }
  }

  // Compute intervals between consecutive zero crossings
  const intervals = new Float64Array(crossings.length - 1);
  for (let i = 0; i < intervals.length; i++) {
    intervals[i] = crossings[i + 1]! - crossings[i]!;
  }

  // Stats
  let sum = 0;
  for (let i = 0; i < intervals.length; i++) sum += intervals[i]!;
  const mean = intervals.length > 0 ? sum / intervals.length : 0;

  let sumSqDev = 0;
  for (let i = 0; i < intervals.length; i++) {
    const d = intervals[i]! - mean;
    sumSqDev += d * d;
  }
  const stdDev = intervals.length > 1 ? Math.sqrt(sumSqDev / (intervals.length - 1)) : 0;

  // Expected: half-period of 440Hz at given sample rate
  const expectedInterval = sampleRate / (2 * 440);

  return {
    count: crossings.length,
    intervals,
    meanInterval: mean,
    stdDevInterval: stdDev,
    expectedInterval,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric b: Instantaneous frequency stability
// ─────────────────────────────────────────────────────────────────────────────

interface FrequencyResult {
  frequencies: Float64Array;
  mean: number;
  stdDev: number;
  histogram: Map<number, number>; // bin center -> count
}

function analyzeInstantaneousFrequency(mono: Float32Array, sampleRate: number): FrequencyResult {
  // Find positive-going zero crossings for full-cycle measurement
  const posCrossings: number[] = [];
  for (let i = 1; i < mono.length; i++) {
    if (mono[i - 1]! < 0 && mono[i]! >= 0) {
      const frac = Math.abs(mono[i - 1]!) / (Math.abs(mono[i - 1]!) + Math.abs(mono[i]!));
      posCrossings.push(i - 1 + frac);
    }
  }

  // Instantaneous frequency from consecutive positive-going crossings
  const frequencies = new Float64Array(posCrossings.length - 1);
  for (let i = 0; i < frequencies.length; i++) {
    const period = posCrossings[i + 1]! - posCrossings[i]!;
    frequencies[i] = sampleRate / period;
  }

  // Stats
  let sum = 0;
  for (let i = 0; i < frequencies.length; i++) sum += frequencies[i]!;
  const mean = frequencies.length > 0 ? sum / frequencies.length : 0;

  let sumSqDev = 0;
  for (let i = 0; i < frequencies.length; i++) {
    const d = frequencies[i]! - mean;
    sumSqDev += d * d;
  }
  const stdDev = frequencies.length > 1 ? Math.sqrt(sumSqDev / (frequencies.length - 1)) : 0;

  // Histogram with 0.5Hz bins from 420 to 460 Hz
  const histogram = new Map<number, number>();
  const binWidth = 0.5;
  const binMin = 420;
  const binMax = 460;
  for (let b = binMin; b < binMax; b += binWidth) {
    histogram.set(b + binWidth / 2, 0);
  }
  // Outlier bins
  let belowCount = 0;
  let aboveCount = 0;

  for (let i = 0; i < frequencies.length; i++) {
    const f = frequencies[i]!;
    if (f < binMin) {
      belowCount++;
    } else if (f >= binMax) {
      aboveCount++;
    } else {
      const bin = Math.floor((f - binMin) / binWidth) * binWidth + binMin + binWidth / 2;
      histogram.set(bin, (histogram.get(bin) ?? 0) + 1);
    }
  }

  return { frequencies, mean, stdDev, histogram };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric c: Peak amplitude consistency
// ─────────────────────────────────────────────────────────────────────────────

interface PeakResult {
  maxima: Float64Array;
  minima: Float64Array;
  maximaMean: number;
  maximaStdDev: number;
  minimaMean: number;
  minimaStdDev: number;
}

function analyzePeakAmplitudes(mono: Float32Array): PeakResult {
  const maxima: number[] = [];
  const minima: number[] = [];

  // Find local maxima and minima (simple 3-point test)
  for (let i = 1; i < mono.length - 1; i++) {
    const prev = mono[i - 1]!;
    const curr = mono[i]!;
    const next = mono[i + 1]!;

    if (curr > prev && curr > next && curr > 0.01) {
      maxima.push(curr);
    } else if (curr < prev && curr < next && curr < -0.01) {
      minima.push(curr);
    }
  }

  const computeStats = (values: number[]) => {
    if (values.length === 0) return { mean: 0, stdDev: 0 };
    let sum = 0;
    for (const v of values) sum += v;
    const mean = sum / values.length;
    let sumSq = 0;
    for (const v of values) sumSq += (v - mean) ** 2;
    return { mean, stdDev: Math.sqrt(sumSq / (values.length - 1)) };
  };

  const maxStats = computeStats(maxima);
  const minStats = computeStats(minima);

  return {
    maxima: Float64Array.from(maxima),
    minima: Float64Array.from(minima),
    maximaMean: maxStats.mean,
    maximaStdDev: maxStats.stdDev,
    minimaMean: minStats.mean,
    minimaStdDev: minStats.stdDev,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric d: Sub-threshold |d2| distribution
// ─────────────────────────────────────────────────────────────────────────────

interface DerivativeDistribution {
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  p999: number;
  max: number;
  aboveThreshold: number;
}

function analyzeD2Distribution(mono: Float32Array): DerivativeDistribution {
  const n = mono.length;
  const d2 = new Float64Array(n - 2);
  for (let i = 2; i < n; i++) {
    d2[i - 2] = Math.abs(mono[i]! - 2 * mono[i - 1]! + mono[i - 2]!);
  }

  const sorted = sortedCopy(d2);

  let aboveThreshold = 0;
  for (let i = 0; i < d2.length; i++) {
    if (d2[i]! > 0.005) aboveThreshold++;
  }

  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    p999: percentile(sorted, 0.999),
    max: sorted[sorted.length - 1]!,
    aboveThreshold,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Metric e: 3rd derivative |d3| distribution
// ─────────────────────────────────────────────────────────────────────────────

function analyzeD3Distribution(mono: Float32Array): DerivativeDistribution {
  const n = mono.length;
  const d3 = new Float64Array(n - 3);
  for (let i = 3; i < n; i++) {
    d3[i - 3] = Math.abs(mono[i]! - 3 * mono[i - 1]! + 3 * mono[i - 2]! - mono[i - 3]!);
  }

  const sorted = sortedCopy(d3);

  let aboveThreshold = 0;
  for (let i = 0; i < d3.length; i++) {
    if (d3[i]! > 0.005) aboveThreshold++;
  }

  return {
    p50: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    p999: percentile(sorted, 0.999),
    max: sorted[sorted.length - 1]!,
    aboveThreshold,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

function printDerivativeTable(
  label: string,
  bad: DerivativeDistribution,
  repaired: DerivativeDistribution,
  good: DerivativeDistribution,
): void {
  console.log(`\n  ${label}:`);
  console.log(
    '  ' +
      'Percentile'.padEnd(12) +
      'Bad'.padStart(14) +
      'Repaired'.padStart(14) +
      'Good'.padStart(14) +
      '  Rep/Good Ratio'.padStart(16),
  );
  console.log('  ' + '-'.repeat(70));

  const rows: [string, number, number, number][] = [
    ['P50', bad.p50, repaired.p50, good.p50],
    ['P90', bad.p90, repaired.p90, good.p90],
    ['P95', bad.p95, repaired.p95, good.p95],
    ['P99', bad.p99, repaired.p99, good.p99],
    ['P99.9', bad.p999, repaired.p999, good.p999],
    ['Max', bad.max, repaired.max, good.max],
  ];

  for (const [name, bv, rv, gv] of rows) {
    const ratio = gv > 0 ? (rv / gv).toFixed(3) : 'N/A';
    console.log(
      '  ' +
        name.padEnd(12) +
        bv.toExponential(4).padStart(14) +
        rv.toExponential(4).padStart(14) +
        gv.toExponential(4).padStart(14) +
        String(ratio).padStart(16),
    );
  }

  console.log(
    '  ' +
      '> 0.005'.padEnd(12) +
      String(bad.aboveThreshold).padStart(14) +
      String(repaired.aboveThreshold).padStart(14) +
      String(good.aboveThreshold).padStart(14),
  );
}

function printFreqHistogram(label: string, freq: FrequencyResult, maxBarWidth: number = 50): void {
  // Find non-zero bins
  const nonZeroBins: [number, number][] = [];
  for (const [bin, count] of freq.histogram) {
    if (count > 0) nonZeroBins.push([bin, count]);
  }
  nonZeroBins.sort((a, b) => a[0] - b[0]);

  if (nonZeroBins.length === 0) return;

  const maxCount = Math.max(...nonZeroBins.map(([, c]) => c));

  console.log(`\n  ${label} (mean=${freq.mean.toFixed(2)}Hz, std=${freq.stdDev.toFixed(4)}Hz):`);
  for (const [bin, count] of nonZeroBins) {
    const barLen = Math.max(1, Math.round((count / maxCount) * maxBarWidth));
    const bar = '#'.repeat(barLen);
    console.log(`    ${bin.toFixed(1).padStart(7)}Hz: ${bar} ${count}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const toolsDir = resolve(import.meta.dir ?? __dirname);

const files = {
  bad: resolve(toolsDir, 'pcm-capture-float32-input-bad.wav'),
  repaired: resolve(toolsDir, 'pcm-capture-float32-input-bad-repaired.wav'),
  good: resolve(toolsDir, 'pcm-capture-float32-input-good.wav'),
};

console.log('=== Micro-Glitch Detection Report ===\n');
console.log('Loading WAV files...');

const wavs: Record<string, WavData> = {};
const ch0: Record<string, Float32Array> = {};

for (const [name, path] of Object.entries(files)) {
  const buf = readFileSync(path);
  wavs[name] = parseWav(buf);
  ch0[name] = deinterleave(wavs[name]!.samples, wavs[name]!.channels, 0);
  const dur = (ch0[name]!.length / wavs[name]!.sampleRate).toFixed(2);
  console.log(`  ${name.padEnd(10)}: ${path}`);
  console.log(
    `             ${wavs[name]!.sampleRate}Hz, ${wavs[name]!.channels}ch, ${ch0[name]!.length} samples (${dur}s)`,
  );
}

const sampleRate = wavs['good']!.sampleRate;

// ─── Metric a: Zero-crossing regularity ──────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('(a) ZERO-CROSSING INTERVAL REGULARITY');
console.log('='.repeat(70));
console.log(
  `\nExpected half-period for 440Hz at ${sampleRate}Hz: ${(sampleRate / (2 * 440)).toFixed(3)} samples`,
);

for (const name of ['bad', 'repaired', 'good']) {
  const zc = analyzeZeroCrossings(ch0[name]!, sampleRate);
  console.log(`\n  ${name.toUpperCase()}:`);
  console.log(`    Zero crossings:    ${zc.count}`);
  console.log(`    Mean interval:     ${zc.meanInterval.toFixed(4)} samples`);
  console.log(`    Std dev interval:  ${zc.stdDevInterval.toFixed(6)} samples`);
  console.log(`    Expected interval: ${zc.expectedInterval.toFixed(4)} samples`);
  console.log(
    `    Mean error:        ${Math.abs(zc.meanInterval - zc.expectedInterval).toFixed(6)} samples`,
  );
}

// ─── Metric b: Instantaneous frequency stability ─────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('(b) INSTANTANEOUS FREQUENCY STABILITY');
console.log('='.repeat(70));

for (const name of ['bad', 'repaired', 'good']) {
  const freq = analyzeInstantaneousFrequency(ch0[name]!, sampleRate);
  printFreqHistogram(`${name.toUpperCase()}`, freq);
}

// ─── Metric c: Peak amplitude consistency ────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('(c) PEAK AMPLITUDE CONSISTENCY');
console.log('='.repeat(70));

console.log(
  '\n  ' +
    'File'.padEnd(12) +
    'Peaks'.padStart(8) +
    'Mean'.padStart(12) +
    'StdDev'.padStart(12) +
    'CV%'.padStart(10),
);
console.log('  ' + '-'.repeat(54));

for (const name of ['bad', 'repaired', 'good']) {
  const peaks = analyzePeakAmplitudes(ch0[name]!);
  const cv = peaks.maximaMean !== 0 ? (peaks.maximaStdDev / peaks.maximaMean) * 100 : 0;
  console.log(
    '  ' +
      `${name} max`.padEnd(12) +
      String(peaks.maxima.length).padStart(8) +
      peaks.maximaMean.toFixed(6).padStart(12) +
      peaks.maximaStdDev.toExponential(3).padStart(12) +
      cv.toFixed(4).padStart(10),
  );
  const cvMin =
    peaks.minimaMean !== 0 ? (peaks.minimaStdDev / Math.abs(peaks.minimaMean)) * 100 : 0;
  console.log(
    '  ' +
      `${name} min`.padEnd(12) +
      String(peaks.minima.length).padStart(8) +
      peaks.minimaMean.toFixed(6).padStart(12) +
      peaks.minimaStdDev.toExponential(3).padStart(12) +
      cvMin.toFixed(4).padStart(10),
  );
}

// ─── Metric d: Sub-threshold |d2| analysis ───────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('(d) SUB-THRESHOLD |d2| DISTRIBUTION');
console.log('='.repeat(70));

const d2Bad = analyzeD2Distribution(ch0['bad']!);
const d2Repaired = analyzeD2Distribution(ch0['repaired']!);
const d2Good = analyzeD2Distribution(ch0['good']!);

printDerivativeTable('|d2| = |s[i] - 2*s[i-1] + s[i-2]|', d2Bad, d2Repaired, d2Good);

// ─── Metric e: 3rd derivative |d3| analysis ──────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('(e) 3RD DERIVATIVE |d3| DISTRIBUTION');
console.log('='.repeat(70));

const d3Bad = analyzeD3Distribution(ch0['bad']!);
const d3Repaired = analyzeD3Distribution(ch0['repaired']!);
const d3Good = analyzeD3Distribution(ch0['good']!);

printDerivativeTable('|d3| = |s[i] - 3*s[i-1] + 3*s[i-2] - s[i-3]|', d3Bad, d3Repaired, d3Good);

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(70));
console.log('SUMMARY');
console.log('='.repeat(70));

const zcBad = analyzeZeroCrossings(ch0['bad']!, sampleRate);
const zcRepaired = analyzeZeroCrossings(ch0['repaired']!, sampleRate);
const zcGood = analyzeZeroCrossings(ch0['good']!, sampleRate);

const freqBad = analyzeInstantaneousFrequency(ch0['bad']!, sampleRate);
const freqRepaired = analyzeInstantaneousFrequency(ch0['repaired']!, sampleRate);
const freqGood = analyzeInstantaneousFrequency(ch0['good']!, sampleRate);

const peakBad = analyzePeakAmplitudes(ch0['bad']!);
const peakRepaired = analyzePeakAmplitudes(ch0['repaired']!);
const peakGood = analyzePeakAmplitudes(ch0['good']!);

console.log(
  '\n  Metric                          Bad        Repaired       Good     Rep closer to Good?',
);
console.log('  ' + '-'.repeat(85));

// ZC std dev
const zcBadDist = Math.abs(zcBad.stdDevInterval - zcGood.stdDevInterval);
const zcRepDist = Math.abs(zcRepaired.stdDevInterval - zcGood.stdDevInterval);
console.log(
  '  ' +
    'ZC interval std dev'.padEnd(32) +
    zcBad.stdDevInterval.toFixed(6).padStart(10) +
    zcRepaired.stdDevInterval.toFixed(6).padStart(14) +
    zcGood.stdDevInterval.toFixed(6).padStart(11) +
    (zcRepDist < zcBadDist ? '  YES' : '  NO').padStart(18),
);

// Freq std dev
const fBadDist = Math.abs(freqBad.stdDev - freqGood.stdDev);
const fRepDist = Math.abs(freqRepaired.stdDev - freqGood.stdDev);
console.log(
  '  ' +
    'Inst. freq std dev (Hz)'.padEnd(32) +
    freqBad.stdDev.toFixed(4).padStart(10) +
    freqRepaired.stdDev.toFixed(4).padStart(14) +
    freqGood.stdDev.toFixed(4).padStart(11) +
    (fRepDist < fBadDist ? '  YES' : '  NO').padStart(18),
);

// Peak amplitude CV (maxima)
const cvBad = peakBad.maximaMean !== 0 ? peakBad.maximaStdDev / peakBad.maximaMean : 0;
const cvRep =
  peakRepaired.maximaMean !== 0 ? peakRepaired.maximaStdDev / peakRepaired.maximaMean : 0;
const cvGood = peakGood.maximaMean !== 0 ? peakGood.maximaStdDev / peakGood.maximaMean : 0;
const cvBadDist = Math.abs(cvBad - cvGood);
const cvRepDist = Math.abs(cvRep - cvGood);
console.log(
  '  ' +
    'Peak amplitude CV'.padEnd(32) +
    (cvBad * 100).toFixed(4).padStart(10) +
    (cvRep * 100).toFixed(4).padStart(14) +
    (cvGood * 100).toFixed(4).padStart(11) +
    (cvRepDist < cvBadDist ? '  YES' : '  NO').padStart(18),
);

// d2 P99.9
const d2BadDist = Math.abs(d2Bad.p999 - d2Good.p999);
const d2RepDist = Math.abs(d2Repaired.p999 - d2Good.p999);
console.log(
  '  ' +
    '|d2| P99.9'.padEnd(32) +
    d2Bad.p999.toExponential(3).padStart(10) +
    d2Repaired.p999.toExponential(3).padStart(14) +
    d2Good.p999.toExponential(3).padStart(11) +
    (d2RepDist < d2BadDist ? '  YES' : '  NO').padStart(18),
);

// d3 P99.9
const d3BadDist = Math.abs(d3Bad.p999 - d3Good.p999);
const d3RepDist = Math.abs(d3Repaired.p999 - d3Good.p999);
console.log(
  '  ' +
    '|d3| P99.9'.padEnd(32) +
    d3Bad.p999.toExponential(3).padStart(10) +
    d3Repaired.p999.toExponential(3).padStart(14) +
    d3Good.p999.toExponential(3).padStart(11) +
    (d3RepDist < d3BadDist ? '  YES' : '  NO').padStart(18),
);

// d2 samples above threshold
console.log(
  '  ' +
    '|d2| > 0.005 count'.padEnd(32) +
    String(d2Bad.aboveThreshold).padStart(10) +
    String(d2Repaired.aboveThreshold).padStart(14) +
    String(d2Good.aboveThreshold).padStart(11) +
    (d2Repaired.aboveThreshold <= d2Good.aboveThreshold ? '  YES' : '  NO').padStart(18),
);

// d3 samples above threshold
console.log(
  '  ' +
    '|d3| > 0.005 count'.padEnd(32) +
    String(d3Bad.aboveThreshold).padStart(10) +
    String(d3Repaired.aboveThreshold).padStart(14) +
    String(d3Good.aboveThreshold).padStart(11) +
    (d3Repaired.aboveThreshold <= d3Good.aboveThreshold ? '  YES' : '  NO').padStart(18),
);

console.log('\nDone.');
