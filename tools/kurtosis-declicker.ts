/**
 * Kurtosis-guided Declicker
 *
 * Uses d² kurtosis to identify windows with impulsive events (clicks),
 * then within those windows, finds and repairs the specific click samples.
 *
 * The key insight: d² kurtosis is dramatically higher in windows containing
 * clicks. BAD music files have P99 kurtosis of 277 vs GOOD at 127.
 * Normal music has kurtosis ~20-30, clicks push it to 100+.
 *
 * Algorithm:
 * 1. Compute d² kurtosis in sliding windows (50ms)
 * 2. Flag windows where kurtosis exceeds adaptive threshold
 * 3. Within flagged windows, find peak d² samples
 * 4. If peak d² is an outlier (>3 sigma in the window), repair with Hermite
 * 5. Cross-channel requirement: both channels must have anomaly
 *
 * Usage:
 *   bun run tools/kurtosis-declicker.ts <input.wav> [options]
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

  let samples: Float32Array;
  if (formatTag === 3 && bitsPerSample === 32) {
    samples = new Float32Array(buffer.buffer, buffer.byteOffset + dataOffset, dataSize / 4);
  } else {
    throw new Error(`Unsupported format: tag=${formatTag} bits=${bitsPerSample}`);
  }

  return { sampleRate, channels, samples };
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

// ─── Kurtosis-based declicker ─────────────────────────────────────────────────

interface ClickEvent {
  position: number;
  length: number;
  windowKurtosis: number;
  peakD2: number;
  windowSigma: number;
  sigmaRatio: number;
}

function kurtosisDeclick(
  channels: Float32Array[],
  sampleRate: number,
  opts: {
    windowMs: number;
    hopMs: number;
    kurtosisThreshold: number;
    sigmaThreshold: number;
    maxClickLen: number;
    crossChannel: boolean;
  },
): { corrected: Float32Array[]; clicks: ClickEvent[] } {
  const numCh = channels.length;
  const n = channels[0]!.length;
  const windowSize = Math.floor((sampleRate * opts.windowMs) / 1000);
  const hopSize = Math.floor((sampleRate * opts.hopMs) / 1000);

  // Compute |d²| for all channels
  const d2: Float64Array[] = [];
  for (let ch = 0; ch < numCh; ch++) {
    const d = new Float64Array(n);
    const sig = channels[ch]!;
    for (let i = 2; i < n; i++) {
      d[i] = Math.abs(sig[i]! - 2 * sig[i - 1]! + sig[i - 2]!);
    }
    d2.push(d);
  }

  // For cross-channel: compute linked d² (max across channels)
  const linkedD2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let maxD2 = 0;
    for (let ch = 0; ch < numCh; ch++) {
      if (d2[ch]![i]! > maxD2) maxD2 = d2[ch]![i]!;
    }
    linkedD2[i] = maxD2;
  }

  // Sliding window kurtosis + outlier detection
  const clicks: ClickEvent[] = [];
  const repaired = new Set<number>(); // positions already repaired

  const numWindows = Math.floor((n - windowSize) / hopSize) + 1;

  for (let w = 0; w < numWindows; w++) {
    const wStart = w * hopSize;
    const wEnd = wStart + windowSize;

    // Compute d² statistics for this window
    let sum = 0,
      sumSq = 0,
      sum4 = 0,
      count = 0;
    for (let i = wStart + 2; i < wEnd && i < n; i++) {
      const v = linkedD2[i]!;
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
    const sigma = Math.sqrt(variance);

    // Skip windows with low kurtosis (no impulsive events)
    if (kurtosis < opts.kurtosisThreshold) continue;

    // Find peaks within this window that exceed sigma threshold
    const sigmaThresh = mean + sigma * opts.sigmaThreshold;

    for (let i = wStart + 3; i < wEnd - 3 && i < n - 3; i++) {
      if (repaired.has(i)) continue;
      if (linkedD2[i]! < sigmaThresh) continue;

      // Cross-channel check: both channels must have elevated d²
      if (opts.crossChannel && numCh >= 2) {
        let allHigh = true;
        for (let ch = 0; ch < numCh; ch++) {
          if (d2[ch]![i]! < mean + sigma * (opts.sigmaThreshold * 0.5)) {
            allHigh = false;
            break;
          }
        }
        if (!allHigh) continue;
      }

      // Find click extent
      let clickStart = i;
      let clickEnd = i + 1;
      while (clickStart > wStart + 3 && linkedD2[clickStart - 1]! > sigmaThresh * 0.5) {
        clickStart--;
        if (i - clickStart > opts.maxClickLen) break;
      }
      while (clickEnd < wEnd - 3 && clickEnd < n - 3 && linkedD2[clickEnd]! > sigmaThresh * 0.5) {
        clickEnd++;
        if (clickEnd - clickStart > opts.maxClickLen) break;
      }

      const len = clickEnd - clickStart;
      if (len > opts.maxClickLen) {
        i = clickEnd;
        continue;
      }

      // Mark as repaired
      for (let k = clickStart; k < clickEnd; k++) repaired.add(k);

      clicks.push({
        position: clickStart,
        length: len,
        windowKurtosis: kurtosis,
        peakD2: linkedD2[i]!,
        windowSigma: sigma,
        sigmaRatio: linkedD2[i]! / sigma,
      });

      i = clickEnd; // skip past
    }
  }

  // Sort by position
  clicks.sort((a, b) => a.position - b.position);

  // Repair clicks with Hermite interpolation
  const corrected = channels.map((ch) => new Float32Array(ch));

  for (const click of clicks) {
    const a0 = Math.max(0, click.position - 2);
    const a1 = Math.min(n - 1, click.position + click.length + 1);
    const span = a1 - a0;
    if (span <= 1) continue;

    for (let ch = 0; ch < numCh; ch++) {
      const sig = channels[ch]!;
      const corr = corrected[ch]!;
      const v0 = sig[a0]!;
      const v1 = sig[a1]!;
      const d0 = (sig[a0]! - sig[Math.max(0, a0 - 2)]!) * 0.5;
      const d1 = (sig[Math.min(n - 1, a1 + 2)]! - sig[a1]!) * 0.5;

      for (let k = click.position; k < click.position + click.length; k++) {
        const t = (k - a0) / span;
        corr[k] = hermite(t, v0, v1, d0 * span, d1 * span);
      }
    }
  }

  return { corrected, clicks };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));

function getOpt(name: string, def: number): number {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseFloat(arg.split('=')[1]!) : def;
}

const windowMs = getOpt('window', 20);
const hopMs = getOpt('hop', 5);
const kurtThreshold = getOpt('kurtosis', 50);
const sigmaThreshold = getOpt('sigma', 4);
const maxClickLen = getOpt('max-click', 12);
const crossChannel = getOpt('no-cross', 0) === 0;

if (!filePath) {
  console.error('Usage: bun run tools/kurtosis-declicker.ts <input.wav> [options]');
  process.exit(1);
}

const buffer = readFileSync(filePath);
const wav = parseWav(buffer);
const n = Math.floor(wav.samples.length / wav.channels);

console.log(`\nKurtosis Declicker: ${filePath}`);
console.log(`  ${wav.sampleRate}Hz, ${wav.channels}ch, ${(n / wav.sampleRate).toFixed(2)}s`);
console.log(`  Window: ${windowMs}ms, Hop: ${hopMs}ms`);
console.log(`  Kurtosis threshold: ${kurtThreshold}`);
console.log(`  Sigma threshold: ${sigmaThreshold}`);
console.log(`  Max click: ${maxClickLen} samples`);
console.log(`  Cross-channel: ${crossChannel}`);

const channels: Float32Array[] = [];
for (let ch = 0; ch < wav.channels; ch++) {
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = wav.samples[i * wav.channels + ch]!;
  channels.push(data);
}

const t0 = performance.now();
const result = kurtosisDeclick(channels, wav.sampleRate, {
  windowMs,
  hopMs,
  kurtosisThreshold: kurtThreshold,
  sigmaThreshold,
  maxClickLen,
  crossChannel,
});
const elapsed = performance.now() - t0;
const durationSec = n / wav.sampleRate;

console.log(
  `\n═══ Results (${elapsed.toFixed(0)}ms, ${(durationSec / (elapsed / 1000)).toFixed(0)}x realtime) ═══`,
);
console.log(
  `  Clicks: ${result.clicks.length} (${(result.clicks.length / durationSec).toFixed(1)}/sec)`,
);

if (result.clicks.length > 0) {
  const totalSamples = result.clicks.reduce((s, c) => s + c.length, 0);
  console.log(`  Samples repaired: ${totalSamples}`);
  console.log(`  Avg click len: ${(totalSamples / result.clicks.length).toFixed(1)}`);

  const kurtoses = result.clicks.map((c) => c.windowKurtosis).sort((a, b) => a - b);
  const sigmaRatios = result.clicks.map((c) => c.sigmaRatio).sort((a, b) => a - b);
  const p = (arr: number[], pct: number) =>
    arr[Math.min(Math.floor((arr.length * pct) / 100), arr.length - 1)]!;

  console.log(
    `  Window kurtosis: P50=${p(kurtoses, 50).toFixed(0)}, P95=${p(kurtoses, 95).toFixed(0)}, max=${kurtoses[kurtoses.length - 1]!.toFixed(0)}`,
  );
  console.log(
    `  Sigma ratio: P50=${p(sigmaRatios, 50).toFixed(1)}, P95=${p(sigmaRatios, 95).toFixed(1)}, max=${sigmaRatios[sigmaRatios.length - 1]!.toFixed(1)}`,
  );

  console.log(`\n  First ${Math.min(30, result.clicks.length)} clicks:`);
  console.log('  Position    |  Time(ms) | Len | peakD2   | Kurt  | σ-ratio');
  console.log('  ' + '-'.repeat(65));
  for (const c of result.clicks.slice(0, 30)) {
    const timeMs = ((c.position / wav.sampleRate) * 1000).toFixed(1);
    console.log(
      `  ${String(c.position).padStart(10)} | ${timeMs.padStart(9)} | ${String(c.length).padStart(3)} | ${c.peakD2.toFixed(5).padStart(8)} | ${c.windowKurtosis.toFixed(0).padStart(5)} | ${c.sigmaRatio.toFixed(1).padStart(7)}`,
    );
  }
}

// Smoothness
let origD = 0,
  corrD = 0;
for (let i = 2; i < n; i++) {
  if (Math.abs(channels[0]![i]! - 2 * channels[0]![i - 1]! + channels[0]![i - 2]!) > 0.005) origD++;
  if (
    Math.abs(
      result.corrected[0]![i]! - 2 * result.corrected[0]![i - 1]! + result.corrected[0]![i - 2]!,
    ) > 0.005
  )
    corrD++;
}
console.log(
  `\n  d² discontinuities: ${origD} → ${corrD} (${origD > 0 ? ((1 - corrD / origD) * 100).toFixed(1) : 0}%)`,
);

// Write output
const outSamples = new Float32Array(n * wav.channels);
for (let i = 0; i < n; i++) {
  for (let ch = 0; ch < wav.channels; ch++) {
    outSamples[i * wav.channels + ch] = result.corrected[ch]![i]!;
  }
}

const dir = dirname(resolve(filePath));
const base = basename(filePath, '.wav');
const outPath = resolve(dir, `${base}-kurtosis-fixed.wav`);
writeWavFloat32(outPath, outSamples, wav.sampleRate, wav.channels);
console.log(`\n  Output: ${outPath}`);
