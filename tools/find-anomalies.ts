/**
 * Search for specific anomaly patterns in audio that might cause clicks.
 * Looks for things d² analysis would miss.
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

const file = process.argv[2]!;
const buf = readFileSync(file);
const wav = parseWav(buf);
const n = Math.floor(wav.samples.length / wav.channels);
const L = new Float32Array(n);
const R = new Float32Array(n);
for (let i = 0; i < n; i++) {
  L[i] = wav.samples[i * wav.channels]!;
  R[i] = wav.samples[i * wav.channels + 1]!;
}

const label = file.split('/').pop()!;
console.log(`\n${label} (${n} samples, ${(n / wav.sampleRate).toFixed(2)}s)\n`);

// 1. Denormalized floats (very small but nonzero)
let denorms = 0;
const denormPositions: number[] = [];
for (let i = 0; i < n; i++) {
  const absL = Math.abs(L[i]!);
  const absR = Math.abs(R[i]!);
  if ((absL > 0 && absL < 1e-30) || (absR > 0 && absR < 1e-30)) {
    denorms++;
    if (denormPositions.length < 10) denormPositions.push(i);
  }
}
console.log(`Denormalized floats: ${denorms}`);
if (denormPositions.length > 0) console.log(`  First positions: ${denormPositions.join(', ')}`);

// 2. NaN or Infinity
let nanInf = 0;
for (let i = 0; i < n; i++) {
  if (!isFinite(L[i]!) || !isFinite(R[i]!)) nanInf++;
}
console.log(`NaN/Infinity: ${nanInf}`);

// 3. Exact bit-pattern duplicates of unusual values
const valueCounts = new Map<number, number>();
for (let i = 0; i < n; i++) {
  // Use DataView to get exact float bit patterns
  const val = L[i]!;
  if (Math.abs(val) > 0.001 && Math.abs(val) < 0.999) continue; // skip normal values
  valueCounts.set(val, (valueCounts.get(val) || 0) + 1);
}
// Show values that appear suspiciously often
const suspicious = [...valueCounts.entries()]
  .filter(([val, count]) => count > 10 && Math.abs(val) > 1e-10 && Math.abs(val) < 1e-5)
  .sort((a, b) => b[1] - a[1]);
if (suspicious.length > 0) {
  console.log(`Suspicious repeated values:`);
  for (const [val, count] of suspicious.slice(0, 5)) {
    console.log(`  ${val.toExponential(6)}: ${count} times`);
  }
}

// 4. Micro-dropouts: 1-3 samples near zero in active signal
let microDropouts = 0;
const microPositions: { pos: number; len: number; beforeRms: number }[] = [];
for (let i = 32; i < n - 32; i++) {
  if (Math.abs(L[i]!) > 0.001 || Math.abs(R[i]!) > 0.001) continue;

  // Check if surrounded by active signal
  let rmsBefore = 0;
  for (let j = i - 16; j < i; j++) rmsBefore += L[j]! * L[j]! + R[j]! * R[j]!;
  rmsBefore = Math.sqrt(rmsBefore / 32);

  if (rmsBefore < 0.02) continue;

  // Find dropout length
  let len = 1;
  while (i + len < n && Math.abs(L[i + len]!) < 0.001 && Math.abs(R[i + len]!) < 0.001) len++;

  if (len <= 5) {
    microDropouts++;
    if (microPositions.length < 20) {
      microPositions.push({ pos: i, len, beforeRms: rmsBefore });
    }
    i += len; // skip past
  }
}
console.log(`\nMicro-dropouts (1-5 zero samples in active signal): ${microDropouts}`);
for (const m of microPositions) {
  console.log(
    `  @${m.pos} (${((m.pos / wav.sampleRate) * 1000).toFixed(1)}ms): ${m.len} samples, beforeRMS=${m.beforeRms.toFixed(4)}`,
  );
}

// 5. Sample value jumps: |L[i] - L[i-1]| relative to local RMS
// Look for isolated extreme jumps that might be single-sample glitches
console.log(`\nIsolated extreme jumps (|d1| > 10*localRMS, both channels):`);
let extremeJumps = 0;
const jumpPositions: { pos: number; d1L: number; d1R: number; rms: number }[] = [];

for (let i = 129; i < n - 128; i++) {
  const d1l = Math.abs(L[i]! - L[i - 1]!);
  const d1r = Math.abs(R[i]! - R[i - 1]!);

  // Quick RMS estimate from nearby samples
  let rms = 0;
  for (let j = i - 64; j < i - 4; j++) rms += L[j]! * L[j]!;
  rms = Math.sqrt(rms / 60);

  if (rms < 0.005) continue;

  const mult = 10;
  if (d1l > rms * mult && d1r > rms * mult) {
    // Check if it's isolated: d1 before and after should be lower
    const d1lPrev = Math.abs(L[i - 1]! - L[i - 2]!);
    const d1lNext = Math.abs(L[i + 1]! - L[i]!);
    if (d1lPrev < d1l * 0.5 || d1lNext < d1l * 0.5) {
      extremeJumps++;
      if (jumpPositions.length < 20) {
        jumpPositions.push({ pos: i, d1L: d1l, d1R: d1r, rms });
      }
    }
  }
}
console.log(`  Found: ${extremeJumps}`);
for (const j of jumpPositions) {
  console.log(
    `  @${j.pos} (${((j.pos / wav.sampleRate) * 1000).toFixed(1)}ms): d1L=${j.d1L.toFixed(4)}, d1R=${j.d1R.toFixed(4)}, RMS=${j.rms.toFixed(4)}, ratio=${(j.d1L / j.rms).toFixed(1)}x`,
  );
}

// 6. Waveform comparison: look at 50ms windows and compute local statistics
// Compare the DISTRIBUTION of these statistics between first/second half
console.log(`\nPer-window statistics (50ms windows):`);
const windowSize = Math.floor(wav.sampleRate * 0.05); // 50ms
const numWindows = Math.floor(n / windowSize);

interface WindowStats {
  pos: number;
  rms: number;
  peakD2: number;
  d2Kurtosis: number;
  zeroCrossings: number;
}

const stats: WindowStats[] = [];
for (let w = 0; w < numWindows; w++) {
  const start = w * windowSize;
  let sumSq = 0;
  let maxD2 = 0;
  let d2Sum = 0;
  let d2SumSq = 0;
  let d2Sum4 = 0;
  let zc = 0;
  let d2Count = 0;

  for (let i = 0; i < windowSize; i++) {
    const idx = start + i;
    const s = L[idx]!;
    sumSq += s * s;

    if (idx >= 2) {
      const d2 = Math.abs(L[idx]! - 2 * L[idx - 1]! + L[idx - 2]!);
      if (d2 > maxD2) maxD2 = d2;
      d2Sum += d2;
      d2SumSq += d2 * d2;
      d2Sum4 += d2 * d2 * d2 * d2;
      d2Count++;
    }

    if (i > 0 && L[idx]! * L[idx - 1]! < 0) zc++;
  }

  const rms = Math.sqrt(sumSq / windowSize);
  const d2Mean = d2Sum / d2Count;
  const d2Var = d2SumSq / d2Count - d2Mean * d2Mean;
  const d2Kurtosis = d2Var > 1e-15 ? d2Sum4 / d2Count / (d2Var * d2Var) : 0;

  stats.push({ pos: start, rms, peakD2: maxD2, d2Kurtosis, zeroCrossings: zc });
}

// Find windows with unusually high kurtosis (heavy-tailed d² = impulsive events)
const kurtosisValues = stats.filter((s) => s.rms > 0.01).map((s) => s.d2Kurtosis);
kurtosisValues.sort((a, b) => a - b);
const kurtP50 = kurtosisValues[Math.floor(kurtosisValues.length * 0.5)]!;
const kurtP95 = kurtosisValues[Math.floor(kurtosisValues.length * 0.95)]!;
const kurtP99 = kurtosisValues[Math.floor(kurtosisValues.length * 0.99)]!;

console.log(
  `  d² kurtosis: P50=${kurtP50.toFixed(1)}, P95=${kurtP95.toFixed(1)}, P99=${kurtP99.toFixed(1)}`,
);

const highKurtosis = stats.filter((s) => s.d2Kurtosis > kurtP95 && s.rms > 0.01);
console.log(`  Windows with high kurtosis (>P95): ${highKurtosis.length}`);
for (const w of highKurtosis.slice(0, 10)) {
  console.log(
    `    @${((w.pos / wav.sampleRate) * 1000).toFixed(0)}ms: kurt=${w.d2Kurtosis.toFixed(1)}, peakD2=${w.peakD2.toFixed(4)}, rms=${w.rms.toFixed(4)}`,
  );
}
