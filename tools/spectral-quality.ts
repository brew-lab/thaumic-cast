/**
 * Spectral Quality Analysis — Compares original bad, repaired, and good WAV files.
 *
 * Measures:
 *   - THD (Total Harmonic Distortion) at 880, 1320, 1760, 2200 Hz vs 440 Hz fundamental
 *   - Noise floor: average energy in non-harmonic bins
 *   - SNR: fundamental energy vs everything else
 *   - Spectral convergence: how close repaired is to good
 *
 * Test signal: 440 Hz sine wave, 48 kHz, stereo (analysis on channel 0).
 *
 * Usage:
 *   bun run tools/spectral-quality.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

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
// Channel Helpers
// ─────────────────────────────────────────────────────────────────────────────

function deinterleave(samples: Float32Array, channels: number, ch: number): Float32Array {
  const n = Math.floor(samples.length / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = samples[i * channels + ch]!;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Goertzel Algorithm — efficient single-frequency DFT bin
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the power (magnitude squared) at a specific frequency using the Goertzel algorithm.
 * Returns the power normalized by N^2 (so it's comparable across different N).
 */
function goertzelPower(signal: Float32Array, sampleRate: number, targetFreq: number): number {
  const N = signal.length;
  const k = Math.round((targetFreq * N) / sampleRate);
  const w = (2 * Math.PI * k) / N;
  const coeff = 2 * Math.cos(w);

  let s0 = 0;
  let s1 = 0;
  let s2 = 0;

  for (let i = 0; i < N; i++) {
    s0 = signal[i]! + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }

  // Power = |X[k]|^2 / N^2
  const power = (s1 * s1 + s2 * s2 - coeff * s1 * s2) / (N * N);
  return power;
}

/**
 * Computes the actual resolved frequency for a Goertzel bin.
 */
function resolvedFreq(sampleRate: number, N: number, targetFreq: number): number {
  const k = Math.round((targetFreq * N) / sampleRate);
  return (k * sampleRate) / N;
}

// ─────────────────────────────────────────────────────────────────────────────
// Full DFT for noise floor measurement
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Computes the full power spectrum using a real DFT via FFT-like approach.
 * For noise floor we need all bins, so we use a full transform.
 * We use a radix-2 FFT for efficiency. Signal is zero-padded to next power of 2.
 */
function computePowerSpectrum(signal: Float32Array): { powers: Float64Array; N: number } {
  // Zero-pad to next power of 2
  let N = 1;
  while (N < signal.length) N <<= 1;

  const real = new Float64Array(N);
  const imag = new Float64Array(N);
  for (let i = 0; i < signal.length; i++) real[i] = signal[i]!;

  // Apply Hann window to reduce spectral leakage
  for (let i = 0; i < signal.length; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (signal.length - 1)));
    real[i] *= w;
  }

  // In-place FFT (Cooley-Tukey radix-2 DIT)
  fftInPlace(real, imag, N);

  // Compute power spectrum (only need first N/2 + 1 bins)
  const numBins = N / 2 + 1;
  const powers = new Float64Array(numBins);
  for (let i = 0; i < numBins; i++) {
    powers[i] = (real[i]! * real[i]! + imag[i]! * imag[i]!) / (N * N);
  }

  return { powers, N };
}

/**
 * Radix-2 decimation-in-time FFT, in-place.
 */
function fftInPlace(real: Float64Array, imag: Float64Array, N: number): void {
  // Bit-reversal permutation
  let j = 0;
  for (let i = 0; i < N - 1; i++) {
    if (i < j) {
      [real[i], real[j]] = [real[j]!, real[i]!];
      [imag[i], imag[j]] = [imag[j]!, imag[i]!];
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }

  // Butterfly stages
  for (let step = 2; step <= N; step <<= 1) {
    const halfStep = step >> 1;
    const angle = (-2 * Math.PI) / step;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);

    for (let group = 0; group < N; group += step) {
      let twReal = 1;
      let twImag = 0;

      for (let pair = 0; pair < halfStep; pair++) {
        const even = group + pair;
        const odd = even + halfStep;

        const tReal = twReal * real[odd]! - twImag * imag[odd]!;
        const tImag = twReal * imag[odd]! + twImag * real[odd]!;

        real[odd] = real[even]! - tReal;
        imag[odd] = imag[even]! - tImag;
        real[even] = real[even]! + tReal;
        imag[even] = imag[even]! + tImag;

        const newTwReal = twReal * wReal - twImag * wImag;
        twImag = twReal * wImag + twImag * wReal;
        twReal = newTwReal;
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis Functions
// ─────────────────────────────────────────────────────────────────────────────

interface SpectralMetrics {
  label: string;
  fundamentalPowerDb: number;
  harmonicPowers: { freq: number; powerDb: number; resolvedHz: number }[];
  thdPercent: number;
  thdDb: number;
  noiseFloorDb: number;
  snrDb: number;
  totalNonFundamentalPowerDb: number;
}

const FUNDAMENTAL = 440;
const HARMONICS = [880, 1320, 1760, 2200]; // H2 through H5
const HARMONIC_GUARD_HZ = 20; // +/- guard band around each harmonic for noise exclusion

function analyzeSpectral(mono: Float32Array, sampleRate: number, label: string): SpectralMetrics {
  const N = mono.length;

  // --- Goertzel for fundamental and harmonics ---
  const fundPower = goertzelPower(mono, sampleRate, FUNDAMENTAL);
  const fundPowerDb = 10 * Math.log10(fundPower + 1e-20);
  const fundResolved = resolvedFreq(sampleRate, N, FUNDAMENTAL);

  const harmonicPowers = HARMONICS.map((freq) => {
    const power = goertzelPower(mono, sampleRate, freq);
    return {
      freq,
      powerDb: 10 * Math.log10(power + 1e-20),
      resolvedHz: resolvedFreq(sampleRate, N, freq),
    };
  });

  // THD = sqrt(sum of harmonic powers) / fundamental amplitude
  const harmonicPowerSum = HARMONICS.reduce(
    (sum, freq) => sum + goertzelPower(mono, sampleRate, freq),
    0,
  );
  const thdLinear = Math.sqrt(harmonicPowerSum) / Math.sqrt(fundPower + 1e-20);
  const thdPercent = thdLinear * 100;
  const thdDb = 20 * Math.log10(thdLinear + 1e-20);

  // --- Full FFT for noise floor and SNR ---
  const { powers, N: fftN } = computePowerSpectrum(mono);
  const binHz = sampleRate / fftN;

  // Identify harmonic bins to exclude (fundamental + harmonics + guard band)
  const allHarmonicFreqs = [FUNDAMENTAL, ...HARMONICS];
  const harmonicBins = new Set<number>();
  for (const freq of allHarmonicFreqs) {
    const centerBin = Math.round(freq / binHz);
    const guardBins = Math.ceil(HARMONIC_GUARD_HZ / binHz);
    for (let b = centerBin - guardBins; b <= centerBin + guardBins; b++) {
      if (b >= 0 && b < powers.length) harmonicBins.add(b);
    }
  }

  // Noise floor: average power of non-harmonic bins (skip DC and very low freq)
  const minBin = Math.ceil(50 / binHz); // skip below 50 Hz
  const maxBin = Math.floor(20000 / binHz); // up to 20 kHz
  let noiseSum = 0;
  let noiseBinCount = 0;
  let totalNonFundPower = 0;

  const fundCenterBin = Math.round(FUNDAMENTAL / binHz);
  const fundGuard = Math.ceil(HARMONIC_GUARD_HZ / binHz);

  for (let b = minBin; b <= Math.min(maxBin, powers.length - 1); b++) {
    const isFundamental = b >= fundCenterBin - fundGuard && b <= fundCenterBin + fundGuard;

    if (!isFundamental) {
      totalNonFundPower += powers[b]!;
    }

    if (!harmonicBins.has(b)) {
      noiseSum += powers[b]!;
      noiseBinCount++;
    }
  }

  const avgNoisePower = noiseBinCount > 0 ? noiseSum / noiseBinCount : 1e-20;
  const noiseFloorDb = 10 * Math.log10(avgNoisePower + 1e-20);

  // SNR: fundamental power (from Goertzel, more accurate) vs total non-fundamental
  // Scale FFT fundamental to match Goertzel (windowing affects levels)
  const snrDb = 10 * Math.log10(fundPower / (totalNonFundPower + 1e-20));

  return {
    label,
    fundamentalPowerDb: fundPowerDb,
    harmonicPowers,
    thdPercent,
    thdDb,
    noiseFloorDb,
    snrDb,
    totalNonFundamentalPowerDb: 10 * Math.log10(totalNonFundPower + 1e-20),
  };
}

/**
 * Computes spectral difference between two signals using their FFT power spectra.
 * Returns the RMS difference in dB across all bins.
 */
function spectralDifference(
  a: Float32Array,
  b: Float32Array,
  sampleRate: number,
): { rmsDbDiff: number; maxDbDiff: number; maxDiffFreq: number } {
  // Use same length (truncate to shorter)
  const len = Math.min(a.length, b.length);
  const aSlice = new Float32Array(a.buffer, a.byteOffset, len);
  const bSlice = new Float32Array(b.buffer, b.byteOffset, len);

  const specA = computePowerSpectrum(aSlice);
  const specB = computePowerSpectrum(bSlice);

  const binHz = sampleRate / specA.N;
  const minBin = Math.ceil(50 / binHz);
  const maxBin = Math.floor(20000 / binHz);
  const numBins = Math.min(specA.powers.length, specB.powers.length);

  let sumSqDiff = 0;
  let count = 0;
  let maxDiff = 0;
  let maxDiffBin = 0;

  for (let b = minBin; b <= Math.min(maxBin, numBins - 1); b++) {
    const dbA = 10 * Math.log10(specA.powers[b]! + 1e-20);
    const dbB = 10 * Math.log10(specB.powers[b]! + 1e-20);
    const diff = Math.abs(dbA - dbB);
    sumSqDiff += diff * diff;
    count++;
    if (diff > maxDiff) {
      maxDiff = diff;
      maxDiffBin = b;
    }
  }

  return {
    rmsDbDiff: Math.sqrt(sumSqDiff / count),
    maxDbDiff: maxDiff,
    maxDiffFreq: maxDiffBin * binHz,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Reporting
// ─────────────────────────────────────────────────────────────────────────────

function printMetrics(m: SpectralMetrics): void {
  console.log(`\n  Fundamental (${FUNDAMENTAL} Hz): ${m.fundamentalPowerDb.toFixed(2)} dB`);
  console.log(`  Harmonics:`);
  for (const h of m.harmonicPowers) {
    const relDb = h.powerDb - m.fundamentalPowerDb;
    console.log(
      `    ${String(h.freq).padStart(5)} Hz (resolved: ${h.resolvedHz.toFixed(1)} Hz): ` +
        `${h.powerDb.toFixed(2)} dB  (${relDb >= 0 ? '+' : ''}${relDb.toFixed(2)} dB rel)`,
    );
  }
  console.log(`  THD: ${m.thdPercent.toFixed(4)}% (${m.thdDb.toFixed(2)} dB)`);
  console.log(`  Noise floor (avg non-harmonic bin): ${m.noiseFloorDb.toFixed(2)} dB`);
  console.log(`  SNR (fundamental vs non-fundamental): ${m.snrDb.toFixed(2)} dB`);
}

function printComparisonTable(metrics: SpectralMetrics[]): void {
  const labels = metrics.map((m) => m.label);
  const colWidth = 16;
  const labelWidth = Math.max(...labels.map((l) => l.length), 10);

  const header =
    ''.padEnd(labelWidth + 2) +
    ['THD %', 'THD dB', 'Noise dB', 'SNR dB', 'Fund dB'].map((h) => h.padStart(colWidth)).join('');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const m of metrics) {
    const row =
      m.label.padEnd(labelWidth + 2) +
      [
        m.thdPercent.toFixed(4) + '%',
        m.thdDb.toFixed(2),
        m.noiseFloorDb.toFixed(2),
        m.snrDb.toFixed(2),
        m.fundamentalPowerDb.toFixed(2),
      ]
        .map((v) => v.padStart(colWidth))
        .join('');
    console.log(row);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const toolsDir = resolve(import.meta.dir ?? __dirname);

const files = [
  { path: resolve(toolsDir, 'pcm-capture-float32-input-good.wav'), label: 'Good (reference)' },
  { path: resolve(toolsDir, 'pcm-capture-float32-input-bad.wav'), label: 'Bad (original)' },
  { path: resolve(toolsDir, 'pcm-capture-float32-input-bad-repaired.wav'), label: 'Repaired' },
];

console.log('=== Spectral Quality Analysis ===');
console.log(`Test signal: ${FUNDAMENTAL} Hz sine, 48 kHz stereo`);
console.log(`Harmonics checked: ${HARMONICS.join(', ')} Hz\n`);

const allMetrics: SpectralMetrics[] = [];
const monoSignals: Map<string, Float32Array> = new Map();

for (const file of files) {
  console.log(`--- ${file.label} ---`);
  console.log(`  File: ${file.path}`);

  const buffer = readFileSync(file.path);
  const wav = parseWav(buffer);

  console.log(`  Format: ${wav.formatTag === 3 ? 'Float32' : 'Int16'} ${wav.bitsPerSample}bit`);
  console.log(
    `  ${wav.sampleRate} Hz, ${wav.channels}ch, ${(wav.samples.length / wav.channels / wav.sampleRate).toFixed(2)}s`,
  );

  const ch0 = deinterleave(wav.samples, wav.channels, 0);
  monoSignals.set(file.label, ch0);

  const metrics = analyzeSpectral(ch0, wav.sampleRate, file.label);
  allMetrics.push(metrics);
  printMetrics(metrics);
}

// ─────────────────────────────────────────────────────────────────────────────
// Comparison Table
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n\n=== Comparison Table ===\n');
printComparisonTable(allMetrics);

// ─────────────────────────────────────────────────────────────────────────────
// Delta Analysis
// ─────────────────────────────────────────────────────────────────────────────

const good = allMetrics[0]!;
const bad = allMetrics[1]!;
const repaired = allMetrics[2]!;

console.log('\n\n=== Delta Analysis ===\n');

console.log('THD change:');
console.log(
  `  Bad vs Good:      ${bad.thdPercent - good.thdPercent >= 0 ? '+' : ''}${(bad.thdPercent - good.thdPercent).toFixed(4)}% (${bad.thdDb - good.thdDb >= 0 ? '+' : ''}${(bad.thdDb - good.thdDb).toFixed(2)} dB)`,
);
console.log(
  `  Repaired vs Good: ${repaired.thdPercent - good.thdPercent >= 0 ? '+' : ''}${(repaired.thdPercent - good.thdPercent).toFixed(4)}% (${repaired.thdDb - good.thdDb >= 0 ? '+' : ''}${(repaired.thdDb - good.thdDb).toFixed(2)} dB)`,
);
console.log(
  `  Repaired vs Bad:  ${repaired.thdPercent - bad.thdPercent >= 0 ? '+' : ''}${(repaired.thdPercent - bad.thdPercent).toFixed(4)}% (${repaired.thdDb - bad.thdDb >= 0 ? '+' : ''}${(repaired.thdDb - bad.thdDb).toFixed(2)} dB)`,
);

console.log('\nNoise floor change:');
console.log(
  `  Bad vs Good:      ${bad.noiseFloorDb - good.noiseFloorDb >= 0 ? '+' : ''}${(bad.noiseFloorDb - good.noiseFloorDb).toFixed(2)} dB`,
);
console.log(
  `  Repaired vs Good: ${repaired.noiseFloorDb - good.noiseFloorDb >= 0 ? '+' : ''}${(repaired.noiseFloorDb - good.noiseFloorDb).toFixed(2)} dB`,
);
console.log(
  `  Repaired vs Bad:  ${repaired.noiseFloorDb - bad.noiseFloorDb >= 0 ? '+' : ''}${(repaired.noiseFloorDb - bad.noiseFloorDb).toFixed(2)} dB`,
);

console.log('\nSNR change:');
console.log(
  `  Bad vs Good:      ${bad.snrDb - good.snrDb >= 0 ? '+' : ''}${(bad.snrDb - good.snrDb).toFixed(2)} dB`,
);
console.log(
  `  Repaired vs Good: ${repaired.snrDb - good.snrDb >= 0 ? '+' : ''}${(repaired.snrDb - good.snrDb).toFixed(2)} dB`,
);
console.log(
  `  Repaired vs Bad:  ${repaired.snrDb - bad.snrDb >= 0 ? '+' : ''}${(repaired.snrDb - bad.snrDb).toFixed(2)} dB`,
);

// ─────────────────────────────────────────────────────────────────────────────
// Spectral Convergence: repaired vs good, bad vs good
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n\n=== Spectral Convergence (FFT power spectrum difference) ===\n');

const goodMono = monoSignals.get('Good (reference)')!;
const badMono = monoSignals.get('Bad (original)')!;
const repairedMono = monoSignals.get('Repaired')!;

const diffBadGood = spectralDifference(badMono, goodMono, 48000);
const diffRepairedGood = spectralDifference(repairedMono, goodMono, 48000);
const diffRepairedBad = spectralDifference(repairedMono, badMono, 48000);

console.log('RMS spectral difference (dB):');
console.log(
  `  Bad vs Good:      ${diffBadGood.rmsDbDiff.toFixed(2)} dB (max ${diffBadGood.maxDbDiff.toFixed(2)} dB @ ${diffBadGood.maxDiffFreq.toFixed(0)} Hz)`,
);
console.log(
  `  Repaired vs Good: ${diffRepairedGood.rmsDbDiff.toFixed(2)} dB (max ${diffRepairedGood.maxDbDiff.toFixed(2)} dB @ ${diffRepairedGood.maxDiffFreq.toFixed(0)} Hz)`,
);
console.log(
  `  Repaired vs Bad:  ${diffRepairedBad.rmsDbDiff.toFixed(2)} dB (max ${diffRepairedBad.maxDbDiff.toFixed(2)} dB @ ${diffRepairedBad.maxDiffFreq.toFixed(0)} Hz)`,
);

const convergenceRatio = diffRepairedGood.rmsDbDiff / diffBadGood.rmsDbDiff;
console.log(`\nConvergence ratio (repaired-good / bad-good): ${convergenceRatio.toFixed(4)}`);
if (convergenceRatio < 1.0) {
  console.log(
    `  --> Repaired is ${((1 - convergenceRatio) * 100).toFixed(1)}% closer to Good than Bad was.`,
  );
} else {
  console.log(
    `  --> Repaired is ${((convergenceRatio - 1) * 100).toFixed(1)}% FURTHER from Good than Bad was.`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-Harmonic Comparison
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n\n=== Per-Harmonic Power (relative to fundamental, dB) ===\n');

const harmonicLabels = HARMONICS.map((f) => `${f} Hz`);
const colW = 16;

const hdrLine = ''.padEnd(10) + files.map((f) => f.label.padStart(colW)).join('');
console.log(hdrLine);
console.log('-'.repeat(hdrLine.length));

for (let hi = 0; hi < HARMONICS.length; hi++) {
  const cells = allMetrics.map((m) => {
    const relDb = m.harmonicPowers[hi]!.powerDb - m.fundamentalPowerDb;
    return `${relDb.toFixed(2)} dB`.padStart(colW);
  });
  console.log(`${harmonicLabels[hi]!.padEnd(10)}${cells.join('')}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n\n=== Verdict ===\n');

const newHarmonics = repaired.harmonicPowers.some((h, i) => {
  const goodRel = good.harmonicPowers[i]!.powerDb - good.fundamentalPowerDb;
  const repairedRel = h.powerDb - repaired.fundamentalPowerDb;
  return repairedRel > goodRel + 3; // 3 dB threshold for "new" harmonic energy
});

const noiseRaised = repaired.noiseFloorDb > good.noiseFloorDb + 3;

if (newHarmonics) {
  console.log('WARNING: Repair introduces new harmonic content (>3 dB above good reference).');
} else {
  console.log('OK: Repair does not introduce significant new harmonics (all within 3 dB of good).');
}

if (noiseRaised) {
  console.log(
    `WARNING: Repair raises noise floor by ${(repaired.noiseFloorDb - good.noiseFloorDb).toFixed(2)} dB vs good reference.`,
  );
} else {
  console.log(
    `OK: Noise floor is within 3 dB of good reference (delta: ${(repaired.noiseFloorDb - good.noiseFloorDb).toFixed(2)} dB).`,
  );
}

if (convergenceRatio < 1.0) {
  console.log(
    `OK: Repaired spectrum converges toward good (${((1 - convergenceRatio) * 100).toFixed(1)}% closer).`,
  );
} else {
  console.log(
    `NOTE: Repaired spectrum diverges from good (${((convergenceRatio - 1) * 100).toFixed(1)}% further).`,
  );
}

console.log('\nDone.');
