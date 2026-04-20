/**
 * AR Model-Based Declicker with Forward-Backward Asymmetry
 *
 * Based on research from Godsill & Rayner, Vaseghi, and the Essentia framework.
 *
 * Key insight: A CLICK has high prediction error in BOTH forward and backward
 * directions, while a musical TRANSIENT (drum hit, attack) has high forward
 * error but LOW backward error (the decay/sustain is natural and predictable
 * from the future samples).
 *
 * Detection pipeline:
 * 1. Compute forward AR prediction error (predict from past)
 * 2. Compute backward AR prediction error (predict from future)
 * 3. Flag samples where BOTH errors are high (bilateral outlier)
 * 4. Use robust median-based thresholding (clicks don't affect median)
 *
 * Repair:
 * - Forward AR extrapolation from pre-gap samples
 * - Backward AR extrapolation from post-gap samples
 * - Raised-cosine crossfade between the two
 *
 * AR estimation uses Burg's method (minimizes both forward and backward error).
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

// ─── Burg's Method for AR Parameter Estimation ──────────────────────────────

/**
 * Burg's method: estimates AR parameters by minimizing both forward and
 * backward prediction errors simultaneously. More stable than autocorrelation
 * method and works well with short data segments.
 */
function burgAR(signal: Float32Array, start: number, length: number, order: number): Float64Array {
  const end = Math.min(start + length, signal.length);
  const n = end - start;
  if (n <= order) return new Float64Array(order + 1);

  const a = new Float64Array(order + 1);
  a[0] = 1.0;

  // Initialize forward and backward prediction errors
  const ef = new Float64Array(n);
  const eb = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    ef[i] = signal[start + i]!;
    eb[i] = signal[start + i]!;
  }

  for (let m = 1; m <= order; m++) {
    // Compute reflection coefficient
    let num = 0,
      den = 0;
    for (let j = m; j < n; j++) {
      num += ef[j]! * eb[j - 1]!;
      den += ef[j]! * ef[j]! + eb[j - 1]! * eb[j - 1]!;
    }

    if (den < 1e-30) break;
    const k = (-2 * num) / den;

    // Update AR coefficients
    const aOld = new Float64Array(a);
    for (let j = 1; j <= m; j++) {
      a[j] = aOld[j]! + k * aOld[m - j]!;
    }

    // Update prediction errors
    const efOld = new Float64Array(ef);
    for (let j = m; j < n; j++) {
      ef[j] = efOld[j]! + k * eb[j - 1]!;
      eb[j] = eb[j - 1]! + k * efOld[j]!;
    }
  }

  return a;
}

// ─── AR Prediction ──────────────────────────────────────────────────────────

/**
 * Forward prediction: predict sample at `pos` from past samples.
 */
function predictForward(signal: Float32Array, pos: number, a: Float64Array, order: number): number {
  let pred = 0;
  for (let j = 1; j <= order; j++) {
    if (pos - j >= 0) {
      pred -= a[j]! * signal[pos - j]!;
    }
  }
  return pred;
}

/**
 * Backward prediction: predict sample at `pos` from future samples.
 * Uses the property that for a stationary AR process, the backward
 * prediction coefficients equal the forward ones (time-reversibility).
 */
function predictBackward(
  signal: Float32Array,
  pos: number,
  a: Float64Array,
  order: number,
): number {
  let pred = 0;
  for (let j = 1; j <= order; j++) {
    if (pos + j < signal.length) {
      pred -= a[j]! * signal[pos + j]!;
    }
  }
  return pred;
}

// ─── Core Declicker ─────────────────────────────────────────────────────────

interface ClickEvent {
  position: number;
  length: number;
  fwdError: number;
  bwdError: number;
  asymmetry: number; // bwd/fwd ratio — low = transient, high = click
  threshold: number;
}

function arDeclick(
  mono: Float32Array,
  sampleRate: number,
  opts: {
    arOrder: number;
    frameSize: number;
    hopSize: number;
    detectionThresholdDb: number;
    powerEstClip: number;
    maxClickLen: number;
    minAsymmetry: number;
  },
): { corrected: Float32Array; clicks: ClickEvent[] } {
  const n = mono.length;
  const { arOrder, frameSize, hopSize } = opts;
  const numFrames = Math.floor((n - frameSize) / hopSize) + 1;

  // Per-sample forward and backward prediction errors
  const fwdErr = new Float64Array(n);
  const bwdErr = new Float64Array(n);
  const frameCountFwd = new Uint8Array(n);
  const frameCountBwd = new Uint8Array(n);

  for (let f = 0; f < numFrames; f++) {
    const start = f * hopSize;
    const end = Math.min(start + frameSize, n);
    const len = end - start;

    // Estimate AR parameters using Burg's method
    const a = burgAR(mono, start, len, arOrder);

    // Forward prediction error
    for (let i = start + arOrder; i < end; i++) {
      const predicted = predictForward(mono, i, a, arOrder);
      const err = Math.abs(mono[i]! - predicted);
      fwdErr[i] += err;
      frameCountFwd[i]++;
    }

    // Backward prediction error (predict from future samples)
    for (let i = start; i < end - arOrder; i++) {
      const predicted = predictBackward(mono, i, a, arOrder);
      const err = Math.abs(mono[i]! - predicted);
      bwdErr[i] += err;
      frameCountBwd[i]++;
    }
  }

  // Average overlapping frame contributions
  for (let i = 0; i < n; i++) {
    if (frameCountFwd[i]! > 1) fwdErr[i] /= frameCountFwd[i]!;
    if (frameCountBwd[i]! > 1) bwdErr[i] /= frameCountBwd[i]!;
  }

  // Compute combined bilateral error: sqrt(fwd * bwd)
  // This is high only when BOTH directions show anomaly
  const bilateralErr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    bilateralErr[i] = Math.sqrt(fwdErr[i]! * bwdErr[i]!);
  }

  // Robust threshold: median of bilateral error (per frame), clipped
  // The key from Vaseghi: use MEDIAN not mean, because clicks inflate mean but not median
  const detectionDb = opts.detectionThresholdDb;
  const detectionLinear = Math.pow(10, detectionDb / 20);

  const clicks: ClickEvent[] = [];
  const repaired = new Set<number>();

  // Process in frames for adaptive thresholding
  const threshFrameSize = 1024;
  const numThreshFrames = Math.ceil(n / threshFrameSize);

  for (let tf = 0; tf < numThreshFrames; tf++) {
    const tStart = tf * threshFrameSize;
    const tEnd = Math.min(tStart + threshFrameSize, n);

    // Compute median of bilateral error in this frame
    const frameErrors: number[] = [];
    for (let i = tStart; i < tEnd; i++) {
      if (bilateralErr[i]! > 1e-15) frameErrors.push(bilateralErr[i]!);
    }
    if (frameErrors.length < 10) continue;

    frameErrors.sort((a, b) => a - b);
    const median = frameErrors[Math.floor(frameErrors.length / 2)]!;

    // Clipped power estimate (clip at powerEstClip * median to robustly estimate noise floor)
    let clippedSum = 0,
      clippedCount = 0;
    const clipLevel = median * opts.powerEstClip;
    for (const e of frameErrors) {
      const clamped = Math.min(e, clipLevel);
      clippedSum += clamped * clamped;
      clippedCount++;
    }
    const robustRms = Math.sqrt(clippedSum / clippedCount);

    // Detection threshold
    const threshold = robustRms * detectionLinear;

    // Detect clicks in this frame
    for (let i = tStart + arOrder; i < tEnd - arOrder; i++) {
      if (repaired.has(i)) continue;
      if (bilateralErr[i]! < threshold) continue;

      // Check asymmetry: for a click, backward error should also be high
      // For a transient, backward error is much lower than forward
      const fwd = fwdErr[i]!;
      const bwd = bwdErr[i]!;
      if (fwd < 1e-10 || bwd < 1e-10) continue;

      const asymmetry = Math.min(fwd, bwd) / Math.max(fwd, bwd);
      // asymmetry close to 1.0 = both directions equally bad = CLICK
      // asymmetry close to 0.0 = one direction much worse = TRANSIENT (skip)
      if (asymmetry < opts.minAsymmetry) continue;

      // Find click extent
      let clickStart = i;
      let clickEnd = i + 1;
      while (clickStart > tStart + arOrder && bilateralErr[clickStart - 1]! > threshold * 0.5) {
        clickStart--;
        if (i - clickStart > opts.maxClickLen) break;
      }
      while (clickEnd < tEnd - arOrder && bilateralErr[clickEnd]! > threshold * 0.5) {
        clickEnd++;
        if (clickEnd - clickStart > opts.maxClickLen) break;
      }

      const len = clickEnd - clickStart;
      if (len > opts.maxClickLen) {
        i = clickEnd;
        continue;
      }

      for (let k = clickStart; k < clickEnd; k++) repaired.add(k);
      clicks.push({
        position: clickStart,
        length: len,
        fwdError: fwd,
        bwdError: bwd,
        asymmetry,
        threshold,
      });
      i = clickEnd;
    }
  }

  clicks.sort((a, b) => a.position - b.position);

  // ── Repair ─────────────────────────────────────────────────────────────────
  // Short gaps (≤8 samples): Hermite interpolation (proven on sine waves)
  // Longer gaps: Forward-backward AR extrapolation with crossfade

  const corrected = new Float32Array(mono);
  const contextLen = 512;
  const hermiteMaxLen = 8;

  for (const click of clicks) {
    const gapStart = click.position;
    const gapEnd = click.position + click.length;
    const gapLen = click.length;

    if (gapStart < 3 || gapEnd > n - 3) continue;

    if (gapLen <= hermiteMaxLen) {
      // Hermite interpolation for short gaps
      const a0 = gapStart - 1;
      const a1 = gapEnd;
      const span = a1 - a0;
      if (span <= 1) continue;

      const v0 = mono[a0]!;
      const v1 = mono[a1]!;
      const d0 = (mono[a0]! - mono[Math.max(0, a0 - 2)]!) * 0.5;
      const d1 = (mono[Math.min(n - 1, a1 + 2)]! - mono[a1]!) * 0.5;

      for (let k = gapStart; k < gapEnd; k++) {
        const t = (k - a0) / span;
        const t2 = t * t,
          t3 = t2 * t;
        corrected[k] =
          (2 * t3 - 3 * t2 + 1) * v0 +
          (t3 - 2 * t2 + t) * (d0 * span) +
          (-2 * t3 + 3 * t2) * v1 +
          (t3 - t2) * (d1 * span);
      }
    } else {
      // AR extrapolation for longer gaps
      if (gapStart < contextLen + arOrder || gapEnd > n - contextLen - arOrder) continue;

      const fwdA = burgAR(mono, gapStart - contextLen, contextLen, arOrder);
      const fwdBuf = new Float32Array(contextLen + gapLen);
      for (let i = 0; i < contextLen; i++) fwdBuf[i] = mono[gapStart - contextLen + i]!;
      for (let i = 0; i < gapLen; i++) {
        let pred = 0;
        for (let j = 1; j <= arOrder; j++) {
          const idx = contextLen + i - j;
          if (idx >= 0) pred -= fwdA[j]! * fwdBuf[idx]!;
        }
        fwdBuf[contextLen + i] = pred;
      }

      const postContext = new Float32Array(contextLen);
      for (let i = 0; i < contextLen; i++) postContext[i] = mono[gapEnd + contextLen - 1 - i]!;
      const bwdA = burgAR(postContext, 0, contextLen, arOrder);
      const bwdBuf = new Float32Array(contextLen + gapLen);
      for (let i = 0; i < contextLen; i++) bwdBuf[i] = mono[gapEnd + contextLen - 1 - i]!;
      for (let i = 0; i < gapLen; i++) {
        let pred = 0;
        for (let j = 1; j <= arOrder; j++) {
          const idx = contextLen + i - j;
          if (idx >= 0) pred -= bwdA[j]! * bwdBuf[idx]!;
        }
        bwdBuf[contextLen + i] = pred;
      }

      for (let i = 0; i < gapLen; i++) {
        const t = gapLen > 1 ? i / (gapLen - 1) : 0.5;
        const w = 0.5 - 0.5 * Math.cos(Math.PI * t);
        const fwdSample = fwdBuf[contextLen + i]!;
        const bwdSample = bwdBuf[contextLen + gapLen - 1 - i]!;
        corrected[gapStart + i] = fwdSample * (1 - w) + bwdSample * w;
      }
    }
  }

  return { corrected, clicks };
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));

function getOpt(name: string, def: number): number {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseFloat(arg.split('=')[1]!) : def;
}

const arOrder = getOpt('order', 12);
const frameSize = getOpt('frame', 512);
const hopSize = getOpt('hop', 256);
const detThreshDb = getOpt('threshold', 20);
const powerClip = getOpt('power-clip', 10);
const maxClickLen = getOpt('max-click', 32);
const minAsymmetry = getOpt('min-asymmetry', 0.3);

if (!filePath) {
  console.error('Usage: bun run tools/ar-declicker.ts <input.wav> [options]');
  process.exit(1);
}

const buffer = readFileSync(filePath);
const wav = parseWav(buffer);
const n = Math.floor(wav.samples.length / wav.channels);

console.log(`\nAR Model-Based Declicker: ${filePath}`);
console.log(`  ${wav.sampleRate}Hz, ${wav.channels}ch, ${(n / wav.sampleRate).toFixed(2)}s`);
console.log(`  AR order: ${arOrder}`);
console.log(`  Frame: ${frameSize}, Hop: ${hopSize}`);
console.log(`  Detection threshold: ${detThreshDb} dB above robust noise floor`);
console.log(`  Power estimation clip: ${powerClip}x median`);
console.log(`  Max click: ${maxClickLen} samples`);
console.log(`  Min asymmetry: ${minAsymmetry} (0=allow all, 1=only perfect bilateral)`);

const channels: Float32Array[] = [];
for (let ch = 0; ch < wav.channels; ch++) {
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = wav.samples[i * wav.channels + ch]!;
  channels.push(data);
}

const crossChannel = getOpt('no-cross', 0) === 0;
const crossTolerance = getOpt('cross-tolerance', 16); // samples proximity for cross-channel match

const t0 = performance.now();

// Step 1: Detect clicks in each channel independently
const perChannelClicks: ClickEvent[][] = [];
for (let ch = 0; ch < wav.channels; ch++) {
  const result = arDeclick(channels[ch]!, wav.sampleRate, {
    arOrder,
    frameSize,
    hopSize,
    detectionThresholdDb: detThreshDb,
    powerEstClip: powerClip,
    maxClickLen,
    minAsymmetry,
  });
  perChannelClicks.push(result.clicks);
}

// Step 2: Cross-channel confirmation (if stereo)
// A capture artifact affects both channels — require clicks in both channels
// within ±crossTolerance samples of each other
let confirmedClicks: ClickEvent[];
if (crossChannel && wav.channels >= 2) {
  confirmedClicks = [];
  const ch1Clicks = perChannelClicks[1]!;
  for (const c0 of perChannelClicks[0]!) {
    const match = ch1Clicks.find((c1) => Math.abs(c1.position - c0.position) <= crossTolerance);
    if (match) {
      // Merge: take the union of both extents
      const start = Math.min(c0.position, match.position);
      const end = Math.max(c0.position + c0.length, match.position + match.length);
      confirmedClicks.push({
        ...c0,
        position: start,
        length: end - start,
      });
    }
  }
  // Deduplicate overlapping confirmed clicks
  confirmedClicks.sort((a, b) => a.position - b.position);
  const deduped: ClickEvent[] = [];
  for (const c of confirmedClicks) {
    const last = deduped[deduped.length - 1];
    if (last && c.position < last.position + last.length + 4) {
      // Merge with previous
      const end = Math.max(last.position + last.length, c.position + c.length);
      last.length = end - last.position;
      last.fwdError = Math.max(last.fwdError, c.fwdError);
      last.bwdError = Math.max(last.bwdError, c.bwdError);
    } else {
      deduped.push({ ...c });
    }
  }
  confirmedClicks = deduped;
} else {
  confirmedClicks = perChannelClicks[0]!;
}

// Step 3: Repair confirmed clicks in all channels
const correctedChannels: Float32Array[] = channels.map((ch) => new Float32Array(ch));
let totalClicks = confirmedClicks.length;
let totalSamplesFixed = 0;

const allClicks: ClickEvent[][] = [confirmedClicks];

for (const click of confirmedClicks) {
  totalSamplesFixed += click.length;
  for (let ch = 0; ch < wav.channels; ch++) {
    const mono = channels[ch]!;
    const corrected = correctedChannels[ch]!;
    const gapStart = click.position;
    const gapEnd = click.position + click.length;
    const gapLen = click.length;
    const hermiteMaxLen = 8;

    if (gapStart < 3 || gapEnd > mono.length - 3) continue;

    if (gapLen <= hermiteMaxLen) {
      const a0 = gapStart - 1;
      const a1 = gapEnd;
      const span = a1 - a0;
      if (span <= 1) continue;
      const v0 = mono[a0]!;
      const v1 = mono[a1]!;
      const d0 = (mono[a0]! - mono[Math.max(0, a0 - 2)]!) * 0.5;
      const d1 = (mono[Math.min(mono.length - 1, a1 + 2)]! - mono[a1]!) * 0.5;
      for (let k = gapStart; k < gapEnd; k++) {
        const t = (k - a0) / span;
        const t2 = t * t,
          t3 = t2 * t;
        corrected[k] =
          (2 * t3 - 3 * t2 + 1) * v0 +
          (t3 - 2 * t2 + t) * (d0 * span) +
          (-2 * t3 + 3 * t2) * v1 +
          (t3 - t2) * (d1 * span);
      }
    } else {
      const contextLen = 512;
      if (gapStart < contextLen + arOrder || gapEnd > mono.length - contextLen - arOrder) continue;
      const fwdA = burgAR(mono, gapStart - contextLen, contextLen, arOrder);
      const fwdBuf = new Float32Array(contextLen + gapLen);
      for (let i = 0; i < contextLen; i++) fwdBuf[i] = mono[gapStart - contextLen + i]!;
      for (let i = 0; i < gapLen; i++) {
        let pred = 0;
        for (let j = 1; j <= arOrder; j++) {
          const idx = contextLen + i - j;
          if (idx >= 0) pred -= fwdA[j]! * fwdBuf[idx]!;
        }
        fwdBuf[contextLen + i] = pred;
      }
      const postContext = new Float32Array(contextLen);
      for (let i = 0; i < contextLen; i++) postContext[i] = mono[gapEnd + contextLen - 1 - i]!;
      const bwdA = burgAR(postContext, 0, contextLen, arOrder);
      const bwdBuf = new Float32Array(contextLen + gapLen);
      for (let i = 0; i < contextLen; i++) bwdBuf[i] = mono[gapEnd + contextLen - 1 - i]!;
      for (let i = 0; i < gapLen; i++) {
        let pred = 0;
        for (let j = 1; j <= arOrder; j++) {
          const idx = contextLen + i - j;
          if (idx >= 0) pred -= bwdA[j]! * bwdBuf[idx]!;
        }
        bwdBuf[contextLen + i] = pred;
      }
      for (let i = 0; i < gapLen; i++) {
        const t = gapLen > 1 ? i / (gapLen - 1) : 0.5;
        const w = 0.5 - 0.5 * Math.cos(Math.PI * t);
        corrected[gapStart + i] =
          fwdBuf[contextLen + i]! * (1 - w) + bwdBuf[contextLen + gapLen - 1 - i]! * w;
      }
    }
  }
}

const elapsed = performance.now() - t0;
const durationSec = n / wav.sampleRate;

console.log(`  Cross-channel: ${crossChannel} (tolerance: ±${crossTolerance} samples)`);

console.log(
  `\n═══ Results (${elapsed.toFixed(0)}ms, ${(durationSec / (elapsed / 1000)).toFixed(0)}x realtime) ═══`,
);
console.log(
  `  Per-channel detections: ch0=${perChannelClicks[0]!.length}${wav.channels >= 2 ? `, ch1=${perChannelClicks[1]!.length}` : ''}`,
);
console.log(
  `  Cross-channel confirmed: ${totalClicks} (${(totalClicks / durationSec).toFixed(1)}/sec)`,
);
console.log(`  Samples repaired: ${totalSamplesFixed} total`);

if (confirmedClicks.length > 0) {
  const ch0 = confirmedClicks;
  const avgLen = ch0.reduce((s, c) => s + c.length, 0) / ch0.length;
  const asymmetries = ch0.map((c) => c.asymmetry).sort((a, b) => a - b);
  const p = (arr: number[], pct: number) =>
    arr[Math.min(Math.floor((arr.length * pct) / 100), arr.length - 1)]!;

  console.log(`\n  Confirmed click stats:`);
  console.log(`    Avg click length: ${avgLen.toFixed(1)} samples`);
  console.log(
    `    Asymmetry (min fwd/bwd): P25=${p(asymmetries, 25).toFixed(2)}, P50=${p(asymmetries, 50).toFixed(2)}, P75=${p(asymmetries, 75).toFixed(2)}`,
  );

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

  console.log(`\n  Confirmed clicks by time region:`);
  for (const r of regions) {
    const inRegion = ch0.filter((c) => {
      const timeSec = c.position / wav.sampleRate;
      return timeSec >= r.start && timeSec < r.end;
    });
    if (inRegion.length > 0) {
      console.log(`    ${r.label.padEnd(8)}: ${String(inRegion.length).padStart(4)} clicks`);
    }
  }

  // Show first clicks with asymmetry info
  console.log(`\n  First ${Math.min(30, ch0.length)} confirmed clicks:`);
  console.log('  Position    |  Time(ms) | Len | FwdErr   | BwdErr   | Asym  | Thresh');
  console.log('  ' + '-'.repeat(80));
  for (const c of ch0.slice(0, 30)) {
    const timeMs = ((c.position / wav.sampleRate) * 1000).toFixed(1);
    console.log(
      `  ${String(c.position).padStart(10)} | ${timeMs.padStart(9)} | ${String(c.length).padStart(3)} | ${c.fwdError.toFixed(5).padStart(8)} | ${c.bwdError.toFixed(5).padStart(8)} | ${c.asymmetry.toFixed(2).padStart(5)} | ${c.threshold.toFixed(5).padStart(8)}`,
    );
  }
}

// Smoothness comparison
let origD = 0,
  corrD = 0;
for (let i = 2; i < n; i++) {
  if (Math.abs(channels[0]![i]! - 2 * channels[0]![i - 1]! + channels[0]![i - 2]!) > 0.005) origD++;
  if (
    Math.abs(
      correctedChannels[0]![i]! - 2 * correctedChannels[0]![i - 1]! + correctedChannels[0]![i - 2]!,
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
    outSamples[i * wav.channels + ch] = correctedChannels[ch]![i]!;
  }
}

const dir = dirname(resolve(filePath));
const base = basename(filePath, '.wav');
const outPath = resolve(dir, `${base}-ar-fixed.wav`);
writeWavFloat32(outPath, outSamples, wav.sampleRate, wav.channels);
console.log(`\n  Output: ${outPath}`);
