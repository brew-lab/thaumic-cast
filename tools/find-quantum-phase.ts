/**
 * Find the quantum phase offset in a WAV file.
 * Analyzes where |d²| > threshold samples cluster modulo 128.
 */
import { readFileSync } from 'node:fs';

function parseWav(buf: Buffer): { sampleRate: number; channels: number; samples: Float32Array } {
  const channels = buf.readUInt16LE(22);
  const sampleRate = buf.readUInt32LE(24);
  const bitsPerSample = buf.readUInt16LE(34);
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

const QUANTUM = 128;
const file = process.argv[2];
if (!file) {
  console.log('Usage: bun run tools/find-quantum-phase.ts <file.wav>');
  process.exit(1);
}

const buf = readFileSync(file);
const wav = parseWav(buf);
const n = Math.floor(wav.samples.length / wav.channels);

// Deinterleave channel 0
const mono = new Float32Array(n);
for (let i = 0; i < n; i++) mono[i] = wav.samples[i * wav.channels]!;

// Compute |d²| and find high values
const threshold = 0.005;
const histogram = new Uint32Array(QUANTUM);

for (let i = 2; i < n; i++) {
  const d2 = Math.abs(mono[i]! - 2 * mono[i - 1]! + mono[i - 2]!);
  if (d2 > threshold) {
    histogram[i % QUANTUM]++;
  }
}

// Find peak in histogram — that's the quantum phase
let maxCount = 0;
let maxPhase = 0;
for (let p = 0; p < QUANTUM; p++) {
  if (histogram[p]! > maxCount) {
    maxCount = histogram[p]!;
    maxPhase = p;
  }
}

console.log(`File: ${file}`);
console.log(
  `Total discontinuities (|d²| > ${threshold}): ${Array.from(histogram).reduce((a, b) => a + b, 0)}`,
);
console.log(`\nHistogram of discontinuity positions (mod ${QUANTUM}):`);

// Show top 10 positions
const sorted = Array.from(histogram)
  .map((count, pos) => ({ pos, count }))
  .sort((a, b) => b.count - a.count);

console.log(`\nTop 20 positions:`);
for (const { pos, count } of sorted.slice(0, 20)) {
  const bar = '█'.repeat(Math.round((count / maxCount) * 40));
  console.log(`  ${String(pos).padStart(4)}: ${bar} ${count}`);
}

console.log(`\nDetected quantum phase: ${maxPhase} (count: ${maxCount})`);
console.log(
  `Runner up positions: ${sorted
    .slice(1, 5)
    .map((s) => `${s.pos}(${s.count})`)
    .join(', ')}`,
);

// Check if it's concentrated — ratio of top position to average
const avg = Array.from(histogram).reduce((a, b) => a + b, 0) / QUANTUM;
console.log(`\nConcentration ratio (peak/avg): ${(maxCount / avg).toFixed(2)}x`);
console.log(
  `Adjacent to peak: ${histogram[(maxPhase - 1 + QUANTUM) % QUANTUM]} | ${maxCount} | ${histogram[(maxPhase + 1) % QUANTUM]}`,
);
