/**
 * Coherence-based Declicker
 *
 * Instead of looking at individual sample derivatives, this looks for short
 * intervals where the signal becomes incoherent with its local context.
 *
 * A buffer dropout in music creates a brief moment where the waveform
 * doesn't match the spectral content before/after it. We detect this by:
 *
 * 1. Computing short-time autocorrelation (signal's similarity to itself)
 * 2. A click/dropout causes a dip in local autocorrelation
 * 3. Cross-fading to interpolated signal at those points
 *
 * Also uses a simpler approach: looking for samples where the 1st derivative
 * reverses direction more rapidly than expected (zig-zag pattern = click).
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

// ─── Zero-crossing rate anomaly detection ────────────────────────────────────

interface ClickEvent {
  position: number;
  length: number;
  type: string;
  score: number;
}

/**
 * Detect clicks by finding short regions where the signal has anomalous
 * zero-crossing rate or d1-reversal rate compared to surrounding context.
 *
 * A click introduces high-frequency energy that manifests as rapid
 * sign changes in the first derivative.
 */
function detectByD1Reversals(
  L: Float32Array,
  R: Float32Array,
  n: number,
  sampleRate: number,
): ClickEvent[] {
  const events: ClickEvent[] = [];

  // Compute d1 for both channels
  const d1L = new Float32Array(n);
  const d1R = new Float32Array(n);
  for (let i = 1; i < n; i++) {
    d1L[i] = L[i]! - L[i - 1]!;
    d1R[i] = R[i]! - R[i - 1]!;
  }

  // Compute d1-reversal indicator: 1 when d1 changes sign
  const revL = new Uint8Array(n);
  const revR = new Uint8Array(n);
  for (let i = 2; i < n; i++) {
    if (d1L[i]! * d1L[i - 1]! < 0) revL[i] = 1;
    if (d1R[i]! * d1R[i - 1]! < 0) revR[i] = 1;
  }

  // Compute d1-reversal density in short and long windows
  const shortHalf = 16; // ~0.33ms
  const longHalf = 256; // ~5.3ms

  // Cumulative sums for fast window queries
  const cumRevL = new Uint32Array(n + 1);
  const cumRevR = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumRevL[i + 1] = cumRevL[i]! + revL[i]!;
    cumRevR[i + 1] = cumRevR[i]! + revR[i]!;
  }

  function revDensity(cum: Uint32Array, center: number, half: number): number {
    const lo = Math.max(0, center - half);
    const hi = Math.min(n, center + half);
    return (cum[hi]! - cum[lo]!) / (hi - lo);
  }

  // Also need local RMS to skip quiet sections
  const cumSqL = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cumSqL[i + 1] = cumSqL[i]! + L[i]! * L[i]!;

  function localRms(center: number, half: number): number {
    const lo = Math.max(0, center - half);
    const hi = Math.min(n, center + half);
    return Math.sqrt((cumSqL[hi]! - cumSqL[lo]!) / (hi - lo));
  }

  // Scan for anomalous reversal density
  for (let i = longHalf + shortHalf; i < n - longHalf - shortHalf; i++) {
    const rms = localRms(i, 256);
    if (rms < 0.01) continue; // skip quiet

    const shortDensL = revDensity(cumRevL, i, shortHalf);
    const longDensL = revDensity(cumRevL, i, longHalf);
    const shortDensR = revDensity(cumRevR, i, shortHalf);
    const longDensR = revDensity(cumRevR, i, longHalf);

    // Both channels must have elevated short-term reversal density
    const ratioL = longDensL > 0.01 ? shortDensL / longDensL : 0;
    const ratioR = longDensR > 0.01 ? shortDensR / longDensR : 0;

    // A click causes the short-window reversal rate to spike well above
    // the long-window rate. Threshold: 2x means the local 32-sample window
    // has twice the reversal rate of the surrounding 512-sample window.
    if (ratioL > 2.0 && ratioR > 2.0 && shortDensL > 0.4 && shortDensR > 0.4) {
      events.push({
        position: i,
        length: 1,
        type: 'd1-reversal',
        score: Math.min(ratioL, ratioR),
      });
      i += shortHalf; // skip forward
    }
  }

  return events;
}

/**
 * Detect clicks by finding short regions where the local autocorrelation
 * at lag-1 drops significantly. Normal music has high lag-1 autocorrelation
 * (adjacent samples are highly correlated). A click disrupts this.
 */
function detectByAutocorrelationDrop(
  L: Float32Array,
  R: Float32Array,
  n: number,
  sampleRate: number,
): ClickEvent[] {
  const events: ClickEvent[] = [];
  const windowSize = 32; // ~0.67ms
  const hopSize = 8;
  const contextHalf = 16; // windows before/after for baseline

  // Compute lag-1 autocorrelation in sliding windows
  const numWindows = Math.floor((n - windowSize) / hopSize);
  const acL = new Float64Array(numWindows);
  const acR = new Float64Array(numWindows);

  for (let w = 0; w < numWindows; w++) {
    const start = w * hopSize;
    let sumProd = 0,
      sumSq = 0;
    for (let i = start; i < start + windowSize - 1; i++) {
      sumProd += L[i]! * L[i + 1]!;
      sumSq += L[i]! * L[i]!;
    }
    sumSq += L[start + windowSize - 1]! * L[start + windowSize - 1]!;
    acL[w] = sumSq > 1e-10 ? sumProd / sumSq : 1;

    sumProd = 0;
    sumSq = 0;
    for (let i = start; i < start + windowSize - 1; i++) {
      sumProd += R[i]! * R[i + 1]!;
      sumSq += R[i]! * R[i]!;
    }
    sumSq += R[start + windowSize - 1]! * R[start + windowSize - 1]!;
    acR[w] = sumSq > 1e-10 ? sumProd / sumSq : 1;
  }

  // Find windows where autocorrelation drops significantly vs neighbors
  for (let w = contextHalf; w < numWindows - contextHalf; w++) {
    // Local baseline: median of surrounding windows
    const contextValsL: number[] = [];
    const contextValsR: number[] = [];
    for (let j = w - contextHalf; j <= w + contextHalf; j++) {
      if (j !== w) {
        contextValsL.push(acL[j]!);
        contextValsR.push(acR[j]!);
      }
    }
    contextValsL.sort((a, b) => a - b);
    contextValsR.sort((a, b) => a - b);
    const baselineL = contextValsL[Math.floor(contextValsL.length / 2)]!;
    const baselineR = contextValsR[Math.floor(contextValsR.length / 2)]!;

    // Only flag when both channels show a drop
    const dropL = baselineL - acL[w]!;
    const dropR = baselineR - acR[w]!;

    if (dropL > 0.15 && dropR > 0.15 && baselineL > 0.8 && baselineR > 0.8) {
      const samplePos = w * hopSize + windowSize / 2;
      events.push({
        position: samplePos,
        length: windowSize,
        type: 'ac-drop',
        score: Math.min(dropL, dropR),
      });
      w += 2; // skip forward
    }
  }

  return events;
}

// ─── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));

if (!filePath) {
  console.error('Usage: bun run tools/coherence-declicker.ts <input.wav>');
  process.exit(1);
}

const buffer = readFileSync(filePath);
const wav = parseWav(buffer);
const n = Math.floor(wav.samples.length / wav.channels);

const L = new Float32Array(n);
const R = new Float32Array(n);
for (let i = 0; i < n; i++) {
  L[i] = wav.samples[i * wav.channels]!;
  R[i] = wav.samples[i * wav.channels + 1]!;
}

console.log(`\nCoherence Declicker: ${filePath}`);
console.log(`  ${wav.sampleRate}Hz, ${wav.channels}ch, ${(n / wav.sampleRate).toFixed(2)}s`);

const t0 = performance.now();

// Run both detectors
const d1Events = detectByD1Reversals(L, R, n, wav.sampleRate);
const acEvents = detectByAutocorrelationDrop(L, R, n, wav.sampleRate);

const elapsed = performance.now() - t0;
console.log(`\n═══ Detection (${elapsed.toFixed(0)}ms) ═══`);
console.log(`  d1-reversal events: ${d1Events.length}`);
console.log(`  ac-drop events: ${acEvents.length}`);

// Merge and deduplicate
const allEvents = [...d1Events, ...acEvents];
allEvents.sort((a, b) => a.position - b.position);

// Cluster nearby events
interface Cluster {
  start: number;
  end: number;
  types: Set<string>;
  maxScore: number;
}
const clusters: Cluster[] = [];
let ci = 0;
while (ci < allEvents.length) {
  const start = allEvents[ci]!.position;
  let end = start + allEvents[ci]!.length;
  const types = new Set<string>([allEvents[ci]!.type]);
  let maxScore = allEvents[ci]!.score;

  while (ci + 1 < allEvents.length && allEvents[ci + 1]!.position < end + 64) {
    ci++;
    end = Math.max(end, allEvents[ci]!.position + allEvents[ci]!.length);
    types.add(allEvents[ci]!.type);
    maxScore = Math.max(maxScore, allEvents[ci]!.score);
  }
  clusters.push({ start, end, types, maxScore });
  ci++;
}

console.log(`  Clusters: ${clusters.length}`);
const bothTypes = clusters.filter((c) => c.types.size > 1);
console.log(`  Both detectors agree: ${bothTypes.length}`);

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

console.log(`\n  Clusters by time region:`);
for (const r of regions) {
  const inRegion = clusters.filter((c) => {
    const timeSec = c.start / wav.sampleRate;
    return timeSec >= r.start && timeSec < r.end;
  });
  if (inRegion.length > 0) {
    const both = inRegion.filter((c) => c.types.size > 1).length;
    console.log(
      `    ${r.label.padEnd(8)}: ${String(inRegion.length).padStart(4)} clusters (${both} confirmed by both)`,
    );
  }
}

// Apply repair: Hermite interpolation at each cluster
const corrL = new Float32Array(L);
const corrR = new Float32Array(R);

let repaired = 0;
for (const c of clusters) {
  // Only repair clusters confirmed by both detectors, or high-score ones
  if (c.types.size < 2 && c.maxScore < 3.0) continue;

  const repairStart = Math.max(3, c.start - 2);
  const repairEnd = Math.min(n - 3, c.end + 2);
  const repairLen = repairEnd - repairStart;
  if (repairLen > 64) continue; // too long, probably not a click

  const a0 = repairStart - 1;
  const a1 = repairEnd;
  const span = a1 - a0;
  if (span <= 1) continue;

  for (const [sig, corr] of [
    [L, corrL],
    [R, corrR],
  ] as [Float32Array, Float32Array][]) {
    const v0 = sig[a0]!;
    const v1 = sig[a1]!;
    const d0 = (sig[a0]! - sig[Math.max(0, a0 - 2)]!) * 0.5;
    const d1 = (sig[Math.min(n - 1, a1 + 2)]! - sig[a1]!) * 0.5;

    for (let k = repairStart; k < repairEnd; k++) {
      const t = (k - a0) / span;
      corr[k] = hermite(t, v0, v1, d0 * span, d1 * span);
    }
  }
  repaired++;
}

console.log(`\n  Repairs applied: ${repaired}`);

// Smoothness comparison
let origD = 0,
  corrD = 0;
for (let i = 2; i < n; i++) {
  if (Math.abs(L[i]! - 2 * L[i - 1]! + L[i - 2]!) > 0.005) origD++;
  if (Math.abs(corrL[i]! - 2 * corrL[i - 1]! + corrL[i - 2]!) > 0.005) corrD++;
}
console.log(
  `  d² discontinuities: ${origD} → ${corrD} (${origD > 0 ? ((1 - corrD / origD) * 100).toFixed(1) : 0}% reduction)`,
);

// Write output
const outSamples = new Float32Array(n * wav.channels);
for (let i = 0; i < n; i++) {
  outSamples[i * wav.channels] = corrL[i]!;
  outSamples[i * wav.channels + 1] = corrR[i]!;
}

const dir = dirname(resolve(filePath));
const base = basename(filePath, '.wav');
const outPath = resolve(dir, `${base}-coherence-fixed.wav`);
writeWavFloat32(outPath, outSamples, wav.sampleRate, wav.channels);
console.log(`\n  Output: ${outPath}`);
