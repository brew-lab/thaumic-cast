/**
 * Track instantaneous phase/frequency of a sine wave to find glitches.
 * For a pure sine, consecutive sample phase increments should be constant.
 * Any deviation = artifact.
 *
 * Also works on music via analytic signal (Hilbert transform).
 */
import { readFileSync } from 'fs';

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

const filePath = process.argv[2];
if (!filePath) {
  console.error('Usage: bun run tools/sine-phase-tracker.ts <input.wav>');
  process.exit(1);
}

const wav = parseWav(readFileSync(filePath));
const n = Math.floor(wav.samples.length / wav.channels);
const sr = wav.sampleRate;

const ch0 = new Float32Array(n);
for (let i = 0; i < n; i++) ch0[i] = wav.samples[i * wav.channels]!;

console.log(`Phase Tracker: ${filePath}`);
console.log(`  ${sr}Hz, ${wav.channels}ch, ${(n / sr).toFixed(2)}s\n`);

// ── Method 1: d2 (second derivative) analysis ──────────────────────────────
// For a sine wave, d2 should also be sinusoidal. Artifacts create d2 spikes.
// For music, d2 indicates curvature changes.
//
// More specifically: compute the "curvature error" — how much d2 deviates
// from the locally expected d2 pattern.

// ── Method 2: Local curvature consistency ────────────────────────────────────
// Compute d2 and track its envelope. A kink/glitch creates a sudden d2 spike
// relative to the local d2 envelope.

const d2 = new Float64Array(n);
for (let i = 1; i < n - 1; i++) {
  d2[i] = ch0[i + 1]! - 2 * ch0[i]! + ch0[i - 1]!;
}

// Compute local d2 envelope using sliding RMS
const envWindow = 64;
const d2Env = new Float64Array(n);
for (let i = envWindow; i < n - envWindow; i++) {
  let sum = 0;
  for (let j = -envWindow; j <= envWindow; j++) {
    sum += d2[i + j]! * d2[i + j]!;
  }
  d2Env[i] = Math.sqrt(sum / (2 * envWindow + 1));
}

// Find curvature anomalies: |d2| >> local d2 envelope
// This catches kinks where the curvature suddenly spikes
interface CurvatureAnomaly {
  position: number;
  timeSec: number;
  d2Value: number;
  d2Envelope: number;
  ratio: number;
}

const anomalies: CurvatureAnomaly[] = [];
const minRatio = 3.0; // d2 must be 3x the local envelope
const skipSilence = 1000; // skip first N samples (may be silence/startup)

// Find start of actual audio (skip silence)
let audioStart = 0;
for (let i = 0; i < n; i++) {
  if (Math.abs(ch0[i]!) > 0.01) {
    audioStart = i;
    break;
  }
}
console.log(`  Audio starts at sample ${audioStart} (${(audioStart / sr).toFixed(3)}s)`);

for (let i = Math.max(audioStart + envWindow, envWindow); i < n - envWindow; i++) {
  if (d2Env[i]! < 1e-6) continue; // silence
  const ratio = Math.abs(d2[i]!) / d2Env[i]!;
  if (ratio > minRatio) {
    anomalies.push({
      position: i,
      timeSec: i / sr,
      d2Value: d2[i]!,
      d2Envelope: d2Env[i]!,
      ratio,
    });
  }
}

// Cluster nearby anomalies
interface AnomalyCluster {
  start: number;
  end: number;
  maxRatio: number;
  count: number;
  timeSec: number;
}

const clusters: AnomalyCluster[] = [];
for (const a of anomalies) {
  const last = clusters[clusters.length - 1];
  if (last && a.position - last.end < 32) {
    last.end = a.position;
    last.maxRatio = Math.max(last.maxRatio, a.ratio);
    last.count++;
  } else {
    clusters.push({
      start: a.position,
      end: a.position,
      maxRatio: a.ratio,
      count: 1,
      timeSec: a.position / sr,
    });
  }
}

console.log(`\n═══ Curvature Anomalies (d2 > ${minRatio}x local envelope) ═══`);
console.log(`  Raw anomaly samples: ${anomalies.length}`);
console.log(`  Clustered events: ${clusters.length}\n`);

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

for (const r of regions) {
  const inRegion = clusters.filter((c) => c.timeSec >= r.start && c.timeSec < r.end);
  if (inRegion.length > 0) {
    console.log(`  ${r.label.padEnd(8)}: ${String(inRegion.length).padStart(4)} events`);
  }
}

// Show top events by ratio
const sorted = [...clusters].sort((a, b) => b.maxRatio - a.maxRatio);
console.log(`\n  Top 20 events by curvature ratio:`);
console.log('  Time(s)   | Pos       | Span | MaxRatio | Count | Samples');
console.log('  ' + '-'.repeat(90));

for (const c of sorted.slice(0, 20)) {
  const span = c.end - c.start + 1;
  const ctx = 4;
  const before = Array.from({ length: ctx }, (_, k) => ch0[c.start - ctx + k]?.toFixed(4) ?? '?');
  const during = Array.from(
    { length: Math.min(span, 6) },
    (_, k) => ch0[c.start + k]?.toFixed(4) ?? '?',
  );
  const after = Array.from({ length: ctx }, (_, k) => ch0[c.end + 1 + k]?.toFixed(4) ?? '?');
  console.log(
    `  ${c.timeSec.toFixed(4).padStart(9)} | ${String(c.start).padStart(9)} | ${String(span).padStart(4)} | ${c.maxRatio.toFixed(1).padStart(8)} | ${String(c.count).padStart(5)} | [${before.join(',')}] |${during.join(',')}${span > 6 ? '...' : ''}| [${after.join(',')}]`,
  );
}

// Detailed dump of top 3
console.log(`\n═══ Detailed Dump (top 3 events) ═══`);
for (const c of sorted.slice(0, 3)) {
  const margin = 10;
  console.log(
    `\n  Event at ${c.timeSec.toFixed(4)}s (pos=${c.start}, span=${c.end - c.start + 1}, ratio=${c.maxRatio.toFixed(1)}):`,
  );
  console.log('  Offset | Sample     | d1         | d2         | d2/env     | Note');
  console.log('  ' + '-'.repeat(75));
  for (let i = c.start - margin; i <= c.end + margin; i++) {
    const val = ch0[i]?.toFixed(6) ?? '?';
    const d1v = i > 0 ? (ch0[i]! - ch0[i - 1]!).toFixed(6) : '?';
    const d2v = d2[i]?.toFixed(6) ?? '?';
    const ratio = d2Env[i]! > 1e-8 ? (Math.abs(d2[i]!) / d2Env[i]!).toFixed(2) : '?';
    let note = '';
    if (i === c.start) note = '<-- start';
    if (i === c.end) note = '<-- end';
    console.log(
      `  ${String(i - c.start).padStart(6)} | ${val.padStart(10)} | ${String(d1v).padStart(10)} | ${String(d2v).padStart(10)} | ${String(ratio).padStart(10)} | ${note}`,
    );
  }
}
