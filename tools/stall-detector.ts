/**
 * Stall/Flatline Artifact Detector
 *
 * Detects regions where the waveform "stalls" — the rate of change drops
 * to near-zero when the surrounding context says it should be high.
 * This is the signature of buffer underrun where samples get repeated
 * or the audio source clock stalls momentarily.
 *
 * Detection: Compare local |d1| (first difference) against expected |d1|
 * from surrounding context. A stall = actual |d1| << expected |d1|.
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
  console.error('Usage: bun run tools/stall-detector.ts <input.wav>');
  process.exit(1);
}

const wav = parseWav(readFileSync(filePath));
const n = Math.floor(wav.samples.length / wav.channels);
const sr = wav.sampleRate;

const ch0 = new Float32Array(n);
for (let i = 0; i < n; i++) ch0[i] = wav.samples[i * wav.channels]!;

console.log(`\nStall Detector: ${filePath}`);
console.log(`  ${sr}Hz, ${wav.channels}ch, ${(n / sr).toFixed(2)}s\n`);

// Compute |d1| (absolute first difference)
const absD1 = new Float64Array(n);
for (let i = 1; i < n; i++) {
  absD1[i] = Math.abs(ch0[i]! - ch0[i - 1]!);
}

// Compute local expected |d1| using a sliding window
// Use a window much larger than the stall to get a robust estimate
const contextWindow = 256; // samples for context
const stallMinLen = 3; // minimum stall length
const stallMaxLen = 64; // maximum stall length

// For each sample, compute the ratio: local |d1| / expected |d1|
// A stall will have a very low ratio
interface StallEvent {
  position: number;
  length: number;
  localD1: number;
  expectedD1: number;
  ratio: number;
  timeSec: number;
}

const stalls: StallEvent[] = [];

// Sliding analysis
const step = 1;
for (let i = contextWindow; i < n - contextWindow; i += step) {
  // Quick pre-check: is local d1 low?
  if (absD1[i]! > 0.01) continue; // Skip if d1 isn't particularly low

  // Compute expected |d1| from context (before and after)
  let sumBefore = 0,
    countBefore = 0;
  for (let j = i - contextWindow; j < i - stallMaxLen; j++) {
    sumBefore += absD1[j]!;
    countBefore++;
  }
  let sumAfter = 0,
    countAfter = 0;
  for (let j = i + stallMaxLen; j < i + contextWindow; j++) {
    sumAfter += absD1[j]!;
    countAfter++;
  }

  const expectedD1 = (sumBefore / countBefore + sumAfter / countAfter) / 2;
  if (expectedD1 < 0.001) continue; // Silence region, skip

  const ratio = absD1[i]! / expectedD1;
  if (ratio > 0.1) continue; // Not a stall — d1 is within 10% of expected

  // Found a candidate — measure the stall extent
  let stallStart = i;
  while (stallStart > contextWindow && absD1[stallStart]! < expectedD1 * 0.15) {
    stallStart--;
  }
  stallStart++;

  let stallEnd = i;
  while (stallEnd < n - contextWindow && absD1[stallEnd]! < expectedD1 * 0.15) {
    stallEnd++;
  }

  const stallLen = stallEnd - stallStart;
  if (stallLen < stallMinLen || stallLen > stallMaxLen) {
    i = stallEnd; // Skip past this region
    continue;
  }

  // Compute average local d1 in the stall
  let localSum = 0;
  for (let j = stallStart; j < stallEnd; j++) localSum += absD1[j]!;
  const localD1 = localSum / stallLen;

  stalls.push({
    position: stallStart,
    length: stallLen,
    localD1,
    expectedD1,
    ratio: localD1 / expectedD1,
    timeSec: stallStart / sr,
  });

  i = stallEnd + contextWindow; // Skip past this stall + context
}

console.log(`═══ Detected Stalls: ${stalls.length} ═══\n`);

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
  const inRegion = stalls.filter((s) => s.timeSec >= r.start && s.timeSec < r.end);
  if (inRegion.length > 0) {
    console.log(`  ${r.label.padEnd(8)}: ${String(inRegion.length).padStart(4)} stalls`);
  }
}

// Show details
console.log(`\n  First ${Math.min(40, stalls.length)} stalls:`);
console.log('  Time(s)   | Pos       | Len | LocalD1    | ExpectedD1 | Ratio  | Samples');
console.log('  ' + '-'.repeat(95));

for (const s of stalls.slice(0, 40)) {
  // Show a few samples around the stall
  const ctx = 3;
  const before = Array.from(
    { length: ctx },
    (_, k) => ch0[s.position - ctx + k]?.toFixed(4) ?? '?',
  );
  const during = Array.from(
    { length: Math.min(s.length, 6) },
    (_, k) => ch0[s.position + k]?.toFixed(4) ?? '?',
  );
  const after = Array.from(
    { length: ctx },
    (_, k) => ch0[s.position + s.length + k]?.toFixed(4) ?? '?',
  );

  const samplesStr = `[${before.join(',')}] |${during.join(',')}${s.length > 6 ? '...' : ''}| [${after.join(',')}]`;

  console.log(
    `  ${s.timeSec.toFixed(4).padStart(9)} | ${String(s.position).padStart(9)} | ${String(s.length).padStart(3)} | ${s.localD1.toFixed(6).padStart(10)} | ${s.expectedD1.toFixed(6).padStart(10)} | ${s.ratio.toFixed(3).padStart(6)} | ${samplesStr}`,
  );
}

// Also dump raw samples around first few stalls in detail
if (stalls.length > 0) {
  console.log(`\n═══ Detailed Sample Dump (first 5 stalls) ═══`);
  for (const s of stalls.slice(0, 5)) {
    const margin = 8;
    console.log(`\n  Stall at ${s.timeSec.toFixed(4)}s (pos=${s.position}, len=${s.length}):`);
    console.log('  Offset | Sample     | d1         | Note');
    console.log('  ' + '-'.repeat(55));
    for (let i = s.position - margin; i < s.position + s.length + margin; i++) {
      const val = ch0[i]?.toFixed(6) ?? '?';
      const d = i > 0 ? (ch0[i]! - ch0[i - 1]!).toFixed(6) : '?';
      let note = '';
      if (i === s.position) note = '<-- stall start';
      if (i === s.position + s.length) note = '<-- stall end';
      console.log(
        `  ${String(i - s.position).padStart(6)} | ${val.padStart(10)} | ${String(d).padStart(10)} | ${note}`,
      );
    }
  }
}
