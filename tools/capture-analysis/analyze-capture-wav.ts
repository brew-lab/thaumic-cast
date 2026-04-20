/**
 * Capture WAV Analysis — sample-level artifact inspection
 *
 * Input: Float32 interleaved WAV + events JSON (gap/zero-block positions from capture worker)
 * Output: Raw measurements at each gap, zero-block sample dumps, run scan, quantum alignment
 */
import { readFileSync } from 'fs';

function parseWav(buf: Buffer): { sampleRate: number; channels: number; samples: Float32Array } {
  if (buf.length < 44) throw new Error('File too small to be a valid WAV');
  const riff = String.fromCharCode(...buf.subarray(0, 4));
  const wave = String.fromCharCode(...buf.subarray(8, 12));
  if (riff !== 'RIFF' || wave !== 'WAVE') throw new Error(`Not a WAV file (got ${riff}/${wave})`);
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

interface DiagnosticEvent {
  type: 'gap' | 'overlap' | 'zero_block';
  wallClockMs: number;
  frameIndex: number;
  sampleOffset?: number;
  durationUs: number;
  expectedTimestamp: number;
  actualTimestamp: number;
}

const args = process.argv.slice(2);
const nonFlags = args.filter((a) => !a.startsWith('--'));
const wavPath = nonFlags[0];
const eventsPath = nonFlags[1];
if (!wavPath || !eventsPath) {
  console.error(
    'Usage: bun run tools/capture-analysis/analyze-capture-wav.ts <capture.wav> <events.json>',
  );
  process.exit(1);
}

const wav = parseWav(readFileSync(wavPath));
const totalInterleaved = wav.samples.length;
const n = Math.floor(totalInterleaved / wav.channels);
const sr = wav.sampleRate;

// Deinterleave channel 0
const ch0 = new Float32Array(n);
for (let i = 0; i < n; i++) ch0[i] = wav.samples[i * wav.channels]!;

const events: DiagnosticEvent[] = JSON.parse(readFileSync(eventsPath, 'utf-8'));
const gaps = events.filter((e) => e.type === 'gap');
const zeroBlockEvents = events.filter((e) => e.type === 'zero_block');

// ─── Section 1: File info ────────────────────────────────────────────────────

console.log(`\n═══ Capture WAV Analysis: ${wavPath} ═══`);
console.log(`  Duration:     ${(n / sr).toFixed(2)} s`);
console.log(`  Sample rate:  ${sr} Hz`);
console.log(`  Channels:     ${wav.channels}`);
console.log(`  Total samples (interleaved): ${totalInterleaved}`);
console.log(`  Per-channel:  ${n}`);
console.log(`  File size:    ${(readFileSync(wavPath).byteLength / (1024 * 1024)).toFixed(2)} MB`);
console.log(`  Gap events:   ${gaps.length}`);
console.log(`  Zero-block events: ${zeroBlockEvents.length}`);
const hasSampleOffset = gaps.length > 0 && gaps[0]!.sampleOffset != null;
console.log(
  `  Mapping:      ${hasSampleOffset ? 'sampleOffset (exact)' : 'wallClockMs (estimated)'}`,
);

/**
 * Returns the per-channel sample position for a diagnostic event.
 * Uses sampleOffset when available, falls back to wall-clock estimation.
 */
function eventSamplePos(event: DiagnosticEvent): number {
  if (event.sampleOffset != null) return event.sampleOffset;
  return Math.round((event.wallClockMs / 1000) * sr);
}

/**
 * Computes RMS of a segment of the deinterleaved channel.
 */
function rms(data: Float32Array, start: number, len: number): number {
  let sum = 0;
  const s = Math.max(0, start);
  const e = Math.min(s + len, data.length);
  let count = 0;
  for (let i = s; i < e; i++) {
    sum += data[i]! * data[i]!;
    count++;
  }
  return count > 0 ? Math.sqrt(sum / count) : 0;
}

/**
 * Formats a float for sample display.
 */
function fmt(v: number): string {
  return v.toFixed(4).padStart(8);
}

// ─── Section 2: Per-gap raw measurements ─────────────────────────────────────

console.log(`\n─── Per-Gap Raw Measurements (all ${gaps.length}) ───`);

for (let gi = 0; gi < gaps.length; gi++) {
  const gap = gaps[gi]!;
  const pos = eventSamplePos(gap);
  if (pos < 0 || pos >= n) {
    console.log(
      `\nGap #${gi + 1} at ${(gap.wallClockMs / 1000).toFixed(3)}s — sample ${pos} out of range (${n} per-channel samples)`,
    );
    continue;
  }

  // Zeros before/after
  let zerosBefore = 0;
  for (let j = pos - 1; j >= 0 && Math.abs(ch0[j]!) < 1e-6; j--) zerosBefore++;
  let zerosAfter = 0;
  for (let j = pos; j < n && Math.abs(ch0[j]!) < 1e-6; j++) zerosAfter++;

  // Exact-repeat: longest match of samples at pos against preceding 128
  let repeatLen = 0;
  if (pos >= 128 && pos + 128 <= n) {
    for (let k = 0; k < 128; k++) {
      if (Math.abs(ch0[pos + k]! - ch0[pos - 128 + k]!) > 1e-10) break;
      repeatLen++;
    }
  }

  // RMS before/after
  const preRMS = rms(ch0, pos - 128, 128);
  const postRMS = rms(ch0, pos, 128);
  const dB = preRMS > 0 && postRMS > 0 ? 20 * Math.log10(postRMS / preRMS) : 0;

  // Jump: raw step size at boundary
  const jump = pos > 0 ? Math.abs(ch0[pos]! - ch0[pos - 1]!) : 0;

  // LocalMedianΔ: median inter-sample delta of preceding 128 samples
  const localDeltas: number[] = [];
  const ldStart = Math.max(1, pos - 128);
  for (let j = ldStart; j < pos; j++) {
    localDeltas.push(Math.abs(ch0[j]! - ch0[j - 1]!));
  }
  localDeltas.sort((a, b) => a - b);
  const localMedianDelta =
    localDeltas.length > 0 ? localDeltas[Math.floor(localDeltas.length / 2)]! : 0;
  const jumpRatio = localMedianDelta > 0 ? jump / localMedianDelta : 0;

  // 4 samples before / 4 after
  const before = Array.from({ length: 4 }, (_, k) => {
    const idx = pos - 4 + k;
    return idx >= 0 && idx < n ? fmt(ch0[idx]!) : '     N/A';
  });
  const after = Array.from({ length: 4 }, (_, k) => {
    const idx = pos + k;
    return idx >= 0 && idx < n ? fmt(ch0[idx]!) : '     N/A';
  });

  console.log(
    `\nGap #${gi + 1} at ${(gap.wallClockMs / 1000).toFixed(3)}s (sample ${pos}, frame ${gap.frameIndex}):`,
  );
  console.log(`  before: [${before.join(', ')}]`);
  console.log(`  after:  [${after.join(', ')}]`);
  console.log(
    `  zeros=${zerosBefore}/${zerosAfter} repeat=${repeatLen} preRMS=${preRMS.toFixed(4)} postRMS=${postRMS.toFixed(4)} dB=${dB.toFixed(1)} jump=${jump.toFixed(4)} jumpRatio=${jumpRatio.toFixed(1)} localMedianΔ=${localMedianDelta.toFixed(4)}`,
  );
}

// ─── Section 3: Zero-block event sample dump ─────────────────────────────────

if (zeroBlockEvents.length > 0) {
  console.log(`\n─── Zero-Block Event Sample Dump (all ${zeroBlockEvents.length}) ───`);

  for (let zi = 0; zi < zeroBlockEvents.length; zi++) {
    const zb = zeroBlockEvents[zi]!;
    const pos = eventSamplePos(zb);
    if (pos < 0 || pos >= n) continue;

    // Compute energy the same way the worker does: sum of squares / count
    // Worker uses ~441 samples per frame; approximate by looking at 441 samples
    const frameLen = Math.min(441, n - pos);
    let energy = 0;
    for (let i = 0; i < frameLen; i++) energy += ch0[pos + i]! * ch0[pos + i]!;
    energy /= frameLen;

    // 4 samples from middle of the frame
    const mid = pos + Math.floor(frameLen / 2);
    const midSamples = Array.from({ length: 4 }, (_, k) => {
      const idx = mid - 2 + k;
      return idx >= 0 && idx < n ? fmt(ch0[idx]!) : '     N/A';
    });

    // Max absolute value in the frame
    let maxAbs = 0;
    for (let i = 0; i < frameLen; i++) {
      const a = Math.abs(ch0[pos + i]!);
      if (a > maxAbs) maxAbs = a;
    }

    console.log(
      `  ZB#${String(zi + 1).padStart(3)} t=${(zb.wallClockMs / 1000).toFixed(3)}s sample=${pos} energy=${energy.toExponential(3)} maxAbs=${maxAbs.toExponential(3)} mid=[${midSamples.join(', ')}]`,
    );
  }
}

// ─── Section 4: Zero-block scan (independent WAV detection) ──────────────────

interface ZeroRun {
  start: number;
  length: number;
  timeSec: number;
  type: 'near-zero' | 'exact-repeat';
}

const zeroRuns: ZeroRun[] = [];
const repeatRuns: ZeroRun[] = [];

const MIN_ZERO_RUN = 32;
{
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(ch0[i]!) < 1e-6) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0) {
        const len = i - runStart;
        if (len >= MIN_ZERO_RUN) {
          zeroRuns.push({
            start: runStart,
            length: len,
            timeSec: runStart / sr,
            type: 'near-zero',
          });
        }
        runStart = -1;
      }
    }
  }
  if (runStart >= 0 && n - runStart >= MIN_ZERO_RUN) {
    zeroRuns.push({
      start: runStart,
      length: n - runStart,
      timeSec: runStart / sr,
      type: 'near-zero',
    });
  }
}

{
  let runStart = -1;
  let runLen = 0;
  for (let i = 128; i < n; i++) {
    if (Math.abs(ch0[i]! - ch0[i - 128]!) < 1e-10) {
      if (runStart < 0) runStart = i;
      runLen++;
    } else {
      if (runStart >= 0 && runLen >= MIN_ZERO_RUN) {
        repeatRuns.push({
          start: runStart,
          length: runLen,
          timeSec: runStart / sr,
          type: 'exact-repeat',
        });
      }
      runStart = -1;
      runLen = 0;
    }
  }
  if (runStart >= 0 && runLen >= MIN_ZERO_RUN) {
    repeatRuns.push({
      start: runStart,
      length: runLen,
      timeSec: runStart / sr,
      type: 'exact-repeat',
    });
  }
}

// Interleaved sanity check
{
  let intRunStart = -1;
  let intRunCount = 0;
  const minIntRun = MIN_ZERO_RUN * wav.channels;
  for (let i = 0; i < totalInterleaved; i++) {
    if (Math.abs(wav.samples[i]!) < 1e-6) {
      if (intRunStart < 0) intRunStart = i;
    } else {
      if (intRunStart >= 0 && i - intRunStart >= minIntRun) intRunCount++;
      intRunStart = -1;
    }
  }
  if (intRunStart >= 0 && totalInterleaved - intRunStart >= minIntRun) intRunCount++;

  if (intRunCount !== zeroRuns.length) {
    console.log(`\n─── Deinterleave Sanity Check ───`);
    console.log(`  Interleaved zero runs (≥${minIntRun} samples): ${intRunCount}`);
    console.log(`  Deinterleaved ch0 zero runs (≥${MIN_ZERO_RUN} samples): ${zeroRuns.length}`);
    if (intRunCount > zeroRuns.length) {
      console.log(
        `  ⚠ ${intRunCount - zeroRuns.length} runs present in interleaved but missing from ch0 — possible deinterleave issue`,
      );
    }
  }
}

console.log(`\n─── Zero-Block Scan ───`);
console.log(`  Near-zero runs (≥${MIN_ZERO_RUN} samples): ${zeroRuns.length}`);
if (zeroRuns.length > 0) {
  console.log(
    `  ${'#'.padStart(4)} | ${'Position'.padStart(9)} | ${'Length'.padStart(7)} | ${'Time(s)'.padStart(8)}`,
  );
  console.log(`  ${'-'.repeat(38)}`);
  for (let i = 0; i < Math.min(40, zeroRuns.length); i++) {
    const r = zeroRuns[i]!;
    console.log(
      `  ${String(i + 1).padStart(4)} | ${String(r.start).padStart(9)} | ${String(r.length).padStart(7)} | ${r.timeSec.toFixed(3).padStart(8)}`,
    );
  }
}

console.log(`\n  Exact-repeat runs (≥${MIN_ZERO_RUN} samples): ${repeatRuns.length}`);
if (repeatRuns.length > 0) {
  console.log(
    `  ${'#'.padStart(4)} | ${'Position'.padStart(9)} | ${'Length'.padStart(7)} | ${'Time(s)'.padStart(8)}`,
  );
  console.log(`  ${'-'.repeat(38)}`);
  for (let i = 0; i < Math.min(40, repeatRuns.length); i++) {
    const r = repeatRuns[i]!;
    console.log(
      `  ${String(i + 1).padStart(4)} | ${String(r.start).padStart(9)} | ${String(r.length).padStart(7)} | ${r.timeSec.toFixed(3).padStart(8)}`,
    );
  }
}

// ─── Section 5: Quantum alignment ────────────────────────────────────────────

const allRuns = [...zeroRuns, ...repeatRuns];

if (allRuns.length > 0) {
  console.log(`\n─── Quantum Alignment ───`);
  const QUANTUM = 128;

  let startAligned = 0,
    lenAligned = 0;
  const quantumMultiples: Record<string, number> = {};

  for (const run of allRuns) {
    if (run.start % QUANTUM === 0) startAligned++;
    if (run.length % QUANTUM === 0) lenAligned++;
    const quanta = Math.round(run.length / QUANTUM);
    const key = quanta <= 3 ? `${quanta}Q` : '4Q+';
    quantumMultiples[key] = (quantumMultiples[key] || 0) + 1;
  }

  const startPct = ((startAligned / allRuns.length) * 100).toFixed(1);
  const lenPct = ((lenAligned / allRuns.length) * 100).toFixed(1);

  console.log(`  Start aligned to 128: ${startAligned}/${allRuns.length} (${startPct}%)`);
  console.log(`  Length aligned to 128: ${lenAligned}/${allRuns.length} (${lenPct}%)`);
  console.log(`\n  Length distribution:`);
  for (const [key, count] of Object.entries(quantumMultiples).sort()) {
    console.log(`    ${key.padEnd(4)}: ${count}`);
  }

  if (parseFloat(lenPct) > 80) {
    console.log(`\n  → Confirmed: render-quantum-aligned underruns`);
  }
}

// ─── Section 6: Cross-reference (events vs zero/repeat runs) ─────────────────

if (gaps.length > 0 || allRuns.length > 0) {
  console.log(`\n─── Cross-Reference (Events vs Runs) ───`);

  let gapsWithRun = 0;
  let gapsWithoutRun = 0;
  let runsWithoutGap = 0;

  for (const gap of gaps) {
    const gapSamplePos = eventSamplePos(gap);
    const hasAdjacentRun = allRuns.some(
      (r) =>
        Math.abs(r.start - gapSamplePos) <= 256 ||
        (gapSamplePos >= r.start && gapSamplePos <= r.start + r.length),
    );
    if (hasAdjacentRun) gapsWithRun++;
    else gapsWithoutRun++;
  }

  for (const run of allRuns) {
    const hasGap = gaps.some((gap) => {
      const gapSamplePos = eventSamplePos(gap);
      return (
        Math.abs(run.start - gapSamplePos) <= 256 ||
        (gapSamplePos >= run.start && gapSamplePos <= run.start + run.length)
      );
    });
    if (!hasGap) runsWithoutGap++;
  }

  console.log(`  Gap events with adjacent zero/repeat run: ${gapsWithRun}`);
  console.log(`  Gap events without (timestamp-only gap):  ${gapsWithoutRun}`);
  console.log(`  Runs without gap event (hidden underrun): ${runsWithoutGap}`);
}
