/**
 * Combined Declicker — M/S + Kurtosis + Zero-Dropout
 *
 * Three-phase detection:
 * 1. M/S LPC: high-confidence detection of capture artifacts (identical in both channels)
 * 2. Kurtosis: detects impulsive outliers in windows with heavy-tailed d² distributions
 * 3. Zero-dropout: repairs silence insertions in active signal
 *
 * All phases use Hermite interpolation for repair.
 * Deduplicates detections across phases (no double-repair).
 *
 * Usage:
 *   bun run tools/combined-declicker.ts <input.wav> [options]
 */

import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';

// ─── WAV helpers ──────────────────────────────────────────────────────────────

function parseWav(buffer: Buffer): { sampleRate: number; channels: number; samples: Float32Array } {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  let offset = 12;
  let channels = 0,
    sampleRate = 0,
    formatTag = 0,
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
  if (formatTag === 3 && bitsPerSample === 32) {
    return {
      sampleRate,
      channels,
      samples: new Float32Array(buffer.buffer, buffer.byteOffset + dataOffset, dataSize / 4),
    };
  }
  throw new Error(`Unsupported: tag=${formatTag} bits=${bitsPerSample}`);
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
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(header),
      Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
    ]),
  );
}

function hermite(t: number, v0: number, v1: number, m0: number, m1: number): number {
  const t2 = t * t,
    t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1
  );
}

function hermiteRepair(sig: Float32Array, start: number, end: number): void {
  const n = sig.length;
  const a0 = Math.max(0, start - 1);
  const a1 = Math.min(n - 1, end);
  const span = a1 - a0;
  if (span <= 1) return;
  const v0 = sig[a0]!,
    v1 = sig[a1]!;
  const d0 = (sig[a0]! - sig[Math.max(0, a0 - 2)]!) * 0.5;
  const d1 = (sig[Math.min(n - 1, a1 + 2)]! - sig[a1]!) * 0.5;
  for (let k = start; k < end; k++) {
    const t = (k - a0) / span;
    sig[k] = hermite(t, v0, v1, d0 * span, d1 * span);
  }
}

// ─── LPC ──────────────────────────────────────────────────────────────────────

function computeLpc(
  signal: Float32Array,
  start: number,
  length: number,
  order: number,
): Float64Array {
  const r = new Float64Array(order + 1);
  const end = Math.min(start + length, signal.length);
  for (let lag = 0; lag <= order; lag++) {
    let sum = 0;
    for (let i = start; i < end - lag; i++) sum += signal[i]! * signal[i + lag]!;
    r[lag] = sum;
  }
  const a = new Float64Array(order + 1);
  const aPrev = new Float64Array(order + 1);
  if (Math.abs(r[0]!) < 1e-10) return a;
  a[0] = 1;
  let error = r[0]!;
  for (let i = 1; i <= order; i++) {
    let lambda = 0;
    for (let j = 0; j < i; j++) lambda += a[j]! * r[i - j]!;
    lambda = -lambda / error;
    aPrev.set(a);
    for (let j = 1; j <= i; j++) a[j] = aPrev[j]! + lambda * aPrev[i - j]!;
    error *= 1 - lambda * lambda;
    if (error <= 0) break;
  }
  return a;
}

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
      if (n - k >= 0) pred += a[k]! * signal[n - k]!;
    }
    residual[n - start] = signal[n]! + pred;
  }
  return residual;
}

// ─── Phase 1: M/S LPC Detection ──────────────────────────────────────────────

interface Detection {
  start: number;
  end: number;
  phase: string;
  confidence: number;
}

function msDetect(
  mid: Float32Array,
  side: Float32Array,
  n: number,
  mThreshold: number,
  msRatio: number,
  maxRun: number,
): Detection[] {
  const order = 12,
    frameSize = 512,
    hopSize = 256;
  const numFrames = Math.floor((n - frameSize) / hopSize) + 1;

  const mResPow = new Float64Array(n);
  const sResPow = new Float64Array(n);
  const frameCount = new Uint8Array(n);

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    const len = Math.min(frameSize, n - start);
    const aM = computeLpc(mid, start, len, order);
    const resM = lpcResidual(mid, aM, order, start, len);
    const aS = computeLpc(side, start, len, order);
    const resS = lpcResidual(side, aS, order, start, len);
    for (let i = 0; i < len; i++) {
      const idx = start + i;
      mResPow[idx] += resM[i]! * resM[i]!;
      sResPow[idx] += resS[i]! * resS[i]!;
      frameCount[idx]++;
    }
  }
  for (let i = 0; i < n; i++) {
    if (frameCount[i]! > 1) {
      mResPow[i] /= frameCount[i]!;
      sResPow[i] /= frameCount[i]!;
    }
  }

  // Running mean for adaptive threshold
  const cumM = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cumM[i + 1] = cumM[i]! + Math.sqrt(mResPow[i]!);
  const mMedian = new Float64Array(n);
  const w = 256;
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - w),
      hi = Math.min(n, i + w);
    const m = (cumM[hi]! - cumM[lo]!) / (hi - lo);
    mMedian[i] = m * m;
  }

  const detections: Detection[] = [];
  const thrSq = mThreshold * mThreshold;
  const ratioSq = msRatio * msRatio;

  let i = order;
  while (i < n - 2) {
    if (mResPow[i]! < mMedian[i]! * thrSq) {
      i++;
      continue;
    }
    const sErr = sResPow[i]! + 1e-15;
    if (mResPow[i]! / sErr < ratioSq) {
      i++;
      continue;
    }

    let j = i + 1;
    while (j < n - 2 && j - i < maxRun) {
      if (mResPow[j]! < mMedian[j]! * thrSq) break;
      j++;
    }
    if (j - i <= maxRun) {
      detections.push({
        start: Math.max(0, i - 1),
        end: j + 1,
        phase: 'M/S',
        confidence: mResPow[i]! / sErr,
      });
    }
    i = j + 1;
  }
  return detections;
}

// ─── Phase 2: Kurtosis Detection ──────────────────────────────────────────────

function kurtosisDetect(
  channels: Float32Array[],
  n: number,
  sampleRate: number,
  kurtThreshold: number,
  sigmaThreshold: number,
  maxClickLen: number,
): Detection[] {
  const numCh = channels.length;
  const d2: Float64Array[] = [];
  for (let ch = 0; ch < numCh; ch++) {
    const d = new Float64Array(n);
    const sig = channels[ch]!;
    for (let i = 2; i < n; i++) d[i] = Math.abs(sig[i]! - 2 * sig[i - 1]! + sig[i - 2]!);
    d2.push(d);
  }
  const linked = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let mx = 0;
    for (let ch = 0; ch < numCh; ch++) if (d2[ch]![i]! > mx) mx = d2[ch]![i]!;
    linked[i] = mx;
  }

  const windowSize = Math.floor(sampleRate * 0.02); // 20ms
  const hopSize = Math.floor(sampleRate * 0.005); // 5ms
  const numWindows = Math.floor((n - windowSize) / hopSize) + 1;
  const detections: Detection[] = [];

  for (let w = 0; w < numWindows; w++) {
    const wStart = w * hopSize;
    const wEnd = wStart + windowSize;
    let sum = 0,
      sumSq = 0,
      sum4 = 0,
      count = 0;
    for (let i = wStart + 2; i < wEnd && i < n; i++) {
      const v = linked[i]!;
      sum += v;
      sumSq += v * v;
      sum4 += v * v * v * v;
      count++;
    }
    if (count < 10) continue;
    const mean = sum / count;
    const variance = sumSq / count - mean * mean;
    if (variance < 1e-20) continue;
    const kurtosis = sum4 / count / (variance * variance);
    if (kurtosis < kurtThreshold) continue;

    const sigma = Math.sqrt(variance);
    const sigmaThresh = mean + sigma * sigmaThreshold;

    for (let i = wStart + 3; i < wEnd - 3 && i < n - 3; i++) {
      if (linked[i]! < sigmaThresh) continue;
      // Cross-channel check
      if (numCh >= 2) {
        let allHigh = true;
        for (let ch = 0; ch < numCh; ch++) {
          if (d2[ch]![i]! < mean + sigma * (sigmaThreshold * 0.3)) {
            allHigh = false;
            break;
          }
        }
        if (!allHigh) continue;
      }
      let s = i,
        e = i + 1;
      while (s > wStart + 3 && linked[s - 1]! > sigmaThresh * 0.5 && i - s < maxClickLen) s--;
      while (e < wEnd - 3 && e < n - 3 && linked[e]! > sigmaThresh * 0.5 && e - s < maxClickLen)
        e++;
      if (e - s > maxClickLen) {
        i = e;
        continue;
      }
      detections.push({ start: s, end: e, phase: 'Kurtosis', confidence: kurtosis });
      i = e;
    }
  }
  return detections;
}

// ─── Phase 3: Zero-dropout Detection ──────────────────────────────────────────

function zeroDetect(channels: Float32Array[], n: number): Detection[] {
  const detections: Detection[] = [];
  const sig = channels[0]!;
  const sig2 = channels.length > 1 ? channels[1]! : sig;
  let i = 64;
  while (i < n - 64) {
    if (Math.abs(sig[i]!) > 0.0001 || Math.abs(sig2[i]!) > 0.0001) {
      i++;
      continue;
    }
    const s = i;
    while (i < n && Math.abs(sig[i]!) < 0.0001 && Math.abs(sig2[i]!) < 0.0001) i++;
    const len = i - s;
    if (len < 2 || len > 1024 || s < 64 || i > n - 64) continue;
    let rmsBefore = 0,
      rmsAfter = 0;
    for (let j = s - 32; j < s; j++) rmsBefore += sig[j]! * sig[j]!;
    for (let j = i; j < Math.min(i + 32, n); j++) rmsAfter += sig[j]! * sig[j]!;
    rmsBefore = Math.sqrt(rmsBefore / 32);
    rmsAfter = Math.sqrt(rmsAfter / Math.min(32, n - i));
    if (rmsBefore < 0.05 || rmsAfter < 0.05) continue;
    detections.push({
      start: Math.max(0, s - 16),
      end: Math.min(n, i + 16),
      phase: 'Zero',
      confidence: rmsBefore,
    });
  }
  return detections;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
function getOpt(name: string, def: number): number {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseFloat(arg.split('=')[1]!) : def;
}

if (!filePath) {
  console.error('Usage: bun run tools/combined-declicker.ts <input.wav>');
  process.exit(1);
}

const mThreshold = getOpt('m-threshold', 8);
const msRatio = getOpt('ms-ratio', 4);
const kurtThreshold = getOpt('kurtosis', 50);
const sigmaThreshold = getOpt('sigma', 4);
const maxClick = getOpt('max-click', 12);

const buffer = readFileSync(filePath);
const wav = parseWav(buffer);
const n = Math.floor(wav.samples.length / wav.channels);
const durationSec = n / wav.sampleRate;

console.log(`\nCombined Declicker: ${filePath}`);
console.log(`  ${wav.sampleRate}Hz, ${wav.channels}ch, ${durationSec.toFixed(2)}s`);

const channels: Float32Array[] = [];
for (let ch = 0; ch < wav.channels; ch++) {
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = wav.samples[i * wav.channels + ch]!;
  channels.push(data);
}

// Build M/S
const mid = new Float32Array(n);
const side = new Float32Array(n);
if (wav.channels >= 2) {
  for (let i = 0; i < n; i++) {
    mid[i] = (channels[0]![i]! + channels[1]![i]!) * 0.5;
    side[i] = (channels[0]![i]! - channels[1]![i]!) * 0.5;
  }
}

const t0 = performance.now();

// Phase 1: M/S
const msDetections = wav.channels >= 2 ? msDetect(mid, side, n, mThreshold, msRatio, maxClick) : [];

// Phase 2: Kurtosis
const kurtDetections = kurtosisDetect(
  channels,
  n,
  wav.sampleRate,
  kurtThreshold,
  sigmaThreshold,
  maxClick,
);

// Phase 3: Zero-dropout
const zeroDetections = zeroDetect(channels, n);

// Merge and deduplicate (keep all, but don't repair same position twice)
const allDetections = [...msDetections, ...kurtDetections, ...zeroDetections];
allDetections.sort((a, b) => a.start - b.start);

// Deduplicate: merge overlapping detections
const merged: Detection[] = [];
for (const det of allDetections) {
  if (merged.length > 0) {
    const prev = merged[merged.length - 1]!;
    if (det.start <= prev.end + 2) {
      // Merge
      prev.end = Math.max(prev.end, det.end);
      prev.phase += '+' + det.phase;
      prev.confidence = Math.max(prev.confidence, det.confidence);
      continue;
    }
  }
  merged.push({ ...det });
}

// Apply repairs
const corrected = channels.map((ch) => new Float32Array(ch));
for (const det of merged) {
  for (let ch = 0; ch < wav.channels; ch++) {
    hermiteRepair(corrected[ch]!, det.start, det.end);
  }
}

const elapsed = performance.now() - t0;

// Stats
const msCount = msDetections.length;
const kurtCount = kurtDetections.length;
const zeroCount = zeroDetections.length;
const totalSamples = merged.reduce((s, d) => s + (d.end - d.start), 0);

console.log(
  `\n═══ Results (${elapsed.toFixed(0)}ms, ${(durationSec / (elapsed / 1000)).toFixed(0)}x realtime) ═══`,
);
console.log(`  Phase 1 (M/S LPC):  ${msCount} detections`);
console.log(`  Phase 2 (Kurtosis): ${kurtCount} detections`);
console.log(`  Phase 3 (Zero):     ${zeroCount} detections`);
console.log(`  After merge:        ${merged.length} unique events`);
console.log(
  `  Total samples:      ${totalSamples} (${(totalSamples / durationSec).toFixed(1)}/sec)`,
);

// Show first 30
console.log(`\n  First ${Math.min(30, merged.length)} events:`);
console.log('  Position    |  Time(ms) | Len | Phase         | Confidence');
console.log('  ' + '-'.repeat(65));
for (const d of merged.slice(0, 30)) {
  const timeMs = ((d.start / wav.sampleRate) * 1000).toFixed(1);
  console.log(
    `  ${String(d.start).padStart(10)} | ${timeMs.padStart(9)} | ${String(d.end - d.start).padStart(3)} | ${d.phase.padEnd(13)} | ${d.confidence.toFixed(1)}`,
  );
}

// Smoothness
let origD = 0,
  corrD = 0;
for (let i = 2; i < n; i++) {
  if (Math.abs(channels[0]![i]! - 2 * channels[0]![i - 1]! + channels[0]![i - 2]!) > 0.005) origD++;
  if (Math.abs(corrected[0]![i]! - 2 * corrected[0]![i - 1]! + corrected[0]![i - 2]!) > 0.005)
    corrD++;
}
console.log(
  `\n  d² discontinuities: ${origD} → ${corrD} (${origD > 0 ? ((1 - corrD / origD) * 100).toFixed(1) : 0}% reduction)`,
);

// Write
const outSamples = new Float32Array(n * wav.channels);
for (let i = 0; i < n; i++)
  for (let ch = 0; ch < wav.channels; ch++) outSamples[i * wav.channels + ch] = corrected[ch]![i]!;

const dir = dirname(resolve(filePath));
const base = basename(filePath, '.wav');
const outPath = resolve(dir, `${base}-combined-fixed.wav`);
writeWavFloat32(outPath, outSamples, wav.sampleRate, wav.channels);
console.log(`\n  Output: ${outPath}`);

const diff = new Float32Array(n);
for (let i = 0; i < n; i++) diff[i] = (corrected[0]![i]! - channels[0]![i]!) * 10;
const diffPath = resolve(dir, `${base}-combined-diff.wav`);
writeWavFloat32(diffPath, diff, wav.sampleRate, 1);
console.log(`  Diff (10x): ${diffPath}`);
