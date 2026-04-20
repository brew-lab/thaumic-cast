/**
 * Targeted Declicker — Kurtosis-gated d² repair
 *
 * Strategy: Only repair samples in windows where the d² distribution
 * shows impulsive behavior (high kurtosis). Within those windows,
 * use the proven d² + Hermite approach to fix discontinuities.
 *
 * This avoids the problem of the pure d² declicker treating both
 * good and bad files equally, while still using the effective repair method.
 *
 * Additional: detects micro-dropouts (single samples near zero in active signal)
 * which are a known Surface Go artifact pattern.
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';

function parseWav(buf: Buffer): { sampleRate: number; channels: number; samples: Float32Array } {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let offset = 12;
  let channels = 0,
    sampleRate = 0,
    formatTag = 0,
    bitsPerSample = 0;
  let dataOffset = 0,
    dataSize = 0;
  while (offset < buf.length - 8) {
    const chunkId = String.fromCharCode(...buf.subarray(offset, offset + 4));
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
  if (formatTag !== 3 || bitsPerSample !== 32)
    throw new Error(`Unsupported: tag=${formatTag} bits=${bitsPerSample}`);
  return {
    sampleRate,
    channels,
    samples: new Float32Array(buf.buffer, buf.byteOffset + dataOffset, dataSize / 4),
  };
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

// ─── Core algorithm ──────────────────────────────────────────────────────────

interface RepairEvent {
  position: number;
  length: number;
  type: 'kurtosis-d2' | 'micro-dropout' | 'level-jump';
  windowKurtosis?: number;
  peakD2?: number;
}

function targetedDeclick(
  channels: Float32Array[],
  sampleRate: number,
  opts: {
    windowMs: number;
    hopMs: number;
    kurtosisThreshold: number;
    d2SigmaThreshold: number;
    maxClickLen: number;
    dropoutMinRms: number;
    levelJumpThreshold: number;
  },
): { corrected: Float32Array[]; events: RepairEvent[] } {
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

  // Linked d² (max across channels)
  const linkedD2 = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let maxD2 = 0;
    for (let ch = 0; ch < numCh; ch++) {
      if (d2[ch]![i]! > maxD2) maxD2 = d2[ch]![i]!;
    }
    linkedD2[i] = maxD2;
  }

  const events: RepairEvent[] = [];
  const repaired = new Set<number>();

  // ── Phase 1: Kurtosis-gated d² repair ──────────────────────────────────────
  // Only repair in windows where d² distribution is impulsive (high kurtosis)

  const numWindows = Math.floor((n - windowSize) / hopSize) + 1;

  for (let w = 0; w < numWindows; w++) {
    const wStart = w * hopSize;
    const wEnd = Math.min(wStart + windowSize, n);

    // Compute d² statistics for this window
    let sum = 0,
      sumSq = 0,
      sum4 = 0,
      count = 0;
    for (let i = wStart + 2; i < wEnd; i++) {
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

    if (kurtosis < opts.kurtosisThreshold) continue;

    // This window has impulsive events — find and repair them
    const sigmaThresh = mean + sigma * opts.d2SigmaThreshold;

    for (let i = wStart + 3; i < wEnd - 3 && i < n - 3; i++) {
      if (repaired.has(i)) continue;
      if (linkedD2[i]! < sigmaThresh) continue;

      // Cross-channel: both channels must have elevated d²
      if (numCh >= 2) {
        let allHigh = true;
        for (let ch = 0; ch < numCh; ch++) {
          if (d2[ch]![i]! < mean + sigma * (opts.d2SigmaThreshold * 0.3)) {
            allHigh = false;
            break;
          }
        }
        if (!allHigh) continue;
      }

      // Find click extent
      let clickStart = i;
      let clickEnd = i + 1;
      while (clickStart > wStart + 3 && linkedD2[clickStart - 1]! > sigmaThresh * 0.4) {
        clickStart--;
        if (i - clickStart > opts.maxClickLen) break;
      }
      while (clickEnd < wEnd - 3 && clickEnd < n - 3 && linkedD2[clickEnd]! > sigmaThresh * 0.4) {
        clickEnd++;
        if (clickEnd - clickStart > opts.maxClickLen) break;
      }

      const len = clickEnd - clickStart;
      if (len > opts.maxClickLen) {
        i = clickEnd;
        continue;
      }

      for (let k = clickStart; k < clickEnd; k++) repaired.add(k);
      events.push({
        position: clickStart,
        length: len,
        type: 'kurtosis-d2',
        windowKurtosis: kurtosis,
        peakD2: linkedD2[i]!,
      });
      i = clickEnd;
    }
  }

  // ── Phase 2: Micro-dropout detection ──────────────────────────────────────
  // Single samples near zero in active signal (both channels)
  for (let i = 32; i < n - 32; i++) {
    if (repaired.has(i)) continue;

    // Check if this sample is near zero in both channels
    let allNearZero = true;
    for (let ch = 0; ch < numCh; ch++) {
      if (Math.abs(channels[ch]![i]!) > 0.002) {
        allNearZero = false;
        break;
      }
    }
    if (!allNearZero) continue;

    // Check if surrounded by active signal
    let rmsBefore = 0,
      rmsAfter = 0;
    for (let j = i - 16; j < i; j++) {
      for (let ch = 0; ch < numCh; ch++) rmsBefore += channels[ch]![j]! * channels[ch]![j]!;
    }
    for (let j = i + 1; j < i + 17 && j < n; j++) {
      for (let ch = 0; ch < numCh; ch++) rmsAfter += channels[ch]![j]! * channels[ch]![j]!;
    }
    rmsBefore = Math.sqrt(rmsBefore / (16 * numCh));
    rmsAfter = Math.sqrt(rmsAfter / (16 * numCh));

    if (rmsBefore < opts.dropoutMinRms || rmsAfter < opts.dropoutMinRms) continue;

    // Find dropout extent (1-5 samples)
    let dropEnd = i + 1;
    while (dropEnd < n && dropEnd - i < 5) {
      let stillZero = true;
      for (let ch = 0; ch < numCh; ch++) {
        if (Math.abs(channels[ch]![dropEnd]!) > 0.002) {
          stillZero = false;
          break;
        }
      }
      if (!stillZero) break;
      dropEnd++;
    }

    const len = dropEnd - i;
    for (let k = i; k < dropEnd; k++) repaired.add(k);
    events.push({ position: i, length: len, type: 'micro-dropout' });
    i = dropEnd;
  }

  // ── Phase 3: Level jump detection ──────────────────────────────────────────
  // Short-term level change that affects both channels identically
  // Compute running RMS in short windows and look for sudden jumps
  const jumpWindow = 64; // samples (~1.3ms)
  for (let i = jumpWindow * 2; i < n - jumpWindow * 2; i += jumpWindow) {
    if (repaired.has(i)) continue;

    // RMS of the window before and after this point
    let rmsPre = 0,
      rmsPost = 0;
    for (let ch = 0; ch < numCh; ch++) {
      let pre = 0,
        post = 0;
      for (let j = 0; j < jumpWindow; j++) {
        pre += channels[ch]![i - jumpWindow + j]! * channels[ch]![i - jumpWindow + j]!;
        post += channels[ch]![i + j]! * channels[ch]![i + j]!;
      }
      rmsPre += Math.sqrt(pre / jumpWindow);
      rmsPost += Math.sqrt(post / jumpWindow);
    }
    rmsPre /= numCh;
    rmsPost /= numCh;

    if (rmsPre < 0.01 || rmsPost < 0.01) continue;

    const ratio = Math.max(rmsPre / rmsPost, rmsPost / rmsPre);
    if (ratio < opts.levelJumpThreshold) continue;

    // Find the exact transition point — highest d² in ±8 samples of boundary
    let bestD2 = 0,
      bestPos = i;
    for (let j = i - 8; j <= i + 8; j++) {
      if (j >= 0 && j < n && linkedD2[j]! > bestD2) {
        bestD2 = linkedD2[j]!;
        bestPos = j;
      }
    }

    // Only repair if both channels show the jump
    if (numCh >= 2) {
      let allHigh = true;
      for (let ch = 0; ch < numCh; ch++) {
        if (d2[ch]![bestPos]! < bestD2 * 0.2) {
          allHigh = false;
          break;
        }
      }
      if (!allHigh) continue;
    }

    // Repair a short region around the transition
    const repairStart = Math.max(3, bestPos - 2);
    const repairEnd = Math.min(n - 3, bestPos + 3);
    for (let k = repairStart; k < repairEnd; k++) repaired.add(k);
    events.push({
      position: repairStart,
      length: repairEnd - repairStart,
      type: 'level-jump',
      peakD2: bestD2,
    });
  }

  // Sort events by position
  events.sort((a, b) => a.position - b.position);

  // ── Apply repairs with Hermite interpolation ──────────────────────────────
  const corrected = channels.map((ch) => new Float32Array(ch));

  for (const evt of events) {
    const a0 = Math.max(0, evt.position - 2);
    const a1 = Math.min(n - 1, evt.position + evt.length + 1);
    const span = a1 - a0;
    if (span <= 1) continue;

    for (let ch = 0; ch < numCh; ch++) {
      const sig = channels[ch]!;
      const corr = corrected[ch]!;
      const v0 = sig[a0]!;
      const v1 = sig[a1]!;
      const d0 = (sig[a0]! - sig[Math.max(0, a0 - 2)]!) * 0.5;
      const d1 = (sig[Math.min(n - 1, a1 + 2)]! - sig[a1]!) * 0.5;

      for (let k = evt.position; k < evt.position + evt.length; k++) {
        const t = (k - a0) / span;
        corr[k] = hermite(t, v0, v1, d0 * span, d1 * span);
      }
    }
  }

  return { corrected, events };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));

function getOpt(name: string, def: number): number {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseFloat(arg.split('=')[1]!) : def;
}

const windowMs = getOpt('window', 30);
const hopMs = getOpt('hop', 10);
const kurtThreshold = getOpt('kurtosis', 30);
const d2Sigma = getOpt('sigma', 3.0);
const maxClickLen = getOpt('max-click', 16);
const dropoutRms = getOpt('dropout-rms', 0.02);
const levelJump = getOpt('level-jump', 3.0);

if (!filePath) {
  console.error('Usage: bun run tools/targeted-declicker.ts <input.wav> [options]');
  process.exit(1);
}

const buffer = readFileSync(filePath);
const wav = parseWav(buffer);
const n = Math.floor(wav.samples.length / wav.channels);

console.log(`\nTargeted Declicker: ${filePath}`);
console.log(`  ${wav.sampleRate}Hz, ${wav.channels}ch, ${(n / wav.sampleRate).toFixed(2)}s`);
console.log(`  Window: ${windowMs}ms, Hop: ${hopMs}ms`);
console.log(`  Kurtosis gate: ${kurtThreshold}`);
console.log(`  d² sigma threshold: ${d2Sigma}`);
console.log(`  Max click: ${maxClickLen} samples`);
console.log(`  Dropout min RMS: ${dropoutRms}`);
console.log(`  Level jump threshold: ${levelJump}x`);

const channels: Float32Array[] = [];
for (let ch = 0; ch < wav.channels; ch++) {
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = wav.samples[i * wav.channels + ch]!;
  channels.push(data);
}

const t0 = performance.now();
const result = targetedDeclick(channels, wav.sampleRate, {
  windowMs,
  hopMs,
  kurtosisThreshold: kurtThreshold,
  d2SigmaThreshold: d2Sigma,
  maxClickLen,
  dropoutMinRms: dropoutRms,
  levelJumpThreshold: levelJump,
});
const elapsed = performance.now() - t0;
const durationSec = n / wav.sampleRate;

console.log(
  `\n═══ Results (${elapsed.toFixed(0)}ms, ${(durationSec / (elapsed / 1000)).toFixed(0)}x realtime) ═══`,
);

// Count by type
const byType = new Map<string, RepairEvent[]>();
for (const e of result.events) {
  const arr = byType.get(e.type) || [];
  arr.push(e);
  byType.set(e.type, arr);
}

console.log(`  Total events: ${result.events.length}`);
for (const [type, evts] of byType) {
  console.log(`    ${type}: ${evts.length}`);
}

const totalSamples = result.events.reduce((s, e) => s + e.length, 0);
console.log(`  Total samples repaired: ${totalSamples}`);

// Show events by time region
const regions = [
  { label: '0-5s', start: 0, end: 5 },
  { label: '5-10s', start: 5, end: 10 },
  { label: '10-13s', start: 10, end: 13 },
  { label: '13-15s', start: 13, end: 15 },
  { label: '15-20s', start: 15, end: 20 },
  { label: '20-22s', start: 20, end: 22 },
  { label: '22-24s', start: 22, end: 24 },
  { label: '24-25s', start: 24, end: 25 },
  { label: '25-28s', start: 25, end: 28 },
  { label: '28+s', start: 28, end: 999 },
];

console.log(`\n  Events by time region:`);
for (const r of regions) {
  const inRegion = result.events.filter((e) => {
    const timeSec = e.position / wav.sampleRate;
    return timeSec >= r.start && timeSec < r.end;
  });
  if (inRegion.length > 0) {
    const types = new Map<string, number>();
    for (const e of inRegion) types.set(e.type, (types.get(e.type) || 0) + 1);
    const typeStr = [...types.entries()].map(([t, c]) => `${t}:${c}`).join(', ');
    console.log(
      `    ${r.label.padEnd(8)}: ${String(inRegion.length).padStart(4)} events (${typeStr})`,
    );
  }
}

// Show first events
console.log(`\n  First ${Math.min(40, result.events.length)} events:`);
console.log('  Position    |  Time(ms) | Len | Type           | peakD2   | Kurt');
console.log('  ' + '-'.repeat(75));
for (const e of result.events.slice(0, 40)) {
  const timeMs = ((e.position / wav.sampleRate) * 1000).toFixed(1);
  console.log(
    `  ${String(e.position).padStart(10)} | ${timeMs.padStart(9)} | ${String(e.length).padStart(3)} | ${e.type.padEnd(14)} | ${(e.peakD2 ?? 0).toFixed(5).padStart(8)} | ${(e.windowKurtosis ?? 0).toFixed(0).padStart(5)}`,
  );
}

// Smoothness comparison
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
  `\n  d² discontinuities: ${origD} → ${corrD} (${origD > 0 ? ((1 - corrD / origD) * 100).toFixed(1) : 0}% reduction)`,
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
const outPath = resolve(dir, `${base}-targeted-fixed.wav`);
writeWavFloat32(outPath, outSamples, wav.sampleRate, wav.channels);
console.log(`\n  Output: ${outPath}`);
