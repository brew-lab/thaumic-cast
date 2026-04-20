/**
 * Direct sample-by-sample comparison of two WAV files (same song, same timeframe).
 * Finds exactly where they diverge to identify capture artifacts.
 */
import { readFileSync } from 'node:fs';

function parseWav(buf: Buffer): { sampleRate: number; channels: number; samples: Float32Array } {
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  let dataOffset = 36;
  while (buf.toString('ascii', dataOffset, dataOffset + 4) !== 'data') {
    dataOffset += 8 + buf.readUInt32LE(dataOffset + 4);
    if (dataOffset >= buf.length - 8) throw new Error('No data chunk');
  }
  const dataSize = buf.readUInt32LE(dataOffset + 4);
  return {
    sampleRate,
    channels,
    samples: new Float32Array(buf.buffer, buf.byteOffset + dataOffset + 8, dataSize / 4),
  };
}

const badFile = process.argv[2]!;
const goodFile = process.argv[3]!;
const regionStart = parseFloat(process.argv[4] || '0');
const regionEnd = parseFloat(process.argv[5] || '0');

const badWav = parseWav(readFileSync(badFile));
const goodWav = parseWav(readFileSync(goodFile));

const nBad = Math.floor(badWav.samples.length / badWav.channels);
const nGood = Math.floor(goodWav.samples.length / goodWav.channels);
const n = Math.min(nBad, nGood);

console.log(`Bad:  ${nBad} samples (${(nBad / badWav.sampleRate).toFixed(2)}s)`);
console.log(`Good: ${nGood} samples (${(nGood / goodWav.sampleRate).toFixed(2)}s)`);

// Extract L channels
const badL = new Float32Array(n);
const goodL = new Float32Array(n);
const badR = new Float32Array(n);
const goodR = new Float32Array(n);
for (let i = 0; i < n; i++) {
  badL[i] = badWav.samples[i * badWav.channels]!;
  goodL[i] = goodWav.samples[i * goodWav.channels]!;
  badR[i] = badWav.samples[i * badWav.channels + 1]!;
  goodR[i] = goodWav.samples[i * goodWav.channels + 1]!;
}

// First: try to find alignment offset by cross-correlating a short segment
// Use a 1-second window near the start
const corrWindow = Math.min(48000, n);
let bestOffset = 0;
let bestCorr = -Infinity;
const maxLag = 48000; // search ±1 second

console.log(`\nSearching for alignment offset (±${maxLag} samples)...`);

// Compute energy of good reference
let goodEnergy = 0;
for (let i = 0; i < corrWindow; i++) goodEnergy += goodL[i]! * goodL[i]!;

for (let lag = -maxLag; lag <= maxLag; lag++) {
  let corr = 0;
  let count = 0;
  for (let i = 0; i < corrWindow; i++) {
    const gi = i;
    const bi = i + lag;
    if (bi >= 0 && bi < n) {
      corr += goodL[gi]! * badL[bi]!;
      count++;
    }
  }
  if (count > corrWindow * 0.5 && corr > bestCorr) {
    bestCorr = corr;
    bestOffset = lag;
  }
}

console.log(
  `Best alignment offset: ${bestOffset} samples (${((bestOffset / badWav.sampleRate) * 1000).toFixed(1)}ms)`,
);
console.log(`Correlation at best offset: ${bestCorr.toFixed(4)}`);

// Now compute sample differences with alignment
const offset = bestOffset;
const startSample = regionStart > 0 ? Math.floor(regionStart * badWav.sampleRate) : 0;
const endSample = regionEnd > 0 ? Math.min(Math.floor(regionEnd * badWav.sampleRate), n) : n;

console.log(
  `\nAnalyzing region: ${(startSample / badWav.sampleRate).toFixed(2)}s - ${(endSample / badWav.sampleRate).toFixed(2)}s`,
);

// Compute per-sample difference
const diffL = new Float64Array(endSample - startSample);
const diffR = new Float64Array(endSample - startSample);
let totalDiffL = 0,
  totalDiffR = 0;
let maxDiffL = 0,
  maxDiffR = 0;
let maxDiffPosL = 0,
  maxDiffPosR = 0;

for (let i = startSample; i < endSample; i++) {
  const gi = i + offset;
  if (gi < 0 || gi >= n) continue;
  const j = i - startSample;
  diffL[j] = Math.abs(badL[i]! - goodL[gi]!);
  diffR[j] = Math.abs(badR[i]! - goodR[gi]!);
  totalDiffL += diffL[j]!;
  totalDiffR += diffR[j]!;
  if (diffL[j]! > maxDiffL) {
    maxDiffL = diffL[j]!;
    maxDiffPosL = i;
  }
  if (diffR[j]! > maxDiffR) {
    maxDiffR = diffR[j]!;
    maxDiffPosR = i;
  }
}

const regionLen = endSample - startSample;
console.log(`\nOverall difference stats:`);
console.log(
  `  L: avg=${(totalDiffL / regionLen).toFixed(6)}, max=${maxDiffL.toFixed(6)} @${maxDiffPosL} (${((maxDiffPosL / badWav.sampleRate) * 1000).toFixed(1)}ms)`,
);
console.log(
  `  R: avg=${(totalDiffR / regionLen).toFixed(6)}, max=${maxDiffR.toFixed(6)} @${maxDiffPosR} (${((maxDiffPosR / badWav.sampleRate) * 1000).toFixed(1)}ms)`,
);

// Find divergence clusters - regions where diff exceeds threshold
const diffThreshold = 0.01;
interface DivCluster {
  start: number;
  end: number;
  maxDiff: number;
  avgDiff: number;
}
const clusters: DivCluster[] = [];

let ci = startSample;
while (ci < endSample) {
  const j = ci - startSample;
  const gi = ci + offset;
  if (gi < 0 || gi >= n || (diffL[j]! < diffThreshold && diffR[j]! < diffThreshold)) {
    ci++;
    continue;
  }

  const cStart = ci;
  let sumDiff = 0;
  let maxDiff = 0;
  let count = 0;
  // Extend cluster while diff is elevated (allow small gaps)
  let gapCount = 0;
  while (ci < endSample && gapCount < 8) {
    const jj = ci - startSample;
    const d = Math.max(diffL[jj]!, diffR[jj]!);
    if (d >= diffThreshold * 0.3) {
      sumDiff += d;
      if (d > maxDiff) maxDiff = d;
      count++;
      gapCount = 0;
    } else {
      gapCount++;
    }
    ci++;
  }
  ci -= gapCount; // back up past gap

  if (count >= 2) {
    clusters.push({ start: cStart, end: ci, maxDiff, avgDiff: sumDiff / count });
  }
}

console.log(`\nDivergence clusters (diff > ${diffThreshold}):`);
console.log(`  Total: ${clusters.length}`);

clusters.sort((a, b) => b.maxDiff - a.maxDiff);
console.log(`\n  Top 50 (sorted by max diff):`);
console.log(
  '  Position    |  Time(ms)  | Len  | maxDiff  | avgDiff  | Context (bad L vs good L around peak)',
);
console.log('  ' + '-'.repeat(110));

for (const c of clusters.slice(0, 50)) {
  // Find peak position within cluster
  let peakPos = c.start;
  let peakD = 0;
  for (let i = c.start; i < c.end; i++) {
    const j = i - startSample;
    const d = Math.max(diffL[j]!, diffR[j]!);
    if (d > peakD) {
      peakD = d;
      peakPos = i;
    }
  }

  const timeMs = ((peakPos / badWav.sampleRate) * 1000).toFixed(1);
  const len = c.end - c.start;

  // Show context: 3 samples before/after peak
  const context: string[] = [];
  for (let k = peakPos - 3; k <= peakPos + 3; k++) {
    if (k >= 0 && k < n && k + offset >= 0 && k + offset < n) {
      const marker = k === peakPos ? '>' : ' ';
      context.push(`${marker}B${badL[k]!.toFixed(3)}/G${goodL[k + offset]!.toFixed(3)}`);
    }
  }

  console.log(
    `  ${String(peakPos).padStart(10)} | ${timeMs.padStart(10)} | ${String(len).padStart(4)} | ${peakD.toFixed(5).padStart(8)} | ${c.avgDiff.toFixed(5).padStart(8)} | [${context.join(', ')}]`,
  );
}

// Distribution of divergence sizes
const diffSizes = clusters.map((c) => c.maxDiff);
if (diffSizes.length > 0) {
  diffSizes.sort((a, b) => a - b);
  const p = (pct: number) =>
    diffSizes[Math.min(Math.floor((diffSizes.length * pct) / 100), diffSizes.length - 1)]!;
  console.log(
    `\n  Diff size distribution: P50=${p(50).toFixed(4)}, P90=${p(90).toFixed(4)}, P99=${p(99).toFixed(4)}, max=${p(100).toFixed(4)}`,
  );
}

// Histogram: distribution of cluster lengths
const lenBuckets = new Map<string, number>();
for (const c of clusters) {
  const len = c.end - c.start;
  const bucket =
    len <= 5
      ? `1-5`
      : len <= 10
        ? `6-10`
        : len <= 20
          ? `11-20`
          : len <= 50
            ? `21-50`
            : len <= 100
              ? `51-100`
              : `100+`;
  lenBuckets.set(bucket, (lenBuckets.get(bucket) || 0) + 1);
}
console.log(`\n  Cluster length distribution:`);
for (const b of ['1-5', '6-10', '11-20', '21-50', '51-100', '100+']) {
  console.log(`    ${b.padStart(6)}: ${lenBuckets.get(b) || 0}`);
}
