/**
 * Selective Median Despiker
 *
 * Instead of trying to classify windows as "clickey", this approach
 * looks at individual samples and fixes ones that deviate significantly
 * from their local median. This catches single-sample and short-burst
 * glitches without needing a click vs music classifier.
 *
 * The key: a sample is suspicious when it deviates from the local trend
 * by more than expected. We measure "expected" using a short median
 * window and "deviation" using local RMS.
 *
 * For stereo capture artifacts: both channels must show the anomaly
 * at the same sample position (capture artifacts are correlated).
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

// ─── LPC Prediction ─────────────────────────────────────────────────────────

/**
 * Levinson-Durbin recursion to compute LPC coefficients from autocorrelation.
 */
function levinsonDurbin(r: Float64Array, order: number): Float64Array {
  const a = new Float64Array(order + 1);
  const aTemp = new Float64Array(order + 1);
  a[0] = 1.0;

  let e = r[0]!;
  if (e <= 0) return a;

  for (let i = 1; i <= order; i++) {
    let lambda = 0;
    for (let j = 0; j < i; j++) {
      lambda -= a[j]! * r[i - j]!;
    }
    lambda /= e;

    for (let j = 0; j <= i; j++) aTemp[j] = a[j]!;
    for (let j = 0; j <= i; j++) {
      a[j] = aTemp[j]! + lambda * aTemp[i - j]!;
    }

    e *= 1 - lambda * lambda;
    if (e <= 0) break;
  }

  return a;
}

/**
 * Compute autocorrelation for a signal segment.
 */
function autocorrelation(
  signal: Float32Array,
  start: number,
  len: number,
  maxLag: number,
): Float64Array {
  const r = new Float64Array(maxLag + 1);
  for (let lag = 0; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = start; i < start + len - lag; i++) {
      sum += signal[i]! * signal[i + lag]!;
    }
    r[lag] = sum;
  }
  return r;
}

/**
 * Predict a sample using LPC coefficients and past samples.
 */
function lpcPredict(signal: Float32Array, pos: number, coeffs: Float64Array): number {
  let predicted = 0;
  const order = coeffs.length - 1;
  for (let j = 1; j <= order; j++) {
    if (pos - j >= 0) {
      predicted -= coeffs[j]! * signal[pos - j]!;
    }
  }
  return predicted;
}

// ─── Core algorithm ──────────────────────────────────────────────────────────

interface DespikeEvent {
  position: number;
  length: number;
  type: 'lpc-outlier' | 'micro-dropout' | 'median-spike';
  deviation?: number;
}

function despike(
  channels: Float32Array[],
  sampleRate: number,
  opts: {
    lpcOrder: number;
    lpcFrameSize: number;
    lpcHop: number;
    lpcThreshold: number;
    medianHalf: number;
    medianThreshold: number;
    dropoutRms: number;
    maxRepairLen: number;
    crossChannel: boolean;
  },
): { corrected: Float32Array[]; events: DespikeEvent[] } {
  const numCh = channels.length;
  const n = channels[0]!.length;
  const events: DespikeEvent[] = [];
  const repaired = new Set<number>();

  // Work on copies
  const corrected = channels.map((ch) => new Float32Array(ch));

  // ── Phase 1: LPC-based outlier detection ──────────────────────────────────
  // Use LPC to predict each sample and flag large prediction errors
  // Only flag when BOTH channels show errors (capture artifact signature)

  const lpcErrors: Float64Array[] = [];
  for (let ch = 0; ch < numCh; ch++) {
    lpcErrors.push(new Float64Array(n));
  }

  const numFrames = Math.floor((n - opts.lpcFrameSize) / opts.lpcHop) + 1;

  for (let f = 0; f < numFrames; f++) {
    const frameStart = f * opts.lpcHop;
    const frameEnd = frameStart + opts.lpcFrameSize;

    for (let ch = 0; ch < numCh; ch++) {
      // Compute LPC coefficients for this frame
      const r = autocorrelation(channels[ch]!, frameStart, opts.lpcFrameSize, opts.lpcOrder);
      if (r[0]! < 1e-10) continue; // silent frame
      const coeffs = levinsonDurbin(r, opts.lpcOrder);

      // Compute prediction error for each sample in the frame
      for (let i = frameStart + opts.lpcOrder; i < frameEnd; i++) {
        const predicted = lpcPredict(channels[ch]!, i, coeffs);
        const error = Math.abs(channels[ch]![i]! - predicted);
        // Keep max error across overlapping frames
        if (error > lpcErrors[ch]![i]!) {
          lpcErrors[ch]![i] = error;
        }
      }
    }
  }

  // Compute local statistics of LPC error and flag outliers
  const errorWindowHalf = 256;
  for (let i = opts.lpcOrder + errorWindowHalf; i < n - errorWindowHalf - 3; i++) {
    if (repaired.has(i)) continue;

    // Check both channels for elevated error
    let allChannelsHigh = true;
    let maxDeviation = 0;

    for (let ch = 0; ch < numCh; ch++) {
      // Local mean and std of LPC error
      let sum = 0,
        sumSq = 0,
        count = 0;
      for (let j = i - errorWindowHalf; j < i + errorWindowHalf; j++) {
        if (j >= 0 && j < n) {
          sum += lpcErrors[ch]![j]!;
          sumSq += lpcErrors[ch]![j]! * lpcErrors[ch]![j]!;
          count++;
        }
      }
      const mean = sum / count;
      const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));

      if (std < 1e-8) {
        allChannelsHigh = false;
        break;
      }

      const deviation = (lpcErrors[ch]![i]! - mean) / std;
      if (deviation < opts.lpcThreshold * (opts.crossChannel ? 0.5 : 1.0)) {
        allChannelsHigh = false;
        break;
      }
      maxDeviation = Math.max(maxDeviation, deviation);
    }

    if (!allChannelsHigh) continue;

    // Find extent of the anomaly
    let start = i;
    let end = i + 1;
    while (start > 3 && start > i - opts.maxRepairLen) {
      let stillHigh = false;
      for (let ch = 0; ch < numCh; ch++) {
        let sum = 0,
          sumSq = 0,
          count = 0;
        for (let j = start - 1 - errorWindowHalf; j < start - 1 + errorWindowHalf; j++) {
          if (j >= 0 && j < n) {
            sum += lpcErrors[ch]![j]!;
            sumSq += lpcErrors[ch]![j]! * lpcErrors[ch]![j]!;
            count++;
          }
        }
        const mean = sum / count;
        const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
        if (std > 1e-8 && (lpcErrors[ch]![start - 1]! - mean) / std > opts.lpcThreshold * 0.3) {
          stillHigh = true;
        }
      }
      if (!stillHigh) break;
      start--;
    }
    while (end < n - 3 && end - start < opts.maxRepairLen) {
      let stillHigh = false;
      for (let ch = 0; ch < numCh; ch++) {
        let sum = 0,
          sumSq = 0,
          count = 0;
        for (let j = end - errorWindowHalf; j < end + errorWindowHalf; j++) {
          if (j >= 0 && j < n) {
            sum += lpcErrors[ch]![j]!;
            sumSq += lpcErrors[ch]![j]! * lpcErrors[ch]![j]!;
            count++;
          }
        }
        const mean = sum / count;
        const std = Math.sqrt(Math.max(0, sumSq / count - mean * mean));
        if (std > 1e-8 && (lpcErrors[ch]![end]! - mean) / std > opts.lpcThreshold * 0.3) {
          stillHigh = true;
        }
      }
      if (!stillHigh) break;
      end++;
    }

    const len = end - start;
    if (len > opts.maxRepairLen) {
      i = end;
      continue;
    }

    // Repair with LPC prediction (use forward prediction from before the glitch)
    for (let ch = 0; ch < numCh; ch++) {
      const sig = corrected[ch]!;
      // Use samples before the glitch to compute LPC
      const contextStart = Math.max(0, start - opts.lpcFrameSize);
      const contextLen = start - contextStart;
      if (contextLen < opts.lpcOrder * 2) continue;

      const r = autocorrelation(channels[ch]!, contextStart, contextLen, opts.lpcOrder);
      if (r[0]! < 1e-10) continue;
      const coeffs = levinsonDurbin(r, opts.lpcOrder);

      // Forward-predict into the glitch region
      const predicted = new Float32Array(len);
      for (let k = 0; k < len; k++) {
        let pred = 0;
        for (let j = 1; j <= opts.lpcOrder; j++) {
          const srcIdx = start + k - j;
          const val = srcIdx >= start ? predicted[k - j]! : sig[srcIdx]!;
          pred -= coeffs[j]! * val;
        }
        predicted[k] = pred;
      }

      // Also backward-predict from after the glitch
      // Use samples after the glitch for backward LPC
      const bContextEnd = Math.min(n, end + opts.lpcFrameSize);
      const bContextLen = bContextEnd - end;
      if (bContextLen >= opts.lpcOrder * 2) {
        // Reverse the signal for backward prediction
        const revSig = new Float32Array(bContextLen);
        for (let k = 0; k < bContextLen; k++) revSig[k] = channels[ch]![bContextEnd - 1 - k]!;
        const rRev = autocorrelation(revSig, 0, bContextLen, opts.lpcOrder);
        if (rRev[0]! > 1e-10) {
          const revCoeffs = levinsonDurbin(rRev, opts.lpcOrder);
          const backPred = new Float32Array(len);
          for (let k = len - 1; k >= 0; k--) {
            let pred = 0;
            for (let j = 1; j <= opts.lpcOrder; j++) {
              const srcIdx = start + k + j;
              const val = srcIdx < end ? backPred[k + j]! : sig[srcIdx]!;
              pred -= revCoeffs[j]! * (val ?? 0);
            }
            backPred[k] = pred;
          }

          // Crossfade forward and backward predictions
          for (let k = 0; k < len; k++) {
            const t = len > 1 ? k / (len - 1) : 0.5;
            // Smooth crossfade: more weight on forward at start, backward at end
            const w = 0.5 - 0.5 * Math.cos(Math.PI * t);
            predicted[k] = predicted[k]! * (1 - w) + backPred[k]! * w;
          }
        }
      }

      for (let k = 0; k < len; k++) {
        sig[start + k] = predicted[k]!;
      }
    }

    for (let k = start; k < end; k++) repaired.add(k);
    events.push({ position: start, length: len, type: 'lpc-outlier', deviation: maxDeviation });
    i = end;
  }

  // ── Phase 2: Micro-dropout detection ──────────────────────────────────────
  for (let i = 32; i < n - 32; i++) {
    if (repaired.has(i)) continue;

    let allNearZero = true;
    for (let ch = 0; ch < numCh; ch++) {
      if (Math.abs(channels[ch]![i]!) > 0.002) {
        allNearZero = false;
        break;
      }
    }
    if (!allNearZero) continue;

    let rmsBefore = 0,
      rmsAfter = 0;
    for (let j = i - 16; j < i; j++) {
      for (let ch = 0; ch < numCh; ch++) rmsBefore += channels[ch]![j]! * channels[ch]![j]!;
    }
    for (let j = i + 1; j <= i + 16 && j < n; j++) {
      for (let ch = 0; ch < numCh; ch++) rmsAfter += channels[ch]![j]! * channels[ch]![j]!;
    }
    rmsBefore = Math.sqrt(rmsBefore / (16 * numCh));
    rmsAfter = Math.sqrt(rmsAfter / (16 * numCh));

    if (rmsBefore < opts.dropoutRms || rmsAfter < opts.dropoutRms) continue;

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
    // Simple interpolation for short dropouts
    for (let ch = 0; ch < numCh; ch++) {
      for (let k = i; k < dropEnd; k++) {
        const t = (k - i + 1) / (len + 1);
        corrected[ch]![k] = channels[ch]![i - 1]! * (1 - t) + channels[ch]![dropEnd]! * t;
      }
    }

    for (let k = i; k < dropEnd; k++) repaired.add(k);
    events.push({ position: i, length: len, type: 'micro-dropout' });
    i = dropEnd;
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

const lpcOrder = getOpt('lpc-order', 16);
const lpcFrameSize = getOpt('lpc-frame', 512);
const lpcHop = getOpt('lpc-hop', 256);
const lpcThreshold = getOpt('lpc-threshold', 6);
const medianHalf = getOpt('median-half', 2);
const medianThreshold = getOpt('median-threshold', 4);
const dropoutRms = getOpt('dropout-rms', 0.02);
const maxRepairLen = getOpt('max-repair', 16);
const crossChannel = getOpt('no-cross', 0) === 0;

if (!filePath) {
  console.error('Usage: bun run tools/median-despike.ts <input.wav> [options]');
  process.exit(1);
}

const buffer = readFileSync(filePath);
const wav = parseWav(buffer);
const n = Math.floor(wav.samples.length / wav.channels);

console.log(`\nMedian Despiker: ${filePath}`);
console.log(`  ${wav.sampleRate}Hz, ${wav.channels}ch, ${(n / wav.sampleRate).toFixed(2)}s`);
console.log(
  `  LPC: order=${lpcOrder}, frame=${lpcFrameSize}, hop=${lpcHop}, threshold=${lpcThreshold}`,
);
console.log(`  Cross-channel: ${crossChannel}`);
console.log(`  Max repair: ${maxRepairLen} samples`);

const channels: Float32Array[] = [];
for (let ch = 0; ch < wav.channels; ch++) {
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = wav.samples[i * wav.channels + ch]!;
  channels.push(data);
}

const t0 = performance.now();
const result = despike(channels, wav.sampleRate, {
  lpcOrder,
  lpcFrameSize,
  lpcHop,
  lpcThreshold,
  medianHalf,
  medianThreshold,
  dropoutMinRms: dropoutRms,
  maxRepairLen,
  crossChannel,
} as any);
const elapsed = performance.now() - t0;
const durationSec = n / wav.sampleRate;

console.log(
  `\n═══ Results (${elapsed.toFixed(0)}ms, ${(durationSec / (elapsed / 1000)).toFixed(0)}x realtime) ═══`,
);

const byType = new Map<string, DespikeEvent[]>();
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

// Time distribution
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

// Show events in click regions
console.log(`\n  Events in user-identified click regions:`);
for (const r of [
  { label: '13-15s', start: 13, end: 15 },
  { label: '22-24s', start: 22, end: 24 },
  { label: '25-28s', start: 25, end: 28 },
]) {
  const inRegion = result.events.filter((e) => {
    const timeSec = e.position / wav.sampleRate;
    return timeSec >= r.start && timeSec < r.end;
  });
  console.log(`  ${r.label}: ${inRegion.length} events`);
  for (const e of inRegion.slice(0, 15)) {
    const timeMs = ((e.position / wav.sampleRate) * 1000).toFixed(1);
    console.log(
      `    @${timeMs}ms: ${e.type}, len=${e.length}${e.deviation ? `, dev=${e.deviation.toFixed(1)}σ` : ''}`,
    );
  }
  if (inRegion.length > 15) console.log(`    ... and ${inRegion.length - 15} more`);
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
const outPath = resolve(dir, `${base}-despiked.wav`);
writeWavFloat32(outPath, outSamples, wav.sampleRate, wav.channels);
console.log(`\n  Output: ${outPath}`);
