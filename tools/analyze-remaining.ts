/**
 * Diagnostic analysis of remaining discontinuities in the repaired WAV file.
 *
 * Finds all samples where |s[i] - 2*s[i-1] + s[i-2]| > 0.005 (2nd derivative),
 * reports quantum boundary alignment, clusters, and histograms.
 *
 * Usage:
 *   bun run tools/analyze-remaining.ts
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';

// ── WAV Parser (minimal, from envelope-smooth.ts) ────────────────────────────

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

// ── Analysis ─────────────────────────────────────────────────────────────────

const THRESHOLD = 0.005;
const QUANTUM = 128;
const BOUNDARY_TOLERANCE = 4; // within +-4 samples of a quantum boundary
const CLUSTER_GAP = 20; // consecutive within 20 samples = same cluster

const wavPath = resolve(import.meta.dir, 'pcm-capture-float32-input-bad-repaired.wav');
const wav = parseWav(readFileSync(wavPath));
const { samples, channels, sampleRate } = wav;

console.log(`WAV: ${sampleRate} Hz, ${channels} ch, ${samples.length} total samples`);
console.log(
  `     ${samples.length / channels} frames, duration ${(samples.length / channels / sampleRate).toFixed(2)}s`,
);
console.log(`     Quantum = ${QUANTUM} interleaved samples = ${QUANTUM / channels} frames/ch`);
console.log();

// We analyze per-channel to keep quantum alignment meaningful.
// Interleaved: sample index i belongs to channel (i % channels),
// and its per-channel frame index is floor(i / channels).
// Quantum boundaries in interleaved space: multiples of (QUANTUM * channels) = 256 for stereo.

// But the 2nd derivative is most meaningful on per-channel data.
// De-interleave first.

const framesPerChannel = Math.floor(samples.length / channels);
const channelData: Float32Array[] = [];
for (let ch = 0; ch < channels; ch++) {
  const data = new Float32Array(framesPerChannel);
  for (let f = 0; f < framesPerChannel; f++) {
    data[f] = samples[f * channels + ch]!;
  }
  channelData.push(data);
}

interface Discontinuity {
  channel: number;
  frameIndex: number;
  mod128: number;
  d2: number;
  nearBoundary: boolean;
  sampleValue: number;
}

const allDisc: Discontinuity[] = [];

for (let ch = 0; ch < channels; ch++) {
  const data = channelData[ch]!;
  for (let i = 2; i < data.length; i++) {
    const d2 = Math.abs(data[i]! - 2 * data[i - 1]! + data[i - 2]!);
    if (d2 > THRESHOLD) {
      const mod128 = i % QUANTUM;
      // Near boundary = within BOUNDARY_TOLERANCE of a multiple of 128
      const distToBoundary = Math.min(mod128, QUANTUM - mod128);
      allDisc.push({
        channel: ch,
        frameIndex: i,
        mod128,
        d2,
        nearBoundary: distToBoundary <= BOUNDARY_TOLERANCE,
        sampleValue: data[i]!,
      });
    }
  }
}

console.log(`Total discontinuities (|d2| > ${THRESHOLD}): ${allDisc.length}`);
console.log();

// ── Per-channel breakdown ────────────────────────────────────────────────────

for (let ch = 0; ch < channels; ch++) {
  const chDisc = allDisc.filter((d) => d.channel === ch);
  const nearBound = chDisc.filter((d) => d.nearBoundary).length;
  console.log(
    `  Channel ${ch}: ${chDisc.length} discontinuities (${nearBound} near quantum boundary)`,
  );
}
console.log();

// ── Detailed listing (first 40 + last 10) ────────────────────────────────────

// Sort by frame index then channel
const sorted = [...allDisc].sort((a, b) => a.frameIndex - b.frameIndex || a.channel - b.channel);

console.log('─── Sample Details (first 40) ───────────────────────────────────────');
console.log('  ch  | frame idx |  mod128 | near boundary |    d2 value   | sample val');
console.log('------+-----------+---------+---------------+---------------+-----------');

const showCount = Math.min(40, sorted.length);
for (let i = 0; i < showCount; i++) {
  const d = sorted[i]!;
  console.log(
    `  ${d.channel}   | ${String(d.frameIndex).padStart(9)} | ${String(d.mod128).padStart(7)} | ${d.nearBoundary ? '     YES       ' : '      no       '} | ${d.d2.toFixed(6).padStart(13)} | ${d.sampleValue.toFixed(6)}`,
  );
}

if (sorted.length > 50) {
  console.log(`  ... (${sorted.length - 50} more) ...`);
  console.log('─── Last 10 ────────────────────────────────────────────────────────');
  for (let i = sorted.length - 10; i < sorted.length; i++) {
    const d = sorted[i]!;
    console.log(
      `  ${d.channel}   | ${String(d.frameIndex).padStart(9)} | ${String(d.mod128).padStart(7)} | ${d.nearBoundary ? '     YES       ' : '      no       '} | ${d.d2.toFixed(6).padStart(13)} | ${d.sampleValue.toFixed(6)}`,
    );
  }
}
console.log();

// ── Clustering ───────────────────────────────────────────────────────────────

// Cluster per channel separately
console.log('─── Clusters (per channel, gap <= 20 frames) ─────────────────────');

interface Cluster {
  channel: number;
  startFrame: number;
  endFrame: number;
  count: number;
  maxD2: number;
}

const clusters: Cluster[] = [];

for (let ch = 0; ch < channels; ch++) {
  const chDisc = allDisc
    .filter((d) => d.channel === ch)
    .sort((a, b) => a.frameIndex - b.frameIndex);
  if (chDisc.length === 0) continue;

  let clusterStart = chDisc[0]!.frameIndex;
  let clusterEnd = clusterStart;
  let count = 1;
  let maxD2 = chDisc[0]!.d2;

  for (let i = 1; i < chDisc.length; i++) {
    const d = chDisc[i]!;
    if (d.frameIndex - clusterEnd <= CLUSTER_GAP) {
      clusterEnd = d.frameIndex;
      count++;
      maxD2 = Math.max(maxD2, d.d2);
    } else {
      clusters.push({ channel: ch, startFrame: clusterStart, endFrame: clusterEnd, count, maxD2 });
      clusterStart = d.frameIndex;
      clusterEnd = d.frameIndex;
      count = 1;
      maxD2 = d.d2;
    }
  }
  clusters.push({ channel: ch, startFrame: clusterStart, endFrame: clusterEnd, count, maxD2 });
}

console.log(`  Total clusters: ${clusters.length}`);
console.log();

// Cluster size histogram
const sizeHist = new Map<number, number>();
for (const c of clusters) {
  sizeHist.set(c.count, (sizeHist.get(c.count) ?? 0) + 1);
}
console.log('  Cluster size histogram:');
for (const [size, freq] of [...sizeHist.entries()].sort((a, b) => a[0] - b[0])) {
  console.log(`    size ${String(size).padStart(3)}: ${'#'.repeat(Math.min(freq, 60))} (${freq})`);
}
console.log();

// Show each cluster
console.log('  ch | start frame | end frame |  span | count | max d2');
console.log('  ---+-------------+-----------+-------+-------+--------');
for (const c of clusters.sort((a, b) => a.startFrame - b.startFrame || a.channel - b.channel)) {
  const span = c.endFrame - c.startFrame + 1;
  console.log(
    `   ${c.channel} | ${String(c.startFrame).padStart(11)} | ${String(c.endFrame).padStart(9)} | ${String(span).padStart(5)} | ${String(c.count).padStart(5)} | ${c.maxD2.toFixed(6)}`,
  );
}
console.log();

// ── d2 value histogram ──────────────────────────────────────────────────────

console.log('─── d2 Value Histogram ─────────────────────────────────────────────');
const d2Buckets = [0.005, 0.01, 0.02, 0.03, 0.05, 0.1, 0.2, 0.5, 1.0, Infinity];
const d2BucketLabels = [
  '0.005-0.010',
  '0.010-0.020',
  '0.020-0.030',
  '0.030-0.050',
  '0.050-0.100',
  '0.100-0.200',
  '0.200-0.500',
  '0.500-1.000',
  '1.000+',
];
const d2Hist = new Array(d2Buckets.length - 1).fill(0) as number[];

for (const d of allDisc) {
  for (let b = 0; b < d2Buckets.length - 1; b++) {
    if (d.d2 >= d2Buckets[b]! && d.d2 < d2Buckets[b + 1]!) {
      d2Hist[b]++;
      break;
    }
  }
}

const maxHist = Math.max(...d2Hist);
for (let b = 0; b < d2Hist.length; b++) {
  const bar = '#'.repeat(Math.round((d2Hist[b]! / maxHist) * 50));
  console.log(`  ${d2BucketLabels[b]!.padEnd(12)}: ${bar} (${d2Hist[b]})`);
}
console.log();

// ── mod-128 offset histogram ────────────────────────────────────────────────

console.log('─── mod-128 Offset Histogram ───────────────────────────────────────');
const mod128Hist = new Array(QUANTUM).fill(0) as number[];
for (const d of allDisc) {
  mod128Hist[d.mod128]++;
}

// Only show non-zero buckets, grouped
const nonZero = mod128Hist.map((count, offset) => ({ offset, count })).filter((x) => x.count > 0);

const maxMod = Math.max(...nonZero.map((x) => x.count));
for (const { offset, count } of nonZero) {
  const distToBoundary = Math.min(offset, QUANTUM - offset);
  const marker = distToBoundary <= BOUNDARY_TOLERANCE ? ' <-- near boundary' : '';
  const bar = '#'.repeat(Math.round((count / maxMod) * 40));
  console.log(`  offset ${String(offset).padStart(3)}: ${bar} (${count})${marker}`);
}
console.log();

// ── Summary statistics ──────────────────────────────────────────────────────

const nearBoundaryCount = allDisc.filter((d) => d.nearBoundary).length;
const awayFromBoundaryCount = allDisc.length - nearBoundaryCount;
const d2Values = allDisc.map((d) => d.d2).sort((a, b) => a - b);
const median = d2Values[Math.floor(d2Values.length / 2)]!;
const mean = d2Values.reduce((s, v) => s + v, 0) / d2Values.length;
const max = d2Values[d2Values.length - 1]!;
const min = d2Values[0]!;
const p90 = d2Values[Math.floor(d2Values.length * 0.9)]!;
const p99 = d2Values[Math.floor(d2Values.length * 0.99)]!;

console.log('─── Summary ────────────────────────────────────────────────────────');
console.log(`  Total discontinuities:    ${allDisc.length}`);
console.log(
  `  Near quantum boundary:    ${nearBoundaryCount} (${((100 * nearBoundaryCount) / allDisc.length).toFixed(1)}%)`,
);
console.log(
  `  Away from boundary:       ${awayFromBoundaryCount} (${((100 * awayFromBoundaryCount) / allDisc.length).toFixed(1)}%)`,
);
console.log();
console.log(`  d2 stats:`);
console.log(`    min:    ${min.toFixed(6)}`);
console.log(`    median: ${median.toFixed(6)}`);
console.log(`    mean:   ${mean.toFixed(6)}`);
console.log(`    p90:    ${p90.toFixed(6)}`);
console.log(`    p99:    ${p99.toFixed(6)}`);
console.log(`    max:    ${max.toFixed(6)}`);
