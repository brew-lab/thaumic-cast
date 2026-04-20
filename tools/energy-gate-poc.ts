/**
 * Energy Gate Proof-of-Concept
 *
 * Simulates the MSTP pipeline: processes audio in sequential AudioData-sized
 * chunks (like Chrome delivers), detects per-chunk energy drops relative to
 * a running average, and repairs by crossfading through the dropout.
 *
 * This is the exact approach that would be implemented in processAudioData()
 * in audio-relay.worker.ts.
 *
 * Usage:
 *   bun run tools/energy-gate-poc.ts <input.wav> [options]
 *
 * Options:
 *   --chunk=N        AudioData frame size in samples (default: 441)
 *   --drop-db=N      Energy drop threshold in dB (default: 10)
 *   --ema-alpha=N    EMA smoothing factor (default: 0.05)
 *   --min-energy=N   Minimum context energy to trigger detection (default: 1e-6)
 *   --no-repair      Detection only, no repair
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

function writeWavFloat32(
  path: string,
  samples: Float32Array,
  sampleRate: number,
  channels: number,
): void {
  const dataSize = samples.length * 4;
  const header = new ArrayBuffer(44);
  const v = new DataView(header);
  const ws = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  ws(0, 'RIFF');
  v.setUint32(4, 36 + dataSize, true);
  ws(8, 'WAVE');
  ws(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 3, true);
  v.setUint16(22, channels, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * channels * 4, true);
  v.setUint16(32, channels * 4, true);
  v.setUint16(34, 32, true);
  ws(36, 'data');
  v.setUint32(40, dataSize, true);
  writeFileSync(
    path,
    Buffer.concat([
      Buffer.from(header),
      Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength),
    ]),
  );
}

// ─── Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));

function getOpt(name: string, def: number): number {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? parseFloat(arg.split('=')[1]!) : def;
}
const noRepair = args.includes('--no-repair');

const chunkSize = getOpt('chunk', 441); // AudioData frame size (samples per channel)
const dropDb = getOpt('drop-db', 10); // Energy drop threshold
const emaAlpha = getOpt('ema-alpha', 0.05); // EMA smoothing (lower = slower adaptation)
const minEnergy = getOpt('min-energy', 1e-6); // Minimum energy to trigger detection

if (!filePath) {
  console.error('Usage: bun run tools/energy-gate-poc.ts <input.wav> [options]');
  process.exit(1);
}

const dropLinear = Math.pow(10, -dropDb / 10); // Energy ratio threshold

const wav = parseWav(readFileSync(filePath));
const n = Math.floor(wav.samples.length / wav.channels);
const sr = wav.sampleRate;

console.log(`\nEnergy Gate PoC: ${filePath}`);
console.log(`  ${sr}Hz, ${wav.channels}ch, ${(n / sr).toFixed(2)}s`);
console.log(`  Chunk size: ${chunkSize} samples (${((chunkSize / sr) * 1000).toFixed(1)}ms)`);
console.log(`  Drop threshold: ${dropDb} dB`);
console.log(`  EMA alpha: ${emaAlpha}`);
console.log(`  Repair: ${noRepair ? 'disabled' : 'enabled'}`);

// Extract per-channel data
const channels: Float32Array[] = [];
for (let ch = 0; ch < wav.channels; ch++) {
  const data = new Float32Array(n);
  for (let i = 0; i < n; i++) data[i] = wav.samples[i * wav.channels + ch]!;
  channels.push(data);
}

// ─── Process each channel ──────────────────────────────────────────────────

interface DropoutEvent {
  chunkIndex: number;
  samplePos: number;
  timeSec: number;
  chunkEnergy: number;
  contextEnergy: number;
  dropDb: number;
  channel: number;
}

const allDropouts: DropoutEvent[] = [];
const correctedChannels: Float32Array[] = [];

for (let ch = 0; ch < wav.channels; ch++) {
  const mono = channels[ch]!;
  const corrected = new Float32Array(mono);
  const numChunks = Math.floor(n / chunkSize);

  let emaEnergy = 0; // Exponential moving average of chunk energy
  let emaInitialized = false; // Wait for first non-silent chunk
  let prevChunkEnd = 0; // Last sample of the previous good chunk

  // Keep a copy of the last good chunk's tail for crossfade repair
  const crossfadeLen = Math.min(16, chunkSize);
  let lastGoodTail = new Float32Array(crossfadeLen);
  let hasLastGoodTail = false;

  for (let ci = 0; ci < numChunks; ci++) {
    const start = ci * chunkSize;
    const end = start + chunkSize;

    // Compute RMS energy of this chunk
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      sumSq += mono[i]! * mono[i]!;
    }
    const chunkEnergy = sumSq / chunkSize;

    // Update EMA (only from non-dropout chunks)
    if (!emaInitialized) {
      if (chunkEnergy > minEnergy) {
        emaEnergy = chunkEnergy;
        emaInitialized = true;
      }
      // Store tail as "last good"
      for (let i = 0; i < crossfadeLen; i++) {
        lastGoodTail[i] = mono[end - crossfadeLen + i]!;
      }
      hasLastGoodTail = true;
      continue;
    }

    // Detection: is this chunk's energy much lower than expected?
    const ratio = chunkEnergy / emaEnergy;
    const isDropout = ratio < dropLinear && emaEnergy > minEnergy;

    if (isDropout) {
      const db = 10 * Math.log10(ratio);
      allDropouts.push({
        chunkIndex: ci,
        samplePos: start,
        timeSec: start / sr,
        chunkEnergy,
        contextEnergy: emaEnergy,
        dropDb: db,
        channel: ch,
      });

      // Repair: crossfade from last good tail to next chunk's start
      if (!noRepair && hasLastGoodTail) {
        // Find next good chunk's start for crossfade target
        // Look ahead up to 3 chunks to find the resume point
        let resumeStart = end;
        for (let ahead = 1; ahead <= 3 && ci + ahead < numChunks; ahead++) {
          const aStart = (ci + ahead) * chunkSize;
          const aEnd = aStart + chunkSize;
          let aSumSq = 0;
          for (let i = aStart; i < aEnd; i++) aSumSq += mono[i]! * mono[i]!;
          const aEnergy = aSumSq / chunkSize;
          if (aEnergy / emaEnergy >= dropLinear) {
            resumeStart = aStart;
            break;
          }
        }

        // Linear crossfade through the dropout region
        const gapStart = start;
        const gapEnd = resumeStart;
        const gapLen = gapEnd - gapStart;

        if (gapLen > 0 && gapLen <= chunkSize * 4) {
          // Get values at boundaries
          const preVal = lastGoodTail[crossfadeLen - 1]!;
          const postVal = mono[gapEnd] ?? preVal;

          // Simple linear interpolation through the gap
          for (let i = 0; i < gapLen; i++) {
            const t = (i + 1) / (gapLen + 1);
            corrected[gapStart + i] = preVal * (1 - t) + postVal * t;
          }
        }
      }

      // Don't update EMA from dropout chunks
      continue;
    }

    // Good chunk: update EMA and store tail
    emaEnergy = emaAlpha * chunkEnergy + (1 - emaAlpha) * emaEnergy;
    for (let i = 0; i < crossfadeLen; i++) {
      lastGoodTail[i] = mono[end - crossfadeLen + i]!;
    }
    hasLastGoodTail = true;
  }

  correctedChannels.push(corrected);
}

// ─── Cross-channel confirmation ──────────────────────────────────────────

// Group dropouts by chunk index — both channels must detect
const ch0Drops = allDropouts.filter((d) => d.channel === 0);
const ch1Drops = allDropouts.filter((d) => d.channel === 1);

let confirmed: DropoutEvent[];
if (wav.channels >= 2) {
  confirmed = [];
  for (const d0 of ch0Drops) {
    const match = ch1Drops.find((d1) => Math.abs(d1.chunkIndex - d0.chunkIndex) <= 1);
    if (match) {
      confirmed.push(d0);
    }
  }
} else {
  confirmed = ch0Drops;
}

// ─── Results ───────────────────────────────────────────────────────────────

console.log(`\n═══ Results ═══`);
console.log(
  `  Per-channel: ch0=${ch0Drops.length}${wav.channels >= 2 ? `, ch1=${ch1Drops.length}` : ''}`,
);
console.log(`  Cross-channel confirmed: ${confirmed.length}`);
console.log(`  Detection rate: ${(confirmed.length / (n / sr)).toFixed(1)}/sec`);

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
  const inRegion = confirmed.filter((d) => d.timeSec >= r.start && d.timeSec < r.end);
  if (inRegion.length > 0) {
    console.log(`  ${r.label.padEnd(8)}: ${String(inRegion.length).padStart(4)} dropouts`);
  }
}

// Show first events
console.log(`\n  First ${Math.min(30, confirmed.length)} confirmed dropouts:`);
console.log('  Time(s)   | Chunk  | ChunkE       | ContextE     | DropDB');
console.log('  ' + '-'.repeat(65));
for (const d of confirmed.slice(0, 30)) {
  console.log(
    `  ${d.timeSec.toFixed(4).padStart(9)} | ${String(d.chunkIndex).padStart(6)} | ${d.chunkEnergy.toExponential(3).padStart(12)} | ${d.contextEnergy.toExponential(3).padStart(12)} | ${d.dropDb.toFixed(1).padStart(6)}`,
  );
}

// d² comparison
if (!noRepair) {
  let origD2 = 0,
    fixedD2 = 0;
  for (let i = 2; i < n; i++) {
    if (Math.abs(channels[0]![i]! - 2 * channels[0]![i - 1]! + channels[0]![i - 2]!) > 0.005)
      origD2++;
    if (
      Math.abs(
        correctedChannels[0]![i]! -
          2 * correctedChannels[0]![i - 1]! +
          correctedChannels[0]![i - 2]!,
      ) > 0.005
    )
      fixedD2++;
  }
  console.log(
    `\n  d² discontinuities (ch0): ${origD2} → ${fixedD2} (${origD2 > 0 ? ((1 - fixedD2 / origD2) * 100).toFixed(1) : 0}% reduction)`,
  );

  // Write output
  const outSamples = new Float32Array(n * wav.channels);
  for (let i = 0; i < n; i++) {
    for (let ch = 0; ch < wav.channels; ch++) {
      outSamples[i * wav.channels + ch] = correctedChannels[ch]![i]!;
    }
  }

  const dir = dirname(resolve(filePath));
  const base = basename(filePath, '.wav');
  const outPath = resolve(dir, `${base}-energy-fixed.wav`);
  writeWavFloat32(outPath, outSamples, sr, wav.channels);
  console.log(`\n  Output: ${outPath}`);
}
