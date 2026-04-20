/**
 * Per-quantum RMS analysis: compute RMS of each 128-sample quantum,
 * then look at the distribution of jumps between consecutive quanta.
 * Compare bad vs good to find distinguishing features.
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
    return {
      sampleRate,
      channels,
      samples: new Float32Array(buf.buffer, buf.byteOffset + pcmStart, dataSize / 4),
    };
  }
  throw new Error(`Unsupported bits: ${bitsPerSample}`);
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

function computeQuantumRMS(mono: Float32Array): Float64Array {
  const numQuanta = Math.floor(mono.length / QUANTUM);
  const rms = new Float64Array(numQuanta);
  for (let q = 0; q < numQuanta; q++) {
    let sum = 0;
    const start = q * QUANTUM;
    for (let i = 0; i < QUANTUM; i++) {
      const s = mono[start + i];
      sum += s * s;
    }
    rms[q] = Math.sqrt(sum / QUANTUM);
  }
  return rms;
}

function analyzeFile(path: string): void {
  const buf = readFileSync(path);
  const wav = parseWav(buf);
  const channels = deinterleave(wav.samples, wav.channels);
  const label = path.split('/').pop() || path;
  const mono = channels[0];

  console.log(`\n${'='.repeat(70)}`);
  console.log(
    `File: ${label} (${wav.sampleRate}Hz, ${mono.length} samples, ${(mono.length / wav.sampleRate).toFixed(2)}s)`,
  );

  const rms = computeQuantumRMS(mono);
  const numQuanta = rms.length;

  // 1. Consecutive quantum RMS ratio (gain change between quanta)
  const ratios: number[] = [];
  for (let q = 1; q < numQuanta; q++) {
    if (rms[q - 1] > 0.001 && rms[q] > 0.001) {
      const ratio = rms[q] / rms[q - 1];
      ratios.push(ratio);
    }
  }

  const percentile = (arr: number[], p: number): number => {
    const sorted = [...arr].sort((a, b) => a - b);
    return sorted[Math.min(Math.floor((sorted.length * p) / 100), sorted.length - 1)];
  };
  const mean = (arr: number[]): number => arr.reduce((a, b) => a + b, 0) / arr.length;

  console.log(`\nConsecutive quantum RMS ratio (q[n]/q[n-1]):`);
  console.log(`  Count: ${ratios.length}`);
  console.log(`  Mean: ${mean(ratios).toFixed(4)}`);
  console.log(
    `  P1:  ${percentile(ratios, 1).toFixed(4)}   P5:  ${percentile(ratios, 5).toFixed(4)}`,
  );
  console.log(`  P50: ${percentile(ratios, 50).toFixed(4)}`);
  console.log(
    `  P95: ${percentile(ratios, 95).toFixed(4)}   P99: ${percentile(ratios, 99).toFixed(4)}`,
  );
  console.log(`  Min: ${Math.min(...ratios).toFixed(4)}   Max: ${Math.max(...ratios).toFixed(4)}`);

  // Distribution of dB change
  const dbChanges = ratios.map((r) => 20 * Math.log10(r));
  console.log(`\ndB change between consecutive quanta:`);
  console.log(
    `  P1:  ${percentile(dbChanges, 1).toFixed(2)} dB   P5:  ${percentile(dbChanges, 5).toFixed(2)} dB`,
  );
  console.log(`  P50: ${percentile(dbChanges, 50).toFixed(2)} dB`);
  console.log(
    `  P95: ${percentile(dbChanges, 95).toFixed(2)} dB   P99: ${percentile(dbChanges, 99).toFixed(2)} dB`,
  );
  console.log(
    `  Min: ${Math.min(...dbChanges).toFixed(2)} dB   Max: ${Math.max(...dbChanges).toFixed(2)} dB`,
  );

  // Count extreme jumps
  const jumpThresholdsDb = [1, 2, 3, 5, 10];
  console.log(`\nQuanta with |dB change| exceeding threshold:`);
  for (const t of jumpThresholdsDb) {
    const count = dbChanges.filter((d) => Math.abs(d) > t).length;
    console.log(`  |dB| > ${t}: ${count} (${((count / dbChanges.length) * 100).toFixed(2)}%)`);
  }

  // 2. Prediction-based: predict quantum RMS from neighbors, measure surprise
  // Use median of 3 prior quanta as prediction
  const surprises: number[] = [];
  for (let q = 3; q < numQuanta; q++) {
    if (rms[q] < 0.001) continue;
    const prev = [rms[q - 3], rms[q - 2], rms[q - 1]].sort((a, b) => a - b);
    const predicted = prev[1]; // median
    if (predicted > 0.001) {
      const surprise = Math.abs(rms[q] - predicted) / predicted;
      surprises.push(surprise);
    }
  }

  console.log(`\nPrediction surprise (|actual - predicted| / predicted):`);
  console.log(
    `  P50: ${percentile(surprises, 50).toFixed(4)}   P95: ${percentile(surprises, 95).toFixed(4)}   P99: ${percentile(surprises, 99).toFixed(4)}`,
  );
  console.log(`  Max: ${Math.max(...surprises).toFixed(4)}`);

  // 3. Look for "outlier" quanta: RMS is far from local trend
  // Use ±2 quanta window (excluding self), check if current quantum is an outlier
  const outlierScores: number[] = [];
  for (let q = 2; q < numQuanta - 2; q++) {
    if (rms[q] < 0.001) continue;
    const neighbors = [rms[q - 2], rms[q - 1], rms[q + 1], rms[q + 2]];
    const neighborMean = neighbors.reduce((a, b) => a + b, 0) / 4;
    const neighborStd = Math.sqrt(neighbors.reduce((a, b) => a + (b - neighborMean) ** 2, 0) / 4);
    if (neighborStd > 0.0001) {
      outlierScores.push(Math.abs(rms[q] - neighborMean) / neighborStd);
    }
  }

  console.log(`\nOutlier score (z-score vs ±2 neighbors):`);
  console.log(
    `  P50: ${percentile(outlierScores, 50).toFixed(3)}   P95: ${percentile(outlierScores, 95).toFixed(3)}   P99: ${percentile(outlierScores, 99).toFixed(3)}`,
  );
  console.log(
    `  P99.5: ${percentile(outlierScores, 99.5).toFixed(3)}   P99.9: ${percentile(outlierScores, 99.9).toFixed(3)}`,
  );
  const outlierThresholds = [2, 3, 5, 10];
  for (const t of outlierThresholds) {
    const count = outlierScores.filter((s) => s > t).length;
    console.log(`  z > ${t}: ${count} (${((count / outlierScores.length) * 100).toFixed(3)}%)`);
  }

  // 4. Cross-channel coherence at quantum boundaries
  // If both channels are affected, the gain change should be correlated
  if (channels.length >= 2) {
    const rmsL = computeQuantumRMS(channels[0]);
    const rmsR = computeQuantumRMS(channels[1]);

    let coherent = 0;
    let total = 0;
    for (let q = 1; q < Math.min(rmsL.length, rmsR.length); q++) {
      if (rmsL[q - 1] > 0.001 && rmsR[q - 1] > 0.001) {
        const ratioL = rmsL[q] / rmsL[q - 1];
        const ratioR = rmsR[q] / rmsR[q - 1];
        // Both jump in same direction?
        const dbL = 20 * Math.log10(ratioL);
        const dbR = 20 * Math.log10(ratioR);
        if (Math.abs(dbL) > 1 && Math.abs(dbR) > 1 && Math.sign(dbL) === Math.sign(dbR)) {
          coherent++;
        }
        if (Math.abs(dbL) > 1 || Math.abs(dbR) > 1) {
          total++;
        }
      }
    }
    console.log(`\nCross-channel coherence (both channels jump >1dB same direction):`);
    console.log(
      `  Coherent: ${coherent}/${total} (${total > 0 ? ((coherent / total) * 100).toFixed(1) : 0}%)`,
    );
  }

  // 5. Spectral approach: look at the power spectrum of the RMS envelope itself
  // Quantum glitches should create high-frequency energy in the RMS envelope
  // Compute variance of RMS first-difference as a proxy
  const rmsDiffs: number[] = [];
  for (let q = 1; q < numQuanta; q++) {
    if (rms[q] > 0.001 || rms[q - 1] > 0.001) {
      rmsDiffs.push(rms[q] - rms[q - 1]);
    }
  }
  const diffVar = rmsDiffs.reduce((a, b) => a + b * b, 0) / rmsDiffs.length;
  const diffMean = rmsDiffs.reduce((a, b) => a + Math.abs(b), 0) / rmsDiffs.length;
  console.log(`\nRMS envelope roughness:`);
  console.log(`  Mean |diff|: ${diffMean.toFixed(6)}`);
  console.log(`  Variance: ${diffVar.toFixed(8)}`);
  console.log(`  Std: ${Math.sqrt(diffVar).toFixed(6)}`);
}

// Run on sine files too for comparison
const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('Usage: bun run tools/analyze-quantum-rms.ts <file1.wav> ...');
  process.exit(1);
}

for (const file of files) {
  analyzeFile(file);
}
