/**
 * Combined Capture Analysis — runs timing, events, and WAV analysis
 * then synthesizes a diagnosis with recommendations.
 *
 * Input: capture.wav, events.json, timing.bin
 * Output: Condensed summaries from each + combined diagnosis block
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
const nonFlags = args.filter((a) => !a.startsWith('--'));
const [wavPath, eventsPath, timingPath] = nonFlags;
const summaryCsvPath = args.find((a) => a.startsWith('--summary-csv='))?.split('=')[1];

if (!wavPath || !eventsPath || !timingPath) {
  console.error(
    'Usage: bun run tools/analyze-capture-all.ts <capture.wav> <events.json> <timing.bin> [--summary-csv=FILE]',
  );
  process.exit(1);
}

// ─── Stats helpers ───────────────────────────────────────────────────────────

function mean(arr: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) sum += arr[i]!;
  return sum / arr.length;
}

function stddev(arr: Float32Array, m: number): number {
  let sum = 0;
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i]! - m;
    sum += d * d;
  }
  return Math.sqrt(sum / arr.length);
}

function percentile(sorted: Float32Array, p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function fMedian(sorted: Float32Array): number {
  return percentile(sorted, 50);
}

// ─── WAV parser ──────────────────────────────────────────────────────────────

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

// ─── DiagnosticEvent type ────────────────────────────────────────────────────

interface DiagnosticEvent {
  type: 'gap' | 'overlap' | 'zero_block';
  wallClockMs: number;
  frameIndex: number;
  sampleOffset?: number;
  durationUs: number;
  expectedTimestamp: number;
  actualTimestamp: number;
}

// ═══════════════════════════════════════════════════════════════════════════════
// TIMING ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

const timingBuf = readFileSync(timingPath);
const deltas = new Float32Array(timingBuf.buffer, timingBuf.byteOffset, timingBuf.byteLength / 4);
const frameCount = deltas.length;

if (frameCount === 0) {
  console.error('Error: timing file is empty (0 frames)');
  process.exit(1);
}

const sorted = Float32Array.from(deltas).sort();
const med = fMedian(sorted);
const m = mean(deltas);
const sd = stddev(deltas, m);
const p95 = percentile(sorted, 95);
const p99 = percentile(sorted, 99);
const maxVal = sorted[sorted.length - 1]!;
const cv = sd / m;

// Classification
const histMin = sorted[0]!;
const histMax = p99;
const histBins = 100;
const binWidth = (histMax - histMin) / histBins;
const histogram = new Float64Array(histBins);
if (binWidth > 0) {
  for (let i = 0; i < frameCount; i++) {
    const v = deltas[i]!;
    if (v >= histMin && v <= histMax) {
      const bin = Math.min(histBins - 1, Math.floor((v - histMin) / binWidth));
      histogram[bin]++;
    }
  }
} else {
  histogram[0] = frameCount;
}
const smoothed = new Float64Array(histBins);
for (let i = 0; i < histBins; i++) {
  let sum = 0,
    count = 0;
  for (let k = -2; k <= 2; k++) {
    const idx = i + k;
    if (idx >= 0 && idx < histBins) {
      sum += histogram[idx]!;
      count++;
    }
  }
  smoothed[i] = sum / count;
}

const minPeakHeight = frameCount * 0.01;
interface Peak {
  bin: number;
  value: number;
  center: number;
}
const peaks: Peak[] = [];
for (let i = 1; i < histBins - 1; i++) {
  if (
    smoothed[i]! > smoothed[i - 1]! &&
    smoothed[i]! > smoothed[i + 1]! &&
    smoothed[i]! >= minPeakHeight
  ) {
    peaks.push({ bin: i, value: smoothed[i]!, center: histMin + (i + 0.5) * binWidth });
  }
}
const qualifyingPeaks: Peak[] = [];
for (let i = 0; i < peaks.length; i++) {
  const p = peaks[i]!;
  let qualifies = false;
  for (let j = 0; j < peaks.length; j++) {
    if (i === j) continue;
    const other = peaks[j]!;
    if (Math.abs(p.center - other.center) < 3) continue;
    const lo = Math.min(p.bin, other.bin);
    const hi = Math.max(p.bin, other.bin);
    let valley = Infinity;
    for (let k = lo + 1; k < hi; k++) valley = Math.min(valley, smoothed[k]!);
    if (p.value <= 2 * valley) continue;
    if (valley >= 0.5 * Math.min(p.value, other.value)) continue;
    qualifies = true;
    break;
  }
  if (qualifies) qualifyingPeaks.push(p);
}

// Deduplicate qualifying peaks within 3ms of each other (keep taller)
qualifyingPeaks.sort((a, b) => b.value - a.value);
for (let i = 0; i < qualifyingPeaks.length; i++) {
  for (let j = qualifyingPeaks.length - 1; j > i; j--) {
    if (Math.abs(qualifyingPeaks[i]!.center - qualifyingPeaks[j]!.center) < 3) {
      qualifyingPeaks.splice(j, 1);
    }
  }
}
qualifyingPeaks.sort((a, b) => a.center - b.center);

// Trend
const segCount = 10;
const segSize = Math.floor(frameCount / segCount);
const segMedians: number[] = [];
for (let s = 0; s < segCount; s++) {
  const seg = Float32Array.from(deltas.subarray(s * segSize, (s + 1) * segSize)).sort();
  segMedians.push(fMedian(seg));
}
let sumX = 0,
  sumY = 0,
  sumXY = 0,
  sumX2 = 0;
for (let i = 0; i < segCount; i++) {
  sumX += i;
  sumY += segMedians[i]!;
  sumXY += i * segMedians[i]!;
  sumX2 += i * i;
}
const slope = (segCount * sumXY - sumX * sumY) / (segCount * sumX2 - sumX * sumX);
const hasTrend = slope > 0.1 * med;
const isBimodal = qualifyingPeaks.length >= 2;

// Harmonic check: secondary mode within 10% of 2× primary = missed callbacks, not thermal
let isHarmonic = false;
if (isBimodal && qualifyingPeaks.length >= 2) {
  const byHeight = [...qualifyingPeaks].sort((a, b) => b.value - a.value);
  const primary = byHeight[0]!;
  for (let i = 1; i < byHeight.length; i++) {
    const ratio = byHeight[i]!.center / primary.center;
    if (Math.abs(ratio - 2) < 0.2) {
      isHarmonic = true;
      break;
    }
  }
}

let timingClassification: string;
let timingEvidence: string;

if (isBimodal && !isHarmonic) {
  timingClassification = 'thermal throttling';
  timingEvidence = `${qualifyingPeaks.length} modes at [${qualifyingPeaks.map((p) => p.center.toFixed(1) + 'ms').join(', ')}]`;
} else if (isBimodal && isHarmonic) {
  const byHeight = [...qualifyingPeaks].sort((a, b) => b.value - a.value);
  timingClassification = 'scheduling jitter with missed callbacks';
  timingEvidence = `primary=${byHeight[0]!.center.toFixed(1)}ms, secondary=${byHeight[1]!.center.toFixed(1)}ms (${(byHeight[1]!.center / byHeight[0]!.center).toFixed(2)}× doubling)`;
} else if (hasTrend) {
  timingClassification = 'memory pressure / GC';
  timingEvidence = `slope=${slope.toFixed(4)}`;
  if (isBimodal) timingClassification += ' with thermal throttling';
} else if (cv < 0.3 && p99 / med > 3) {
  timingClassification = 'scheduling jitter';
  timingEvidence = `CV=${cv.toFixed(2)}, p99/median=${(p99 / med).toFixed(1)}`;
} else if (cv > 0.5) {
  timingClassification = 'worker thread contention';
  timingEvidence = `CV=${cv.toFixed(2)}`;
} else {
  timingClassification = 'clean capture';
  timingEvidence = `CV=${cv.toFixed(2)}, p99/median=${(p99 / med).toFixed(1)}`;
}

console.log(`\n═══ Combined Capture Analysis ═══`);
console.log(`\n─── Timing Summary ───`);
console.log(`  Frames: ${frameCount}, median: ${med.toFixed(3)}ms, mean: ${m.toFixed(3)}ms`);
console.log(`  P95: ${p95.toFixed(3)}ms, P99: ${p99.toFixed(3)}ms, max: ${maxVal.toFixed(3)}ms`);
console.log(`  Classification: ${timingClassification} (${timingEvidence})`);

// ═══════════════════════════════════════════════════════════════════════════════
// EVENT ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

const events: DiagnosticEvent[] = JSON.parse(readFileSync(eventsPath, 'utf-8'));
const gaps = events.filter((e) => e.type === 'gap');
const overlaps = events.filter((e) => e.type === 'overlap');
const zeroBlockEvents = events.filter((e) => e.type === 'zero_block');
const maxWallClock = events.reduce((mx, e) => Math.max(mx, e.wallClockMs), 0);
const totalGapDurationMs = gaps.reduce((s, e) => s + e.durationUs / 1000, 0);
const captureDurationSec = maxWallClock / 1000;

console.log(`\n─── Events Summary ───`);
console.log(
  `  Gaps: ${gaps.length}, overlaps: ${overlaps.length}, zero blocks: ${zeroBlockEvents.length}`,
);
console.log(
  `  Total gap duration: ${totalGapDurationMs.toFixed(2)}ms (${((totalGapDurationMs / maxWallClock) * 100).toFixed(3)}% of ${captureDurationSec.toFixed(1)}s)`,
);

// Cross-reference: producer vs consumer vs stream-drop (reuse `sorted` from timing analysis)
const timingMedian = med;
let producerCount = 0,
  consumerCount = 0,
  streamDropCount = 0;

for (const gap of gaps) {
  const fi = gap.frameIndex;
  if (fi >= deltas.length) {
    streamDropCount++;
  } else if (deltas[fi]! > 3 * timingMedian) {
    consumerCount++;
  } else {
    producerCount++;
  }
}

let gapSource: string;
const gapTotal = producerCount + consumerCount + streamDropCount;
if (gapTotal === 0) {
  gapSource = 'none';
} else if (producerCount >= consumerCount && producerCount >= streamDropCount) {
  gapSource = `producer-side (${producerCount}/${gapTotal} gaps show normal read timing with timestamp jump)`;
} else if (consumerCount >= producerCount && consumerCount >= streamDropCount) {
  gapSource = `consumer-side (${consumerCount}/${gapTotal} gaps show elevated read timing)`;
} else {
  gapSource = `stream backpressure drop (${streamDropCount}/${gapTotal} gaps — worker never saw frame)`;
}

console.log(
  `  Gap source: ${producerCount} producer, ${consumerCount} consumer, ${streamDropCount} stream-drop`,
);

// ═══════════════════════════════════════════════════════════════════════════════
// WAV ANALYSIS
// ═══════════════════════════════════════════════════════════════════════════════

const wav = parseWav(readFileSync(wavPath));
const totalInterleaved = wav.samples.length;
const n = Math.floor(totalInterleaved / wav.channels);
const sr = wav.sampleRate;
const ch0 = new Float32Array(n);
for (let i = 0; i < n; i++) ch0[i] = wav.samples[i * wav.channels]!;

/** Per-channel sample position: use sampleOffset when available, fall back to wall-clock. */
function eventSamplePos(event: DiagnosticEvent): number {
  if (event.sampleOffset != null) return event.sampleOffset;
  return Math.round((event.wallClockMs / 1000) * sr);
}

function wavRms(data: Float32Array, start: number, len: number): number {
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

const hasSampleOffset = gaps.length > 0 && gaps[0]!.sampleOffset != null;

// Zero/repeat run scan (min 32 samples to catch sub-quantum silence)
const MIN_ZERO_RUN = 32;
interface Run {
  start: number;
  length: number;
  type: 'near-zero' | 'exact-repeat';
}
const allRuns: Run[] = [];

// Near-zero runs
{
  let runStart = -1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(ch0[i]!) < 1e-6) {
      if (runStart < 0) runStart = i;
    } else {
      if (runStart >= 0 && i - runStart >= MIN_ZERO_RUN) {
        allRuns.push({ start: runStart, length: i - runStart, type: 'near-zero' });
      }
      runStart = -1;
    }
  }
  if (runStart >= 0 && n - runStart >= MIN_ZERO_RUN) {
    allRuns.push({ start: runStart, length: n - runStart, type: 'near-zero' });
  }
}

// Exact-repeat runs
{
  let runStart = -1,
    runLen = 0;
  for (let i = 128; i < n; i++) {
    if (Math.abs(ch0[i]! - ch0[i - 128]!) < 1e-10) {
      if (runStart < 0) runStart = i;
      runLen++;
    } else {
      if (runStart >= 0 && runLen >= MIN_ZERO_RUN) {
        allRuns.push({ start: runStart, length: runLen, type: 'exact-repeat' });
      }
      runStart = -1;
      runLen = 0;
    }
  }
  if (runStart >= 0 && runLen >= MIN_ZERO_RUN) {
    allRuns.push({ start: runStart, length: runLen, type: 'exact-repeat' });
  }
}

// Per-gap raw measurements
interface GapMeasurement {
  zerosBefore: number;
  zerosAfter: number;
  repeatLen: number;
  preRMS: number;
  postRMS: number;
  dB: number;
  jump: number;
  jumpRatio: number;
  localMedianDelta: number;
  pos: number;
}
const gapMeasurements: GapMeasurement[] = [];

for (const gap of gaps) {
  const pos = eventSamplePos(gap);
  if (pos < 0 || pos >= n) continue;

  let zerosBefore = 0;
  for (let j = pos - 1; j >= 0 && Math.abs(ch0[j]!) < 1e-6; j--) zerosBefore++;
  let zerosAfter = 0;
  for (let j = pos; j < n && Math.abs(ch0[j]!) < 1e-6; j++) zerosAfter++;

  let repeatLen = 0;
  if (pos >= 128 && pos + 128 <= n) {
    for (let k = 0; k < 128; k++) {
      if (Math.abs(ch0[pos + k]! - ch0[pos - 128 + k]!) > 1e-10) break;
      repeatLen++;
    }
  }

  const preRMS = wavRms(ch0, pos - 128, 128);
  const postRMS = wavRms(ch0, pos, 128);
  const dB = preRMS > 0 && postRMS > 0 ? 20 * Math.log10(postRMS / preRMS) : 0;

  const jump = pos > 0 ? Math.abs(ch0[pos]! - ch0[pos - 1]!) : 0;
  const localDeltas: number[] = [];
  const ldStart = Math.max(1, pos - 128);
  for (let j = ldStart; j < pos; j++) localDeltas.push(Math.abs(ch0[j]! - ch0[j - 1]!));
  localDeltas.sort((a, b) => a - b);
  const localMedianDelta =
    localDeltas.length > 0 ? localDeltas[Math.floor(localDeltas.length / 2)]! : 0;
  const jumpRatio = localMedianDelta > 0 ? jump / localMedianDelta : 0;

  gapMeasurements.push({
    zerosBefore,
    zerosAfter,
    repeatLen,
    preRMS,
    postRMS,
    dB,
    jump,
    jumpRatio,
    localMedianDelta,
    pos,
  });
}

// Zero-block energy stats from WAV
interface ZeroBlockSample {
  energy: number;
  maxAbs: number;
}
const zbSamples: ZeroBlockSample[] = [];
for (const zb of zeroBlockEvents) {
  const pos = eventSamplePos(zb);
  if (pos < 0 || pos >= n) continue;
  const frameLen = Math.min(441, n - pos);
  let energy = 0,
    maxAbs = 0;
  for (let i = 0; i < frameLen; i++) {
    energy += ch0[pos + i]! * ch0[pos + i]!;
    const a = Math.abs(ch0[pos + i]!);
    if (a > maxAbs) maxAbs = a;
  }
  energy /= frameLen;
  zbSamples.push({ energy, maxAbs });
}

// Quantum alignment
const QUANTUM = 128;
let lenAligned = 0;
for (const run of allRuns) {
  if (run.length % QUANTUM === 0) lenAligned++;
}
const alignPct = allRuns.length > 0 ? (lenAligned / allRuns.length) * 100 : 0;
const quantumAligned = alignPct > 80;

const nZeroRuns = allRuns.filter((r) => r.type === 'near-zero').length;
const nRepeatRuns = allRuns.filter((r) => r.type === 'exact-repeat').length;

// Aggregate raw measurement stats
const gapsWithZeros = gapMeasurements.filter((g) => g.zerosBefore + g.zerosAfter >= 8).length;
const gapsWithRepeat = gapMeasurements.filter((g) => g.repeatLen >= 64).length;
const gapsWithHighJumpRatio = gapMeasurements.filter((g) => g.jumpRatio > 5).length;
const gapsWithHighDB = gapMeasurements.filter((g) => Math.abs(g.dB) > 6).length;
const jumpRatios = gapMeasurements.map((g) => g.jumpRatio).sort((a, b) => a - b);
const jumpRatioMedian = jumpRatios.length > 0 ? jumpRatios[Math.floor(jumpRatios.length / 2)]! : 0;

// Zero-block event WAV energy stats
const zbActualSilence = zbSamples.filter((z) => z.maxAbs < 1e-4).length;
const zbQuietAudio = zbSamples.filter((z) => z.maxAbs >= 1e-4).length;

console.log(`\n─── WAV Summary ───`);
console.log(`  Duration: ${(n / sr).toFixed(2)}s, ${sr}Hz, ${wav.channels}ch`);
console.log(`  Mapping: ${hasSampleOffset ? 'sampleOffset (exact)' : 'wallClockMs (estimated)'}`);
console.log(`  Zero runs: ${nZeroRuns}, repeat runs: ${nRepeatRuns}`);
console.log(`  Quantum alignment: ${alignPct.toFixed(1)}% of runs are 128-frame multiples`);
console.log(`  Per-gap measurements (${gapMeasurements.length} analyzed):`);
console.log(`    With zeros (≥8):      ${gapsWithZeros}`);
console.log(`    With repeat (≥64):    ${gapsWithRepeat}`);
console.log(`    High jump ratio (>5): ${gapsWithHighJumpRatio}`);
console.log(`    High dB (>6):         ${gapsWithHighDB}`);
console.log(`    Jump ratio median:    ${jumpRatioMedian.toFixed(1)}`);
if (zbSamples.length > 0) {
  console.log(`  Zero-block events at WAV positions (${zbSamples.length} sampled):`);
  console.log(`    Actual silence (maxAbs < 1e-4): ${zbActualSilence}`);
  console.log(`    Quiet audio (maxAbs ≥ 1e-4):   ${zbQuietAudio}`);
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIAGNOSIS
// ═══════════════════════════════════════════════════════════════════════════════

// Cross-reference: how many gap events have a nearby zero/repeat run?
let gapsWithRun = 0;
let gapsWithoutRun = 0;
let runsWithoutGap = 0;
for (const gap of gaps) {
  const gapPos = eventSamplePos(gap);
  const hasRun = allRuns.some(
    (r) => Math.abs(r.start - gapPos) <= 256 || (gapPos >= r.start && gapPos <= r.start + r.length),
  );
  if (hasRun) gapsWithRun++;
  else gapsWithoutRun++;
}
for (const run of allRuns) {
  const hasGap = gaps.some((gap) => {
    const gapPos = eventSamplePos(gap);
    return (
      Math.abs(run.start - gapPos) <= 256 ||
      (gapPos >= run.start && gapPos <= run.start + run.length)
    );
  });
  if (!hasGap) runsWithoutGap++;
}

const gapSourceMajority =
  producerCount >= consumerCount && producerCount >= streamDropCount
    ? 'producer'
    : consumerCount >= streamDropCount
      ? 'consumer'
      : 'stream-drop';

console.log(`\n=== DIAGNOSIS ===`);
console.log(`Timing pattern:    ${timingClassification} (${timingEvidence})`);
console.log(`Gap source:        ${gapSource}`);
console.log(
  `Gap-to-WAV match:  ${gapsWithRun}/${gaps.length} gaps have adjacent zero/repeat run, ${runsWithoutGap} runs have no gap event`,
);
console.log(
  `WAV artifacts:     zeros=${gapsWithZeros} repeat=${gapsWithRepeat} highJump=${gapsWithHighJumpRatio} highDB=${gapsWithHighDB} (of ${gapMeasurements.length} gaps)`,
);
console.log(
  `                   jump ratio median=${jumpRatioMedian.toFixed(1)}, quantum aligned=${alignPct.toFixed(0)}%`,
);
if (zbSamples.length > 0) {
  console.log(
    `Zero-block truth:  ${zbActualSilence} actual silence, ${zbQuietAudio} quiet audio (of ${zbSamples.length} events)`,
  );
}

// Recommendation rules — synthesize all three signals
const recommendations: string[] = [];

// Timing-based rules
if (timingClassification === 'scheduling jitter with missed callbacks') {
  recommendations.push(
    '--audio-buffer-size=4096 + High Performance power plan should address missed-callback pattern.',
  );
} else if (timingClassification === 'thermal throttling') {
  recommendations.push(
    'Software mitigations have a ceiling. Hardware cooling, workload reduction, or accepting degraded quality on this device class is needed.',
  );
} else if (
  timingClassification === 'memory pressure / GC' ||
  timingClassification === 'memory pressure / GC with thermal throttling'
) {
  recommendations.push(
    'Memory pressure building over time. Check for unbounded buffer growth or leaking ArrayBuffers. Consider streaming to disk instead of accumulating in-memory.',
  );
} else if (timingClassification === 'scheduling jitter' && captureDurationSec > 0) {
  const gapsPerMin = gaps.length / (captureDurationSec / 60);
  if (gapsPerMin < 5) {
    recommendations.push(
      'Scheduling jitter is present but gaps are infrequent. Simple concealment (crossfade/interpolation) should handle this adequately.',
    );
  }
} else if (timingClassification === 'clean capture' && gaps.length === 0) {
  recommendations.push('Clean capture — no issues detected.');
}

// Gap source rules
if (gapSourceMajority === 'producer' && gapsWithZeros > 0 && quantumAligned) {
  recommendations.push('Concealment: crossfade over zero-filled 128-sample blocks.');
} else if (gapSourceMajority === 'consumer') {
  recommendations.push(
    'Increase maxBufferSize (MSTP backpressure tolerance). Profile worker processing time — look for GC pauses or slow Float32 copies.',
  );
} else if (gapSourceMajority === 'stream-drop') {
  recommendations.push(
    'Worker cannot keep up with producer. Reduce processing per frame or increase MSTP maxBufferSize to absorb bursts.',
  );
}

// Stale repeat detection
if (gapsWithRepeat > gapMeasurements.length * 0.3 && gapsWithRepeat > 0) {
  recommendations.push(
    'Chrome is reading stale WASAPI shared memory — not fixable from extension-land. Requires native host or WASAPI exclusive-mode capture.',
  );
}

// Flag inconsistencies between signals
if (gapsWithoutRun > gaps.length * 0.5 && allRuns.length > 0) {
  recommendations.push(
    `NOTE: ${gapsWithoutRun}/${gaps.length} gap events have no adjacent zero/repeat run in WAV — gap positions and audio artifacts may be at different locations.`,
  );
}
if (runsWithoutGap > 0) {
  recommendations.push(
    `NOTE: ${runsWithoutGap} zero/repeat runs in WAV have no corresponding gap event — hidden underruns with continuous timestamps.`,
  );
}
if (zbQuietAudio > zbSamples.length * 0.5 && zbSamples.length > 5) {
  recommendations.push(
    `NOTE: ${zbQuietAudio}/${zbSamples.length} zero-block events contain audible audio at WAV positions — worker energy threshold (1e-10) is more sensitive than actual silence.`,
  );
}
if (
  gapMeasurements.length > 5 &&
  jumpRatioMedian < 2 &&
  gapsWithZeros === 0 &&
  gapsWithRepeat === 0
) {
  recommendations.push(
    `NOTE: No artifacts visible at gap positions (median jumpRatio=${jumpRatioMedian.toFixed(1)}, no zeros/repeats). Gap positions may not correspond to audible artifacts.`,
  );
}

console.log(
  `Recommendation:    ${recommendations.length > 0 ? recommendations.join('\n                   ') : 'No clear pattern — review individual script outputs for details.'}`,
);

// ─── Summary CSV ─────────────────────────────────────────────────────────────

if (summaryCsvPath) {
  const tsMatch = wavPath.match(/capture-(\d+)/);
  const timestamp = tsMatch ? tsMatch[1] : 'unknown';
  let outlierCount = 0;
  for (let i = 0; i < frameCount; i++) if (deltas[i]! > 2 * med) outlierCount++;
  const outlierPct = ((outlierCount / frameCount) * 100).toFixed(2);

  const row = [
    timestamp,
    frameCount,
    med.toFixed(3),
    m.toFixed(3),
    p95.toFixed(3),
    p99.toFixed(3),
    maxVal.toFixed(3),
    outlierPct,
    timingClassification,
    gaps.length,
    totalGapDurationMs.toFixed(2),
    gapSourceMajority,
    `${producerCount}/${consumerCount}/${streamDropCount}`,
    gapsWithZeros,
    gapsWithRepeat,
    gapsWithHighJumpRatio,
    jumpRatioMedian.toFixed(1),
    alignPct.toFixed(1),
    zbActualSilence,
    zbQuietAudio,
  ].join(',');

  const header =
    'timestamp,frames,median_ms,mean_ms,p95_ms,p99_ms,max_ms,outlier_pct,timing_class,gap_count,gap_dur_ms,gap_source,producer/consumer/stream-drop,gaps_w_zeros,gaps_w_repeat,gaps_w_high_jump,jump_ratio_median,align_pct,zb_actual_silence,zb_quiet_audio';

  if (!existsSync(summaryCsvPath)) {
    writeFileSync(summaryCsvPath, header + '\n' + row + '\n');
  } else {
    const existing = readFileSync(summaryCsvPath, 'utf-8');
    writeFileSync(summaryCsvPath, existing + row + '\n');
  }
  console.log(`\nSummary row appended to ${summaryCsvPath}`);
}
