/**
 * Deep comparison of click events between bad and good music files.
 * Finds what's different — L-only, R-only, or both-channel clicks
 * at various d² thresholds.
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

function analyzeClicks(path: string): void {
  const buf = readFileSync(path);
  const wav = parseWav(buf);
  const n = Math.floor(wav.samples.length / wav.channels);
  const label = path.split('/').pop()!;

  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = wav.samples[i * wav.channels]!;
    R[i] = wav.samples[i * wav.channels + 1]!;
  }

  // Compute |d²| for both channels
  const d2L = new Float64Array(n);
  const d2R = new Float64Array(n);
  for (let i = 2; i < n; i++) {
    d2L[i] = Math.abs(L[i]! - 2 * L[i - 1]! + L[i - 2]!);
    d2R[i] = Math.abs(R[i]! - 2 * R[i - 1]! + R[i - 2]!);
  }

  // Compute |d1| for detecting sharp jumps
  const d1L = new Float64Array(n);
  const d1R = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    d1L[i] = Math.abs(L[i]! - L[i - 1]!);
    d1R[i] = Math.abs(R[i]! - R[i - 1]!);
  }

  const durationSec = n / wav.sampleRate;
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${label} (${durationSec.toFixed(2)}s, ${n} samples/ch)`);

  // Try different thresholds and approaches
  const thresholds = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5];

  console.log(`\n  |d²| threshold analysis (samples exceeding threshold):`);
  console.log(
    `  ${'Threshold'.padStart(10)} | ${'L-only'.padStart(8)} | ${'R-only'.padStart(8)} | ${'Both'.padStart(8)} | ${'L-only/s'.padStart(8)} | ${'R-only/s'.padStart(8)} | ${'Both/s'.padStart(8)}`,
  );
  console.log(`  ${'-'.repeat(78)}`);

  for (const thr of thresholds) {
    let lOnly = 0,
      rOnly = 0,
      both = 0;
    for (let i = 2; i < n; i++) {
      const lHigh = d2L[i]! > thr;
      const rHigh = d2R[i]! > thr;
      if (lHigh && rHigh) both++;
      else if (lHigh) lOnly++;
      else if (rHigh) rOnly++;
    }
    console.log(
      `  ${thr.toFixed(3).padStart(10)} | ${String(lOnly).padStart(8)} | ${String(rOnly).padStart(8)} | ${String(both).padStart(8)} | ${(lOnly / durationSec).toFixed(1).padStart(8)} | ${(rOnly / durationSec).toFixed(1).padStart(8)} | ${(both / durationSec).toFixed(1).padStart(8)}`,
    );
  }

  // d1 (first derivative) analysis
  console.log(`\n  |d1| threshold analysis:`);
  console.log(
    `  ${'Threshold'.padStart(10)} | ${'L-only'.padStart(8)} | ${'R-only'.padStart(8)} | ${'Both'.padStart(8)} | ${'Both/s'.padStart(8)}`,
  );
  console.log(`  ${'-'.repeat(55)}`);

  const d1thresholds = [0.05, 0.1, 0.2, 0.3, 0.5];
  for (const thr of d1thresholds) {
    let lOnly = 0,
      rOnly = 0,
      both = 0;
    for (let i = 1; i < n; i++) {
      const lHigh = d1L[i]! > thr;
      const rHigh = d1R[i]! > thr;
      if (lHigh && rHigh) both++;
      else if (lHigh) lOnly++;
      else if (rHigh) rOnly++;
    }
    console.log(
      `  ${thr.toFixed(3).padStart(10)} | ${String(lOnly).padStart(8)} | ${String(rOnly).padStart(8)} | ${String(both).padStart(8)} | ${(both / durationSec).toFixed(1).padStart(8)}`,
    );
  }

  // Adaptive threshold: d2 > localRMS * multiplier
  console.log(`\n  Adaptive |d²| analysis (d2 > localRMS * mult, RMS window=±128):`);

  // Compute local RMS
  const cumSqL = new Float64Array(n + 1);
  const cumSqR = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumSqL[i + 1] = cumSqL[i]! + L[i]! * L[i]!;
    cumSqR[i + 1] = cumSqR[i]! + R[i]! * R[i]!;
  }

  const multipliers = [0.05, 0.1, 0.2, 0.5, 1.0];
  console.log(
    `  ${'Mult'.padStart(6)} | ${'L-only'.padStart(8)} | ${'R-only'.padStart(8)} | ${'Both'.padStart(8)} | ${'Both/s'.padStart(8)}`,
  );
  console.log(`  ${'-'.repeat(50)}`);

  for (const mult of multipliers) {
    let lOnly = 0,
      rOnly = 0,
      both = 0;
    for (let i = 2; i < n; i++) {
      const lo = Math.max(0, i - 128);
      const hi = Math.min(n, i + 128);
      const len = hi - lo;
      const rmsL = Math.sqrt((cumSqL[hi]! - cumSqL[lo]!) / len);
      const rmsR = Math.sqrt((cumSqR[hi]! - cumSqR[lo]!) / len);

      const thrL = rmsL * mult;
      const thrR = rmsR * mult;

      const lHigh = d2L[i]! > thrL && thrL > 0.001;
      const rHigh = d2R[i]! > thrR && thrR > 0.001;

      if (lHigh && rHigh) both++;
      else if (lHigh) lOnly++;
      else if (rHigh) rOnly++;
    }
    console.log(
      `  ${mult.toFixed(2).padStart(6)} | ${String(lOnly).padStart(8)} | ${String(rOnly).padStart(8)} | ${String(both).padStart(8)} | ${(both / durationSec).toFixed(1).padStart(8)}`,
    );
  }

  // Check for specific artifact patterns
  console.log(`\n  Special patterns:`);

  // Near-zero samples in active signal
  let zeroInActive = 0;
  for (let i = 128; i < n - 128; i++) {
    if (Math.abs(L[i]!) < 0.0001 && Math.abs(R[i]!) < 0.0001) {
      const lo = Math.max(0, i - 64);
      const hi = Math.min(n, i + 64);
      let rms = 0;
      for (let j = lo; j < hi; j++) rms += L[j]! * L[j]!;
      rms = Math.sqrt(rms / (hi - lo));
      if (rms > 0.05) zeroInActive++;
    }
  }
  console.log(`    Zero samples in active signal (RMS>0.05): ${zeroInActive}`);

  // Repeated samples
  let repeats = 0;
  for (let i = 1; i < n; i++) {
    if (L[i] === L[i - 1] && R[i] === R[i - 1] && Math.abs(L[i]!) > 0.01) {
      repeats++;
    }
  }
  console.log(`    Repeated samples (L[i]=L[i-1] AND R[i]=R[i-1], |val|>0.01): ${repeats}`);

  // Sign flips (polarity changes) with large magnitude
  let signFlips = 0;
  for (let i = 1; i < n; i++) {
    if (
      L[i]! * L[i - 1]! < 0 &&
      Math.abs(L[i]! - L[i - 1]!) > 0.3 &&
      R[i]! * R[i - 1]! < 0 &&
      Math.abs(R[i]! - R[i - 1]!) > 0.3
    ) {
      signFlips++;
    }
  }
  console.log(`    Simultaneous sign flips (|jump|>0.3 both ch): ${signFlips}`);

  // L/R amplitude ratio anomalies at high-d² points
  console.log(`\n  L/R ratio at high-d² events (d²>0.1):`);
  const ratios: number[] = [];
  for (let i = 2; i < n; i++) {
    if (d2L[i]! > 0.1 && d2R[i]! > 0.1) {
      ratios.push(d2L[i]! / d2R[i]!);
    }
  }
  if (ratios.length > 0) {
    ratios.sort((a, b) => a - b);
    const p = (arr: number[], pct: number) =>
      arr[Math.min(Math.floor((arr.length * pct) / 100), arr.length - 1)]!;
    console.log(`    Count: ${ratios.length}`);
    console.log(
      `    P5: ${p(ratios, 5).toFixed(3)}, P50: ${p(ratios, 50).toFixed(3)}, P95: ${p(ratios, 95).toFixed(3)}`,
    );
  }
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.log('Usage: bun run tools/compare-clicks.ts <file1.wav> [file2.wav ...]');
  process.exit(1);
}

for (const file of files) {
  analyzeClicks(file);
}
