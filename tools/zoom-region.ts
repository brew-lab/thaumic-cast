/**
 * Zoom into a specific time region and analyze click patterns.
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2]!;
const startSec = parseFloat(process.argv[3] || '8');
const endSec = parseFloat(process.argv[4] || '10');

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

const buf = readFileSync(file);
const wav = parseWav(buf);
const n = Math.floor(wav.samples.length / wav.channels);
const L = new Float32Array(n);
const R = new Float32Array(n);
for (let i = 0; i < n; i++) {
  L[i] = wav.samples[i * wav.channels]!;
  R[i] = wav.samples[i * wav.channels + 1]!;
}

const startSample = Math.floor(startSec * wav.sampleRate);
const endSample = Math.min(Math.floor(endSec * wav.sampleRate), n);
const label = file.split('/').pop()!;

console.log(
  `\n${label} — Region ${startSec}s to ${endSec}s (samples ${startSample}-${endSample})\n`,
);

// Compute d2 for both channels in the region
const d2L = new Float64Array(endSample - startSample);
const d2R = new Float64Array(endSample - startSample);
for (let i = startSample + 2; i < endSample; i++) {
  const j = i - startSample;
  d2L[j] = Math.abs(L[i]! - 2 * L[i - 1]! + L[i - 2]!);
  d2R[j] = Math.abs(R[i]! - 2 * R[i - 1]! + R[i - 2]!);
}

// Find the top 50 highest d2 events (both channels combined)
interface Peak {
  pos: number;
  d2l: number;
  d2r: number;
  d1l: number;
  d1r: number;
  valL: number;
  valR: number;
}
const peaks: Peak[] = [];

for (let i = startSample + 2; i < endSample - 1; i++) {
  const j = i - startSample;
  const maxD2 = Math.max(d2L[j]!, d2R[j]!);
  if (maxD2 > 0.01) {
    // only notable events
    peaks.push({
      pos: i,
      d2l: d2L[j]!,
      d2r: d2R[j]!,
      d1l: Math.abs(L[i]! - L[i - 1]!),
      d1r: Math.abs(R[i]! - R[i - 1]!),
      valL: L[i]!,
      valR: R[i]!,
    });
  }
}

// Cluster adjacent peaks
interface Cluster {
  start: number;
  end: number;
  peakD2: number;
  peakPos: number;
  bothCh: boolean;
}
const clusters: Cluster[] = [];
peaks.sort((a, b) => a.pos - b.pos);

let ci = 0;
while (ci < peaks.length) {
  const start = peaks[ci]!.pos;
  let end = start + 1;
  let peakD2 = Math.max(peaks[ci]!.d2l, peaks[ci]!.d2r);
  let peakPos = start;
  let hasL = peaks[ci]!.d2l > 0.01;
  let hasR = peaks[ci]!.d2r > 0.01;

  while (ci + 1 < peaks.length && peaks[ci + 1]!.pos <= end + 3) {
    ci++;
    end = peaks[ci]!.pos + 1;
    const d = Math.max(peaks[ci]!.d2l, peaks[ci]!.d2r);
    if (d > peakD2) {
      peakD2 = d;
      peakPos = peaks[ci]!.pos;
    }
    if (peaks[ci]!.d2l > 0.01) hasL = true;
    if (peaks[ci]!.d2r > 0.01) hasR = true;
  }
  clusters.push({ start, end, peakD2, peakPos, bothCh: hasL && hasR });
  ci++;
}

clusters.sort((a, b) => b.peakD2 - a.peakD2);

console.log(`Events with d² > 0.01 in region: ${clusters.length}`);
console.log(`  Both channels: ${clusters.filter((c) => c.bothCh).length}`);
console.log(`  Single channel: ${clusters.filter((c) => !c.bothCh).length}`);

console.log(`\nTop 30 events (sorted by peak d²):`);
console.log('  Position    |  Time(ms) | Len | peakD2   | BothCh | Context (L values around peak)');
console.log('  ' + '-'.repeat(100));

for (const c of clusters.slice(0, 30)) {
  const timeMs = ((c.peakPos / wav.sampleRate) * 1000).toFixed(1);
  const len = c.end - c.start;
  // Show 5 samples before and after the peak
  const context: string[] = [];
  for (let k = c.peakPos - 5; k <= c.peakPos + 5; k++) {
    if (k >= 0 && k < n) {
      const marker = k === c.peakPos ? '>' : ' ';
      context.push(`${marker}${L[k]!.toFixed(4)}`);
    }
  }
  console.log(
    `  ${String(c.peakPos).padStart(10)} | ${timeMs.padStart(9)} | ${String(len).padStart(3)} | ${c.peakD2.toFixed(5)} | ${c.bothCh ? 'YES' : 'no '} | [${context.join(', ')}]`,
  );
}

// Also show the same analysis for the good file in the equivalent time range
