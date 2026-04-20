/**
 * Analyze audio files at render quantum boundaries (every 128 samples)
 * to find what distinguishes bad captures from good ones.
 */

import { readFileSync } from 'node:fs';

function parseWav(buf: Buffer): { sampleRate: number; channels: number; samples: Float32Array } {
  const riff = buf.toString('ascii', 0, 4);
  if (riff !== 'RIFF') throw new Error('Not a WAV file');
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
  let dataOffset = 36;
  while (buf.toString('ascii', dataOffset, dataOffset + 4) !== 'data') {
    dataOffset += 8 + buf.readUInt32LE(dataOffset + 4);
    if (dataOffset >= buf.length - 8) throw new Error('No data chunk');
  }
  const dataSize = buf.readUInt32LE(dataOffset + 4);
  const pcmStart = dataOffset + 8;

  if (bitsPerSample === 32) {
    const floatArray = new Float32Array(buf.buffer, buf.byteOffset + pcmStart, dataSize / 4);
    return { sampleRate, channels, samples: floatArray };
  }
  throw new Error(`Unsupported bits per sample: ${bitsPerSample}`);
}

function deinterleave(samples: Float32Array, channels: number): Float32Array[] {
  const len = Math.floor(samples.length / channels);
  const out: Float32Array[] = [];
  for (let c = 0; c < channels; c++) {
    const ch = new Float32Array(len);
    for (let i = 0; i < len; i++) ch[i] = samples[i * channels + c];
    out.push(ch);
  }
  return out;
}

const QUANTUM = 128;

function analyzeQuantumBoundaries(mono: Float32Array, label: string): void {
  const totalSamples = mono.length;
  const numBoundaries = Math.floor(totalSamples / QUANTUM) - 1;

  // At each quantum boundary (sample index = k*128), measure:
  // 1. |d1| = |s[k*128] - s[k*128 - 1]| (first derivative at boundary)
  // 2. |d2| = |s[k*128+1] - 2*s[k*128] + s[k*128-1]| (second derivative at boundary)
  // 3. Compare boundary discontinuity to mid-quantum discontinuity

  const boundaryD1: number[] = [];
  const boundaryD2: number[] = [];
  const midD1: number[] = [];
  const midD2: number[] = [];

  // Also collect: discontinuity at boundary vs average discontinuity within quantum
  const boundaryVsInterior: number[] = [];

  for (let k = 1; k < numBoundaries; k++) {
    const bIdx = k * QUANTUM; // boundary sample

    // Boundary metrics
    const bd1 = Math.abs(mono[bIdx] - mono[bIdx - 1]);
    const bd2 = Math.abs(mono[bIdx + 1] - 2 * mono[bIdx] + mono[bIdx - 1]);
    boundaryD1.push(bd1);
    boundaryD2.push(bd2);

    // Mid-quantum metrics (at k*128 + 64)
    const mIdx = k * QUANTUM + 64;
    if (mIdx + 1 < totalSamples) {
      const md1 = Math.abs(mono[mIdx] - mono[mIdx - 1]);
      const md2 = Math.abs(mono[mIdx + 1] - 2 * mono[mIdx] + mono[mIdx - 1]);
      midD1.push(md1);
      midD2.push(md2);
    }

    // Interior average |d2| for this quantum
    let interiorSum = 0;
    let interiorCount = 0;
    for (let i = bIdx - QUANTUM + 2; i < bIdx - 1; i++) {
      if (i > 0 && i + 1 < totalSamples) {
        interiorSum += Math.abs(mono[i + 1] - 2 * mono[i] + mono[i - 1]);
        interiorCount++;
      }
    }
    if (interiorCount > 0) {
      const interiorAvg = interiorSum / interiorCount;
      if (interiorAvg > 0) {
        boundaryVsInterior.push(bd2 / interiorAvg);
      }
    }
  }

  // Statistics
  const percentile = (arr: number[], p: number): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    const idx = Math.floor((sorted.length * p) / 100);
    return sorted[Math.min(idx, sorted.length - 1)];
  };
  const mean = (arr: number[]): number => arr.reduce((a, b) => a + b, 0) / arr.length;

  console.log(`\n=== ${label} ===`);
  console.log(`Total boundaries analyzed: ${numBoundaries}`);

  console.log(
    `\n  Boundary |d1|: mean=${mean(boundaryD1).toFixed(6)}, P50=${percentile(boundaryD1, 50).toFixed(6)}, P95=${percentile(boundaryD1, 95).toFixed(6)}, P99=${percentile(boundaryD1, 99).toFixed(6)}, max=${Math.max(...boundaryD1).toFixed(6)}`,
  );
  console.log(
    `  Mid-quant |d1|: mean=${mean(midD1).toFixed(6)}, P50=${percentile(midD1, 50).toFixed(6)}, P95=${percentile(midD1, 95).toFixed(6)}, P99=${percentile(midD1, 99).toFixed(6)}, max=${Math.max(...midD1).toFixed(6)}`,
  );

  console.log(
    `\n  Boundary |d2|: mean=${mean(boundaryD2).toFixed(6)}, P50=${percentile(boundaryD2, 50).toFixed(6)}, P95=${percentile(boundaryD2, 95).toFixed(6)}, P99=${percentile(boundaryD2, 99).toFixed(6)}, max=${Math.max(...boundaryD2).toFixed(6)}`,
  );
  console.log(
    `  Mid-quant |d2|: mean=${mean(midD2).toFixed(6)}, P50=${percentile(midD2, 50).toFixed(6)}, P95=${percentile(midD2, 95).toFixed(6)}, P99=${percentile(midD2, 99).toFixed(6)}, max=${Math.max(...midD2).toFixed(6)}`,
  );

  console.log(
    `\n  Boundary/Interior |d2| ratio: mean=${mean(boundaryVsInterior).toFixed(3)}, P50=${percentile(boundaryVsInterior, 50).toFixed(3)}, P95=${percentile(boundaryVsInterior, 95).toFixed(3)}, P99=${percentile(boundaryVsInterior, 99).toFixed(3)}, max=${Math.max(...boundaryVsInterior).toFixed(3)}`,
  );

  // Count boundaries where boundary |d2| is much larger than interior
  const thresholds = [2, 3, 5, 10, 20];
  console.log(`\n  Boundaries where boundary/interior ratio exceeds threshold:`);
  for (const t of thresholds) {
    const count = boundaryVsInterior.filter((r) => r > t).length;
    console.log(`    ratio > ${t}: ${count} (${((count / numBoundaries) * 100).toFixed(2)}%)`);
  }

  // Now look at RMS level change across boundaries
  const rmsJumps: number[] = [];
  for (let k = 1; k < numBoundaries; k++) {
    const bIdx = k * QUANTUM;
    // RMS of 32 samples before boundary
    let rmsBefore = 0;
    for (let i = bIdx - 32; i < bIdx; i++) rmsBefore += mono[i] * mono[i];
    rmsBefore = Math.sqrt(rmsBefore / 32);

    // RMS of 32 samples after boundary
    let rmsAfter = 0;
    for (let i = bIdx; i < bIdx + 32 && i < totalSamples; i++) rmsAfter += mono[i] * mono[i];
    rmsAfter = Math.sqrt(rmsAfter / 32);

    if (rmsBefore > 0.001) {
      rmsJumps.push(Math.abs(rmsAfter - rmsBefore) / rmsBefore);
    }
  }

  console.log(
    `\n  RMS jump at boundaries (relative): mean=${mean(rmsJumps).toFixed(4)}, P50=${percentile(rmsJumps, 50).toFixed(4)}, P95=${percentile(rmsJumps, 95).toFixed(4)}, P99=${percentile(rmsJumps, 99).toFixed(4)}, max=${Math.max(...rmsJumps).toFixed(4)}`,
  );

  const rmsThresholds = [0.1, 0.2, 0.5, 1.0];
  for (const t of rmsThresholds) {
    const count = rmsJumps.filter((r) => r > t).length;
    console.log(
      `    RMS jump > ${(t * 100).toFixed(0)}%: ${count} (${((count / rmsJumps.length) * 100).toFixed(2)}%)`,
    );
  }

  // Look at sample-level amplitude envelope at boundaries
  // Check if there's a gain discontinuity pattern
  console.log(`\n  Amplitude at boundaries (absolute |sample|):`);
  const boundaryAmps: number[] = [];
  const preBoundaryAmps: number[] = [];
  for (let k = 1; k < numBoundaries; k++) {
    const bIdx = k * QUANTUM;
    boundaryAmps.push(Math.abs(mono[bIdx]));
    preBoundaryAmps.push(Math.abs(mono[bIdx - 1]));
  }
  console.log(
    `    At boundary:     mean=${mean(boundaryAmps).toFixed(6)}, P50=${percentile(boundaryAmps, 50).toFixed(6)}`,
  );
  console.log(
    `    Pre-boundary:    mean=${mean(preBoundaryAmps).toFixed(6)}, P50=${percentile(preBoundaryAmps, 50).toFixed(6)}`,
  );
}

// Also analyze: what does the glitch actually look like at quantum boundaries?
// Extract the worst quantum boundaries for visual inspection
function extractWorstBoundaries(mono: Float32Array, label: string, count: number = 10): void {
  const numBoundaries = Math.floor(mono.length / QUANTUM) - 1;

  interface BoundaryInfo {
    k: number;
    ratio: number;
    boundaryD2: number;
    interiorAvgD2: number;
  }

  const boundaries: BoundaryInfo[] = [];

  for (let k = 1; k < numBoundaries; k++) {
    const bIdx = k * QUANTUM;
    const bd2 = Math.abs(mono[bIdx + 1] - 2 * mono[bIdx] + mono[bIdx - 1]);

    let interiorSum = 0;
    let interiorCount = 0;
    for (let i = bIdx - QUANTUM + 2; i < bIdx - 1; i++) {
      if (i > 0 && i + 1 < mono.length) {
        interiorSum += Math.abs(mono[i + 1] - 2 * mono[i] + mono[i - 1]);
        interiorCount++;
      }
    }
    const interiorAvg = interiorCount > 0 ? interiorSum / interiorCount : 1;

    boundaries.push({
      k,
      ratio: bd2 / (interiorAvg || 1),
      boundaryD2: bd2,
      interiorAvgD2: interiorAvg,
    });
  }

  boundaries.sort((a, b) => b.ratio - a.ratio);

  console.log(`\n=== ${label} - Top ${count} worst boundaries ===`);
  for (let i = 0; i < Math.min(count, boundaries.length); i++) {
    const b = boundaries[i];
    const bIdx = b.k * QUANTUM;

    // Print 8 samples before and after boundary
    const before = [];
    const after = [];
    for (let j = -8; j < 0; j++) before.push(mono[bIdx + j].toFixed(6));
    for (let j = 0; j < 8; j++) after.push(mono[bIdx + j].toFixed(6));

    console.log(
      `  Boundary ${b.k} (sample ${bIdx}): ratio=${b.ratio.toFixed(2)}, bd2=${b.boundaryD2.toFixed(6)}, interior=${b.interiorAvgD2.toFixed(6)}`,
    );
    console.log(`    before: [${before.join(', ')}]`);
    console.log(`    after:  [${after.join(', ')}]`);
  }
}

// Main
const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('Usage: bun run tools/analyze-quantum-boundaries.ts <file1.wav> [file2.wav ...]');
  process.exit(1);
}

for (const file of files) {
  const buf = readFileSync(file);
  const wav = parseWav(buf);
  const channels = deinterleave(wav.samples, wav.channels);
  const label = file.split('/').pop() || file;

  console.log(
    `\nFile: ${label} (${wav.sampleRate}Hz, ${wav.channels}ch, ${channels[0].length} samples/ch)`,
  );

  // Analyze channel 0
  analyzeQuantumBoundaries(channels[0], `${label} - Ch0`);
  extractWorstBoundaries(channels[0], `${label} - Ch0`, 5);
}
