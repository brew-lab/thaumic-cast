/**
 * Sine Wave Residual Analyzer for PCM diagnostic captures.
 *
 * Fits an ideal sine wave to the captured data, then measures the per-sample
 * residual (deviation from ideal). Actual artifacts show up as residual spikes
 * that stand out from the noise floor — no heuristic thresholds needed.
 *
 * Approach:
 * 1. Deinterleave to mono (analyzes channel 0)
 * 2. Estimate frequency via zero-crossing rate
 * 3. Refine amplitude, frequency, phase via least-squares on short windows
 * 4. Compute per-sample residual = |actual - ideal|
 * 5. Flag residual spikes above a statistical threshold (e.g. 5σ)
 * 6. Report positions, magnitudes, quantum alignment, and dump a residual WAV
 *
 * Usage: bun run tools/analyze-glitches.ts <path-to-wav> [--dump-residual]
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';

// ─────────────────────────────────────────────────────────────────────────────
// WAV Parser
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
  let formatTag = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataOffset = 0;
  let dataSize = 0;

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

  if (!sampleRate || !dataOffset) throw new Error('Invalid WAV: missing fmt or data chunk');

  let samples: Float32Array;

  if (formatTag === 3 && bitsPerSample === 32) {
    samples = new Float32Array(buffer.buffer, buffer.byteOffset + dataOffset, dataSize / 4);
  } else if (formatTag === 1 && bitsPerSample === 16) {
    const int16 = new Int16Array(buffer.buffer, buffer.byteOffset + dataOffset, dataSize / 2);
    samples = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      samples[i] = int16[i]! / 32768;
    }
  } else {
    throw new Error(`Unsupported WAV format: tag=${formatTag} bits=${bitsPerSample}`);
  }

  return { sampleRate, channels, bitsPerSample, formatTag, samples };
}

// ─────────────────────────────────────────────────────────────────────────────
// WAV Writer (for residual dump)
// ─────────────────────────────────────────────────────────────────────────────

function writeWav(path: string, samples: Float32Array, sampleRate: number): void {
  const dataSize = samples.length * 4;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);

  // RIFF header
  writeStr(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  writeStr(v, 8, 'WAVE');

  // fmt chunk
  writeStr(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true); // IEEE Float
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true);
  v.setUint16(32, 4, true);
  v.setUint16(34, 32, true);

  // data chunk
  writeStr(v, 36, 'data');
  v.setUint32(40, dataSize, true);

  const out = Buffer.concat([
    Buffer.from(header),
    Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
  ]);
  writeFileSync(path, out);
}

function writeStr(v: DataView, offset: number, str: string): void {
  for (let i = 0; i < str.length; i++) v.setUint8(offset + i, str.charCodeAt(i));
}

// ─────────────────────────────────────────────────────────────────────────────
// Deinterleave
// ─────────────────────────────────────────────────────────────────────────────

function deinterleave(samples: Float32Array, channels: number, channel: number): Float32Array {
  const n = Math.floor(samples.length / channels);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    out[i] = samples[i * channels + channel]!;
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Sine Fitting
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Estimates sine frequency via zero-crossing rate over the full signal.
 */
function estimateFrequency(mono: Float32Array, sampleRate: number): number {
  let crossings = 0;
  for (let i = 1; i < mono.length; i++) {
    if ((mono[i - 1]! < 0 && mono[i]! >= 0) || (mono[i - 1]! >= 0 && mono[i]! < 0)) {
      crossings++;
    }
  }
  // Each full cycle has 2 zero crossings
  const duration = mono.length / sampleRate;
  return crossings / (2 * duration);
}

/**
 * Fits A*sin(2πf*n/sr + φ) + DC to a signal segment using least-squares.
 *
 * For a known frequency f, the model is linear in [A*cos(φ), A*sin(φ), DC]:
 *   y[n] = a * sin(ωn) + b * cos(ωn) + c
 * where A = sqrt(a² + b²), φ = atan2(b, a)
 *
 * Solves the 3x3 normal equations directly.
 */
function fitSine(
  mono: Float32Array,
  startIdx: number,
  length: number,
  freq: number,
  sampleRate: number,
): { amplitude: number; phase: number; dc: number; freq: number } {
  const omega = (2 * Math.PI * freq) / sampleRate;

  // Build normal equations: X^T X β = X^T y
  // X columns: sin(ωn), cos(ωn), 1
  let ss = 0,
    sc = 0,
    s1 = 0;
  let cc = 0,
    c1 = 0;
  let oneone = 0;
  let sy = 0,
    cy = 0,
    oney = 0;

  for (let i = 0; i < length; i++) {
    const n = startIdx + i;
    const sn = Math.sin(omega * n);
    const cn = Math.cos(omega * n);
    const y = mono[n]!;

    ss += sn * sn;
    sc += sn * cn;
    s1 += sn;
    cc += cn * cn;
    c1 += cn;
    oneone += 1;
    sy += sn * y;
    cy += cn * y;
    oney += y;
  }

  // Solve 3x3 system [ss sc s1; sc cc c1; s1 c1 N] * [a; b; c] = [sy; cy; oney]
  // Using Cramer's rule
  const det =
    ss * (cc * oneone - c1 * c1) - sc * (sc * oneone - c1 * s1) + s1 * (sc * c1 - cc * s1);

  if (Math.abs(det) < 1e-12) {
    return { amplitude: 0, phase: 0, dc: 0, freq };
  }

  const a =
    (sy * (cc * oneone - c1 * c1) - sc * (cy * oneone - c1 * oney) + s1 * (cy * c1 - cc * oney)) /
    det;

  const b =
    (ss * (cy * oneone - c1 * oney) - sy * (sc * oneone - c1 * s1) + s1 * (sc * oney - cy * s1)) /
    det;

  const c =
    (ss * (cc * oney - cy * c1) - sc * (sc * oney - cy * s1) + sy * (sc * c1 - cc * s1)) / det;

  const amplitude = Math.sqrt(a * a + b * b);
  const phase = Math.atan2(b, a);

  return { amplitude, phase, dc: c, freq };
}

/**
 * Refines frequency estimate using a fine grid search around the initial estimate.
 * Minimizes sum of squared residuals.
 */
function refineFrequency(mono: Float32Array, initialFreq: number, sampleRate: number): number {
  // Use a subset for speed (first 2 seconds or full signal)
  const fitLen = Math.min(mono.length, sampleRate * 2);

  let bestFreq = initialFreq;
  let bestError = Infinity;

  // Coarse search: ±2 Hz in 0.1 Hz steps
  for (let df = -2; df <= 2; df += 0.1) {
    const f = initialFreq + df;
    const fit = fitSine(mono, 0, fitLen, f, sampleRate);
    const omega = (2 * Math.PI * f) / sampleRate;

    let err = 0;
    for (let i = 0; i < fitLen; i++) {
      const ideal = fit.amplitude * Math.sin(omega * i + fit.phase) + fit.dc;
      const d = mono[i]! - ideal;
      err += d * d;
    }

    if (err < bestError) {
      bestError = err;
      bestFreq = f;
    }
  }

  // Fine search: ±0.15 Hz in 0.01 Hz steps
  const coarseFreq = bestFreq;
  for (let df = -0.15; df <= 0.15; df += 0.01) {
    const f = coarseFreq + df;
    const fit = fitSine(mono, 0, fitLen, f, sampleRate);
    const omega = (2 * Math.PI * f) / sampleRate;

    let err = 0;
    for (let i = 0; i < fitLen; i++) {
      const ideal = fit.amplitude * Math.sin(omega * i + fit.phase) + fit.dc;
      const d = mono[i]! - ideal;
      err += d * d;
    }

    if (err < bestError) {
      bestError = err;
      bestFreq = f;
    }
  }

  return bestFreq;
}

// ─────────────────────────────────────────────────────────────────────────────
// Artifact Detection
// ─────────────────────────────────────────────────────────────────────────────

interface Artifact {
  /** Per-channel sample index of the peak residual. */
  sampleIdx: number;
  /** Time in ms. */
  timeMs: number;
  /** Peak |residual| in this region. */
  peakResidual: number;
  /** Number of standard deviations above mean. */
  sigmas: number;
  /** Number of consecutive samples above threshold. */
  width: number;
  /** sampleIdx % 128. */
  quantumOffset: number;
  /** sampleIdx % AudioData typical size (480 at 48kHz). */
  audioDataOffset: number;
}

/**
 * Finds residual spikes that exceed a threshold.
 * Groups consecutive above-threshold samples into single artifacts.
 */
function findArtifacts(residual: Float32Array, threshold: number, sampleRate: number): Artifact[] {
  const artifacts: Artifact[] = [];
  let i = 0;

  while (i < residual.length) {
    if (residual[i]! > threshold) {
      const start = i;
      let peakVal = 0;
      let peakIdx = i;

      while (i < residual.length && residual[i]! > threshold * 0.5) {
        if (residual[i]! > peakVal) {
          peakVal = residual[i]!;
          peakIdx = i;
        }
        i++;
      }

      artifacts.push({
        sampleIdx: peakIdx,
        timeMs: (peakIdx / sampleRate) * 1000,
        peakResidual: peakVal,
        sigmas: 0, // Filled in later
        width: i - start,
        quantumOffset: peakIdx % 128,
        audioDataOffset: peakIdx % 480,
      });
    }
    i++;
  }

  return artifacts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Statistics
// ─────────────────────────────────────────────────────────────────────────────

function computeStats(arr: Float32Array): {
  mean: number;
  std: number;
  median: number;
  p99: number;
  p999: number;
  max: number;
} {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i]!;
  const mean = sum / arr.length;

  let sumSq = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i]! - mean;
    sumSq += d * d;
  }
  const std = Math.sqrt(sumSq / arr.length);

  // Sort a copy for percentiles
  const sorted = Float32Array.from(arr).sort();
  const median = sorted[Math.floor(sorted.length * 0.5)]!;
  const p99 = sorted[Math.floor(sorted.length * 0.99)]!;
  const p999 = sorted[Math.floor(sorted.length * 0.999)]!;
  const max = sorted[sorted.length - 1]!;

  return { mean, std, median, p99, p999, max };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
const dumpResidual = args.includes('--dump-residual');
const freqArg = args.find((a) => a.startsWith('--freq='));
const userFreq = freqArg ? parseFloat(freqArg.split('=')[1]!) : null;

if (!filePath) {
  console.error(
    'Usage: bun run tools/analyze-glitches.ts <path-to-wav> [--freq=440] [--dump-residual]',
  );
  process.exit(1);
}

console.log(`\nAnalyzing: ${filePath}\n`);

const buffer = readFileSync(filePath);
const wav = parseWav(buffer);

console.log(`Format: ${wav.formatTag === 3 ? 'Float32' : 'Int16'} ${wav.bitsPerSample}bit`);
console.log(`Sample rate: ${wav.sampleRate}Hz`);
console.log(`Channels: ${wav.channels}`);
const totalPerChannel = Math.floor(wav.samples.length / wav.channels);
console.log(
  `Total samples: ${wav.samples.length} interleaved (${totalPerChannel} per channel, ${(totalPerChannel / wav.sampleRate).toFixed(2)}s)`,
);

// Deinterleave channel 0
const mono = deinterleave(wav.samples, wav.channels, 0);
console.log();

// ─── Step 1: Estimate frequency ──────────────────────────────────────────────

let freq: number;

if (userFreq) {
  console.log(`Using user-specified frequency: ${userFreq} Hz`);
  freq = refineFrequency(mono, userFreq, wav.sampleRate);
  console.log(`Refined frequency: ${freq.toFixed(4)} Hz`);
} else {
  const rawFreq = estimateFrequency(mono, wav.sampleRate);
  console.log(`Zero-crossing frequency estimate: ${rawFreq.toFixed(2)} Hz`);
  freq = refineFrequency(mono, rawFreq, wav.sampleRate);
  console.log(`Refined frequency: ${freq.toFixed(4)} Hz`);
}
console.log();

// ─── Step 2: Fit sine in sliding windows ─────────────────────────────────────

// Use overlapping windows to track amplitude/phase drift over time.
// Window = 50 cycles of the sine wave (enough for stable fit).
const cyclesPerWindow = 50;
const samplesPerCycle = wav.sampleRate / freq;
const windowSize = Math.round(cyclesPerWindow * samplesPerCycle);
const hopSize = Math.round(windowSize / 4); // 75% overlap

console.log(
  `Fitting windows: ${windowSize} samples (${((windowSize / wav.sampleRate) * 1000).toFixed(1)}ms), hop ${hopSize}`,
);

// Compute residual for every sample using the nearest window fit
const residual = new Float32Array(mono.length);
const omega = (2 * Math.PI * freq) / wav.sampleRate;

// For each sample, compute ideal from the window that contains it
let windowStart = 0;
let currentFit = fitSine(mono, 0, Math.min(windowSize, mono.length), freq, wav.sampleRate);

for (let i = 0; i < mono.length; i++) {
  // Advance window if needed
  if (i >= windowStart + windowSize && windowStart + hopSize + windowSize <= mono.length) {
    windowStart += hopSize;
    currentFit = fitSine(mono, windowStart, windowSize, freq, wav.sampleRate);
  }

  const ideal = currentFit.amplitude * Math.sin(omega * i + currentFit.phase) + currentFit.dc;
  residual[i] = Math.abs(mono[i]! - ideal);
}

// ─── Step 3: Residual statistics ─────────────────────────────────────────────

const stats = computeStats(residual);
console.log();
console.log(`═══ Residual Statistics ═══`);
console.log(`  Mean:   ${stats.mean.toExponential(4)}`);
console.log(`  Std:    ${stats.std.toExponential(4)}`);
console.log(`  Median: ${stats.median.toExponential(4)}`);
console.log(`  P99:    ${stats.p99.toExponential(4)}`);
console.log(`  P99.9:  ${stats.p999.toExponential(4)}`);
console.log(`  Max:    ${stats.max.toExponential(4)}`);

// ─── Step 4: Find artifacts at multiple sigma thresholds ─────────────────────

for (const sigmaThreshold of [3, 5, 10, 20]) {
  const threshold = stats.mean + sigmaThreshold * stats.std;
  const artifacts = findArtifacts(residual, threshold, wav.sampleRate);

  // Fill in sigma values
  for (const a of artifacts) {
    a.sigmas = (a.peakResidual - stats.mean) / stats.std;
  }

  console.log();
  console.log(`═══ Artifacts > ${sigmaThreshold}σ (threshold=${threshold.toExponential(3)}) ═══`);
  console.log(`Found: ${artifacts.length}`);

  if (artifacts.length === 0) continue;

  // Rate
  const durationSec = mono.length / wav.sampleRate;
  console.log(`Rate: ${(artifacts.length / durationSec).toFixed(2)}/sec`);

  // Show first 30
  console.log();
  console.log(
    'Sample Idx  | Time (ms)    | Peak |residual| |  Sigmas | Width | Quantum%128 | AudioData%480',
  );
  console.log('-'.repeat(100));

  for (const a of artifacts.slice(0, 30)) {
    console.log(
      `${String(a.sampleIdx).padStart(11)} | ` +
        `${a.timeMs.toFixed(3).padStart(12)} | ` +
        `${a.peakResidual.toExponential(3).padStart(14)} | ` +
        `${a.sigmas.toFixed(1).padStart(7)} | ` +
        `${String(a.width).padStart(5)} | ` +
        `${String(a.quantumOffset).padStart(11)} | ` +
        `${String(a.audioDataOffset).padStart(13)}`,
    );
  }

  // Quantum offset histogram
  if (artifacts.length >= 10) {
    console.log(`\nRender quantum offset histogram (sampleIdx % 128):`);
    const hist = new Array(128).fill(0);
    for (const a of artifacts) hist[a.quantumOffset]++;

    const buckets = hist
      .map((count: number, offset: number) => ({ offset, count }))
      .filter((b: { count: number }) => b.count > 0)
      .sort((a: { count: number }, b: { count: number }) => b.count - a.count);

    const maxC = buckets[0]?.count ?? 0;
    const scale = 40 / Math.max(maxC, 1);

    for (const b of buckets.slice(0, 15)) {
      const bar = '█'.repeat(Math.max(1, Math.round(b.count * scale)));
      const pct = ((b.count / artifacts.length) * 100).toFixed(1);
      console.log(`  offset ${String(b.offset).padStart(3)}: ${bar} ${b.count} (${pct}%)`);
    }

    const uniqueOffsets = new Set(artifacts.map((a) => a.quantumOffset)).size;
    console.log(`\n  Unique offsets: ${uniqueOffsets} / 128`);

    // AudioData offset histogram
    console.log(`\nAudioData offset histogram (sampleIdx % 480):`);
    const adHist = new Array(480).fill(0);
    for (const a of artifacts) adHist[a.audioDataOffset]++;

    const adBuckets = adHist
      .map((count: number, offset: number) => ({ offset, count }))
      .filter((b: { count: number }) => b.count > 0)
      .sort((a: { count: number }, b: { count: number }) => b.count - a.count);

    for (const b of adBuckets.slice(0, 15)) {
      const bar = '█'.repeat(Math.max(1, Math.round((b.count / artifacts.length) * 40)));
      const pct = ((b.count / artifacts.length) * 100).toFixed(1);
      console.log(`  offset ${String(b.offset).padStart(3)}: ${bar} ${b.count} (${pct}%)`);
    }

    const uniqueAD = new Set(artifacts.map((a) => a.audioDataOffset)).size;
    console.log(`\n  Unique AudioData offsets: ${uniqueAD} / 480`);
  }

  // Width distribution
  console.log(`\nArtifact width distribution (samples):`);
  const widthMap = new Map<number, number>();
  for (const a of artifacts) {
    widthMap.set(a.width, (widthMap.get(a.width) ?? 0) + 1);
  }
  const widths = [...widthMap.entries()].sort((a, b) => a[0] - b[0]);
  for (const [w, count] of widths.slice(0, 20)) {
    const bar = '█'.repeat(Math.max(1, Math.round((count / artifacts.length) * 50)));
    console.log(`  ${String(w).padStart(3)} samples: ${bar} ${count}`);
  }
}

// ─── Step 5: Dump residual WAV ───────────────────────────────────────────────

if (dumpResidual) {
  const dir = dirname(resolve(filePath));
  const base = basename(filePath, '.wav');
  const outPath = resolve(dir, `${base}-residual.wav`);
  writeWav(outPath, residual, wav.sampleRate);
  console.log(`\nResidual WAV written to: ${outPath}`);
}

console.log('\nDone.');
