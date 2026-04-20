/**
 * Stereo Cross-Channel Declicker — v2
 *
 * Simpler, more sensitive approach than LPC-based M/S detection.
 * Uses raw |d²| on L and R independently, but requires BOTH channels
 * to spike simultaneously to classify as a capture artifact.
 *
 * Key insight: capture artifacts are injected at the transport layer,
 * so they appear identically in both channels. Music content has
 * independent sample-level details per channel — simultaneous d² spikes
 * in both channels at the exact same sample position are extremely rare
 * in natural audio.
 *
 * Detection criteria:
 * 1. |d²| > adaptive threshold in BOTH L and R at sample i
 * 2. L and R d² values are correlated (similar magnitude)
 * 3. The event is isolated (not part of a dense transient region)
 *
 * Usage:
 *   bun run tools/stereo-declicker.ts <input.wav> [options]
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
// Stereo Cross-Channel Declicker
// ─────────────────────────────────────────────────────────────────────────────

interface Detection {
  position: number;
  length: number;
  d2L: number;
  d2R: number;
  localRms: number;
  ratio: number; // min(d2L,d2R)/max(d2L,d2R) — how correlated
}

function stereoDeclick(
  left: Float32Array,
  right: Float32Array,
  opts: {
    baseThreshold: number;
    rmsMultiplier: number;
    minCorrelation: number;
    maxRun: number;
    maxDensity: number;
    densityWindow: number;
  },
): { correctedL: Float32Array; correctedR: Float32Array; detections: Detection[] } {
  const n = left.length;

  // Compute |d²| for both channels
  const d2L = new Float64Array(n);
  const d2R = new Float64Array(n);
  for (let i = 2; i < n; i++) {
    d2L[i] = Math.abs(left[i]! - 2 * left[i - 1]! + left[i - 2]!);
    d2R[i] = Math.abs(right[i]! - 2 * right[i - 1]! + right[i - 2]!);
  }

  // Compute local RMS (linked stereo) via cumulative sum
  const rmsHalf = 128;
  const cumSqL = new Float64Array(n + 1);
  const cumSqR = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumSqL[i + 1] = cumSqL[i]! + left[i]! * left[i]!;
    cumSqR[i + 1] = cumSqR[i]! + right[i]! * right[i]!;
  }
  function localRms(idx: number): number {
    const lo = Math.max(0, idx - rmsHalf);
    const hi = Math.min(n, idx + rmsHalf);
    const len = hi - lo;
    const rmsL = Math.sqrt((cumSqL[hi]! - cumSqL[lo]!) / len);
    const rmsR = Math.sqrt((cumSqR[hi]! - cumSqR[lo]!) / len);
    return Math.max(rmsL, rmsR);
  }

  // Compute "both-channel spike" density for transient rejection
  // A sample is a "both-spike" if d2L and d2R both exceed base threshold
  const bothSpike = new Uint8Array(n);
  for (let i = 2; i < n; i++) {
    const thr = Math.max(opts.baseThreshold, localRms(i) * opts.rmsMultiplier);
    if (d2L[i]! > thr && d2R[i]! > thr) {
      bothSpike[i] = 1;
    }
  }

  // Cumulative sum for density computation
  const cumBoth = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumBoth[i + 1] = cumBoth[i]! + bothSpike[i]!;
  }
  function bothDensity(idx: number): number {
    const lo = Math.max(0, idx - opts.densityWindow);
    const hi = Math.min(n, idx + opts.densityWindow);
    return (cumBoth[hi]! - cumBoth[lo]!) / (hi - lo);
  }

  // Detect: both channels spike, correlated magnitude, isolated
  const detections: Detection[] = [];
  const correctedL = new Float32Array(left);
  const correctedR = new Float32Array(right);
  const anchorMargin = 3;

  let i = anchorMargin;
  while (i < n - anchorMargin) {
    if (!bothSpike[i]) {
      i++;
      continue;
    }

    const rms = localRms(i);
    const thr = Math.max(opts.baseThreshold, rms * opts.rmsMultiplier);

    // Check correlation: both channels should have similar d² magnitude
    const minD2 = Math.min(d2L[i]!, d2R[i]!);
    const maxD2 = Math.max(d2L[i]!, d2R[i]!);
    const correlation = minD2 / (maxD2 + 1e-15);

    if (correlation < opts.minCorrelation) {
      i++;
      continue;
    }

    // Check density: reject if in a dense transient region
    const density = bothDensity(i);
    if (density > opts.maxDensity) {
      i++;
      continue;
    }

    // Find extent of the click
    const glitchStart = Math.max(anchorMargin, i - 1);
    let j = i + 1;
    while (j < n - anchorMargin && j - glitchStart < opts.maxRun) {
      if (!bothSpike[j]) {
        // Check if next 2 are also clear
        if (!bothSpike[Math.min(n - 1, j + 1)] && !bothSpike[Math.min(n - 1, j + 2)]) break;
      }
      j++;
    }
    const glitchEnd = Math.min(n - anchorMargin, j + 1);
    const runLen = glitchEnd - glitchStart;

    if (runLen > opts.maxRun || j - glitchStart >= opts.maxRun) {
      i = glitchEnd + 1;
      continue;
    }

    // Repair with Hermite interpolation on both channels
    const a0 = glitchStart - 1;
    const a1 = glitchEnd;
    const span = a1 - a0;

    if (span > 1) {
      for (const [sig, corr] of [
        [left, correctedL],
        [right, correctedR],
      ] as const) {
        const v0 = sig[a0]!;
        const v1 = sig[a1]!;
        const d0 = (sig[a0]! - sig[Math.max(0, a0 - 2)]!) * 0.5;
        const d1 = (sig[Math.min(n - 1, a1 + 2)]! - sig[a1]!) * 0.5;

        for (let k = glitchStart; k < glitchEnd; k++) {
          const t = (k - a0) / span;
          corr[k] = hermite(t, v0, v1, d0 * span, d1 * span);
        }
      }

      detections.push({
        position: glitchStart,
        length: runLen,
        d2L: d2L[i]!,
        d2R: d2R[i]!,
        localRms: rms,
        ratio: correlation,
      });
    }

    i = glitchEnd + 1;
  }

  return { correctedL, correctedR, detections };
}

// ─────────────────────────────────────────────────────────────────────────────
// Zero-Dropout Detector
// ─────────────────────────────────────────────────────────────────────────────

function repairZeroDropouts(
  channels: Float32Array[],
  minActiveRms: number,
): { dropouts: number; samplesFixed: number } {
  let dropouts = 0;
  let samplesFixed = 0;

  for (const corr of channels) {
    const n = corr.length;
    let i = 0;
    while (i < n) {
      if (Math.abs(corr[i]!) > 0.0001) {
        i++;
        continue;
      }

      const runStart = i;
      while (i < n && Math.abs(corr[i]!) < 0.0001) i++;
      const runEnd = i;
      const runLen = runEnd - runStart;

      if (runLen < 2 || runLen > 1024 || runStart < 64 || runEnd > n - 64) continue;

      let rmsBefore = 0,
        rmsAfter = 0;
      for (let j = runStart - 32; j < runStart; j++) rmsBefore += corr[j]! * corr[j]!;
      for (let j = runEnd; j < Math.min(runEnd + 32, n); j++) rmsAfter += corr[j]! * corr[j]!;
      rmsBefore = Math.sqrt(rmsBefore / 32);
      rmsAfter = Math.sqrt(rmsAfter / Math.min(32, n - runEnd));

      if (rmsBefore < minActiveRms || rmsAfter < minActiveRms) continue;

      const margin = Math.min(16, runStart);
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

      dropouts++;
      samplesFixed += repairEnd - repairStart;
    }
  }

  return { dropouts, samplesFixed };
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

const baseThreshold = getOpt('threshold', 0.003);
const rmsMultiplier = getOpt('rms-mult', 0.01);
const minCorrelation = getOpt('min-corr', 0.15);
const maxRun = getOpt('max-run', 16);
const maxDensity = getOpt('max-density', 0.02);
const densityWindow = getOpt('density-window', 256);

if (!filePath) {
  console.error('Usage: bun run tools/stereo-declicker.ts <input.wav> [options]');
  process.exit(1);
}

console.log(`\nStereo Cross-Channel Declicker: ${filePath}`);
console.log(`  Base threshold:   ${baseThreshold}`);
console.log(`  RMS multiplier:   ${rmsMultiplier}`);
console.log(`  Min correlation:  ${minCorrelation}`);
console.log(`  Max run:          ${maxRun} samples`);
console.log(`  Max density:      ${maxDensity}`);
console.log(`  Density window:   ±${densityWindow} samples`);

const buffer = readFileSync(filePath);
const wav = parseWav(buffer);

console.log(`\n  Format: ${wav.formatTag === 3 ? 'Float32' : 'Int16'} ${wav.bitsPerSample}bit`);
console.log(
  `  ${wav.sampleRate}Hz, ${wav.channels}ch, ${(wav.samples.length / wav.channels / wav.sampleRate).toFixed(2)}s`,
);

if (wav.channels < 2) {
  console.error('Error: requires stereo input');
  process.exit(1);
}

const channels = deinterleave(wav.samples, wav.channels);
const left = channels[0]!;
const right = channels[1]!;

const t0 = performance.now();

// Phase 1: Cross-channel click detection
const result = stereoDeclick(left, right, {
  baseThreshold,
  rmsMultiplier,
  minCorrelation,
  maxRun,
  maxDensity,
  densityWindow,
});

// Phase 2: Zero-dropout repair
const { dropouts, samplesFixed: dropoutSamples } = repairZeroDropouts(
  [result.correctedL, result.correctedR],
  0.05,
);

const elapsed = performance.now() - t0;
const durationSec = left.length / wav.sampleRate;

console.log(
  `\n═══ Results (${elapsed.toFixed(0)}ms, ${(durationSec / (elapsed / 1000)).toFixed(0)}x realtime) ═══`,
);
console.log(
  `  Clicks: ${result.detections.length} (${(result.detections.length / durationSec).toFixed(1)}/sec)`,
);

const totalSamples = result.detections.reduce((s, d) => s + d.length, 0);
console.log(`  Samples repaired: ${totalSamples}`);

if (dropouts > 0) {
  console.log(`  Zero-dropouts: ${dropouts} (${dropoutSamples} samples)`);
}

if (result.detections.length > 0) {
  const avgLen = totalSamples / result.detections.length;
  console.log(`  Avg click length: ${avgLen.toFixed(1)} samples`);

  // Show first 30 detections
  console.log(`\n  First ${Math.min(30, result.detections.length)} clicks:`);
  console.log('  Position    |  Time(ms) | Len | d²L      | d²R      | Corr | LocalRMS');
  console.log('  ' + '-'.repeat(78));
  for (const d of result.detections.slice(0, 30)) {
    const timeMs = ((d.position / wav.sampleRate) * 1000).toFixed(1);
    console.log(
      `  ${String(d.position).padStart(10)} | ${timeMs.padStart(9)} | ${String(d.length).padStart(3)} | ${d.d2L.toFixed(5).padStart(8)} | ${d.d2R.toFixed(5).padStart(8)} | ${d.ratio.toFixed(2).padStart(4)} | ${d.localRms.toFixed(4)}`,
    );
  }
}

// Smoothness comparison
let origDiscont = 0,
  corrDiscont = 0;
for (let i = 2; i < left.length; i++) {
  if (Math.abs(left[i]! - 2 * left[i - 1]! + left[i - 2]!) > 0.005) origDiscont++;
  if (
    Math.abs(result.correctedL[i]! - 2 * result.correctedL[i - 1]! + result.correctedL[i - 2]!) >
    0.005
  )
    corrDiscont++;
}
console.log(
  `\n  Discontinuities (|d²|>0.005): ${origDiscont} → ${corrDiscont} (${origDiscont > 0 ? ((1 - corrDiscont / origDiscont) * 100).toFixed(1) : 0}% reduction)`,
);

// Write outputs
const corrected = interleave([result.correctedL, result.correctedR]);
const dir = dirname(resolve(filePath));
const base = basename(filePath, '.wav');

const outPath = resolve(dir, `${base}-fixed.wav`);
writeWavFloat32(outPath, corrected, wav.sampleRate, wav.channels);
console.log(`\n  Output: ${outPath}`);

// Diff signal
const diff = new Float32Array(left.length);
for (let i = 0; i < left.length; i++) {
  diff[i] = (result.correctedL[i]! - left[i]!) * 10;
}
const diffPath = resolve(dir, `${base}-diff.wav`);
writeWavFloat32(diffPath, diff, wav.sampleRate, 1);
console.log(`  Diff (10x): ${diffPath}`);
