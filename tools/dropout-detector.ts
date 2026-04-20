/**
 * Dropout Detector — finds brief micro-mute artifacts
 *
 * From sine wave analysis: buffer dropout replaces normal samples with
 * near-zero oscillation (silence/dither). For music, this = brief energy drop.
 *
 * Detection:
 * 1. Compute short-window energy (8-sample blocks)
 * 2. Compare against surrounding context energy
 * 3. Find blocks where energy drops significantly in BOTH channels simultaneously
 * 4. This is the signature of AudioWorklet buffer underrun
 */
import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';

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

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
if (!filePath) {
  console.error('Usage: bun run tools/dropout-detector.ts <input.wav>');
  process.exit(1);
}

function getOpt(name: string, def: number): number {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseFloat(arg.split('=')[1]!) : def;
}

const blockSize = getOpt('block', 8); // energy measurement block
const contextBlocks = getOpt('context', 32); // context window in blocks
const dropThreshDb = getOpt('drop-db', 12); // minimum energy drop in dB
const gapBlocks = getOpt('gap', 4); // gap between context and test (blocks)
const maxDropoutBlocks = getOpt('max-blocks', 16); // max dropout length in blocks
const crossChannel = getOpt('cross', 1) !== 0; // require both channels

const wav = parseWav(readFileSync(filePath));
const n = Math.floor(wav.samples.length / wav.channels);
const sr = wav.sampleRate;
const numBlocks = Math.floor(n / blockSize);

console.log(`\nDropout Detector: ${filePath}`);
console.log(`  ${sr}Hz, ${wav.channels}ch, ${(n / sr).toFixed(2)}s`);
console.log(`  Block: ${blockSize} samples (${((blockSize / sr) * 1000).toFixed(3)}ms)`);
console.log(`  Context: ${contextBlocks} blocks`);
console.log(`  Drop threshold: ${dropThreshDb} dB`);
console.log(`  Cross-channel: ${crossChannel}`);

// Extract channels
const channels: Float32Array[] = [];
for (let ch = 0; ch < wav.channels; ch++) {
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = wav.samples[i * wav.channels + ch]!;
  channels.push(data);
}

// Compute per-block energy for each channel
function blockEnergy(ch: Float32Array, blockIdx: number): number {
  const start = blockIdx * blockSize;
  const end = Math.min(start + blockSize, ch.length);
  let sum = 0;
  for (let i = start; i < end; i++) sum += ch[i]! * ch[i]!;
  return sum / (end - start);
}

interface DropoutEvent {
  blockStart: number;
  blockLen: number;
  samplePos: number;
  timeSec: number;
  dropDb: number; // energy drop in dB
  contextEnergy: number;
  dropoutEnergy: number;
}

const dropThreshLinear = Math.pow(10, -dropThreshDb / 10); // energy ratio

function detectDropouts(ch: Float32Array): DropoutEvent[] {
  const events: DropoutEvent[] = [];
  const energyArr = new Float64Array(numBlocks);
  for (let b = 0; b < numBlocks; b++) energyArr[b] = blockEnergy(ch, b);

  for (let b = contextBlocks + gapBlocks; b < numBlocks - contextBlocks - gapBlocks; b++) {
    // Context energy (before and after, with gap to exclude the dropout itself)
    let ctxBefore = 0;
    for (let j = b - gapBlocks - contextBlocks; j < b - gapBlocks; j++) {
      ctxBefore += energyArr[j]!;
    }
    ctxBefore /= contextBlocks;

    let ctxAfter = 0;
    for (let j = b + gapBlocks + 1; j <= b + gapBlocks + contextBlocks; j++) {
      if (j < numBlocks) ctxAfter += energyArr[j]!;
    }
    ctxAfter /= contextBlocks;

    const contextEnergy = Math.max(ctxBefore, ctxAfter);
    if (contextEnergy < 1e-10) continue; // silence

    const blockE = energyArr[b]!;
    const ratio = blockE / contextEnergy;

    if (ratio < dropThreshLinear) {
      // Found a dropout block — measure extent
      let dropStart = b;
      while (dropStart > 0 && energyArr[dropStart - 1]! / contextEnergy < dropThreshLinear * 2) {
        dropStart--;
      }
      let dropEnd = b + 1;
      while (dropEnd < numBlocks && energyArr[dropEnd]! / contextEnergy < dropThreshLinear * 2) {
        dropEnd++;
      }

      const dropLen = dropEnd - dropStart;
      if (dropLen > maxDropoutBlocks) {
        b = dropEnd;
        continue;
      }

      // Average energy in dropout
      let dropEnergy = 0;
      for (let j = dropStart; j < dropEnd; j++) dropEnergy += energyArr[j]!;
      dropEnergy /= dropLen;

      const dropDb = 10 * Math.log10(dropEnergy / contextEnergy);

      events.push({
        blockStart: dropStart,
        blockLen: dropLen,
        samplePos: dropStart * blockSize,
        timeSec: (dropStart * blockSize) / sr,
        dropDb,
        contextEnergy,
        dropoutEnergy: dropEnergy,
      });

      b = dropEnd + gapBlocks; // skip past this dropout
    }
  }

  return events;
}

const perChannelDropouts: DropoutEvent[][] = [];
for (let ch = 0; ch < wav.channels; ch++) {
  perChannelDropouts.push(detectDropouts(channels[ch]!));
}

// Cross-channel confirmation
let confirmed: DropoutEvent[];
if (crossChannel && wav.channels >= 2) {
  confirmed = [];
  const ch1 = perChannelDropouts[1]!;
  for (const d0 of perChannelDropouts[0]!) {
    const match = ch1.find((d1) => Math.abs(d1.samplePos - d0.samplePos) <= blockSize * 4);
    if (match) {
      confirmed.push({
        ...d0,
        dropDb: Math.max(d0.dropDb, match.dropDb), // worst drop
      });
    }
  }
} else {
  confirmed = perChannelDropouts[0]!;
}

// Deduplicate
confirmed.sort((a, b) => a.samplePos - b.samplePos);
const deduped: DropoutEvent[] = [];
for (const d of confirmed) {
  const last = deduped[deduped.length - 1];
  if (last && d.samplePos - (last.samplePos + last.blockLen * blockSize) < blockSize * 4) {
    last.blockLen = Math.max(
      last.blockLen,
      (d.samplePos + d.blockLen * blockSize - last.samplePos) / blockSize,
    );
    last.dropDb = Math.min(last.dropDb, d.dropDb);
  } else {
    deduped.push({ ...d });
  }
}

console.log(`\n═══ Results ═══`);
console.log(
  `  Per-channel: ch0=${perChannelDropouts[0]!.length}${wav.channels >= 2 ? `, ch1=${perChannelDropouts[1]!.length}` : ''}`,
);
console.log(`  Cross-channel confirmed: ${deduped.length}`);

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

console.log(`\n  By time region:`);
for (const r of regions) {
  const inRegion = deduped.filter((d) => d.timeSec >= r.start && d.timeSec < r.end);
  if (inRegion.length > 0) {
    console.log(`  ${r.label.padEnd(8)}: ${String(inRegion.length).padStart(4)} dropouts`);
  }
}

// Show events
console.log(`\n  First ${Math.min(40, deduped.length)} dropouts:`);
console.log('  Time(s)   | Pos       | Blocks | DropDB   | CtxEnergy  | DropEnergy');
console.log('  ' + '-'.repeat(75));
for (const d of deduped.slice(0, 40)) {
  console.log(
    `  ${d.timeSec.toFixed(4).padStart(9)} | ${String(d.samplePos).padStart(9)} | ${String(d.blockLen).padStart(6)} | ${d.dropDb.toFixed(1).padStart(8)} | ${d.contextEnergy.toExponential(3).padStart(10)} | ${d.dropoutEnergy.toExponential(3).padStart(10)}`,
  );
}

// Show sample values around top dropouts
console.log(`\n═══ Sample Dump (first 5 dropouts) ═══`);
for (const d of deduped.slice(0, 5)) {
  const margin = 8;
  const dropStart = d.samplePos;
  const dropEnd = dropStart + d.blockLen * blockSize;
  console.log(
    `\n  Dropout at ${d.timeSec.toFixed(4)}s (pos=${dropStart}, ${d.blockLen} blocks = ${d.blockLen * blockSize} samples, ${d.dropDb.toFixed(1)}dB drop):`,
  );
  console.log('  ch0 samples: [before...] | [dropout...] | [after...]');
  const before = Array.from(
    { length: margin },
    (_, k) => channels[0]![dropStart - margin + k]?.toFixed(4) ?? '?',
  );
  const during = Array.from(
    { length: Math.min(d.blockLen * blockSize, 16) },
    (_, k) => channels[0]![dropStart + k]?.toFixed(4) ?? '?',
  );
  const after = Array.from(
    { length: margin },
    (_, k) => channels[0]![dropEnd + k]?.toFixed(4) ?? '?',
  );
  console.log(
    `  [${before.join(', ')}] | [${during.join(', ')}${d.blockLen * blockSize > 16 ? '...' : ''}] | [${after.join(', ')}]`,
  );
}
