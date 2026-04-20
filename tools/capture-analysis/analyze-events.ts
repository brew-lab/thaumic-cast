/**
 * Event Analysis — classifies gap patterns from diagnostic events
 *
 * Input: events.json (DiagnosticEvent[]), optional timing.bin
 * Output: Summary, clustering, periodicity, cross-reference classification
 */
import { readFileSync } from 'fs';

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
const eventsPath = nonFlags[0];
const timingPath = nonFlags[1];

if (!eventsPath) {
  console.error('Usage: bun run tools/analyze-events.ts <events.json> [timing.bin]');
  process.exit(1);
}

// ─── Stats helpers ───────────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo);
}

function median(sorted: number[]): number {
  return percentile(sorted, 50);
}

function mean(arr: number[]): number {
  let sum = 0;
  for (const v of arr) sum += v;
  return sum / arr.length;
}

function stddev(arr: number[], m: number): number {
  let sum = 0;
  for (const v of arr) {
    const d = v - m;
    sum += d * d;
  }
  return Math.sqrt(sum / arr.length);
}

// ─── Load data ───────────────────────────────────────────────────────────────

const events: DiagnosticEvent[] = JSON.parse(readFileSync(eventsPath, 'utf-8'));
const RENDER_QUANTUM_US = 2666.67; // 128 samples at 48kHz

let timing: Float32Array | null = null;
if (timingPath) {
  const buf = readFileSync(timingPath);
  timing = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

console.log(`\n═══ Event Analysis: ${eventsPath} ═══`);

// ─── Section 1: Summary ─────────────────────────────────────────────────────

const gaps = events.filter((e) => e.type === 'gap');
const overlaps = events.filter((e) => e.type === 'overlap');
const zeroBlocks = events.filter((e) => e.type === 'zero_block');

const maxWallClock = events.reduce((mx, e) => Math.max(mx, e.wallClockMs), 0);
const totalGapDurationMs = gaps.reduce((s, e) => s + e.durationUs / 1000, 0);

console.log(`\n─── Summary ───`);
console.log(`  Total events:    ${events.length}`);
console.log(`  Gaps:            ${gaps.length}`);
console.log(`  Overlaps:        ${overlaps.length}`);
console.log(`  Zero blocks:     ${zeroBlocks.length}`);
console.log(`  Total gap dur:   ${totalGapDurationMs.toFixed(2)} ms`);
console.log(`  Capture dur:     ${(maxWallClock / 1000).toFixed(2)} s`);
if (maxWallClock > 0) {
  console.log(`  Gap % of total:  ${((totalGapDurationMs / maxWallClock) * 100).toFixed(3)}%`);
}

// ─── Section 2: Gap duration distribution ────────────────────────────────────

if (gaps.length > 0) {
  const durationsUs = gaps.map((e) => e.durationUs).sort((a, b) => a - b);
  console.log(`\n─── Gap Duration Distribution ───`);
  console.log(`  Min:    ${durationsUs[0]!.toFixed(0)} µs`);
  console.log(`  Median: ${median(durationsUs).toFixed(0)} µs`);
  console.log(`  P95:    ${percentile(durationsUs, 95).toFixed(0)} µs`);
  console.log(`  Max:    ${durationsUs[durationsUs.length - 1]!.toFixed(0)} µs`);
  console.log(`  Render quantum: ${RENDER_QUANTUM_US.toFixed(0)} µs (128 @ 48kHz)`);

  // Classify by quantum multiples
  let q1 = 0,
    q2 = 0,
    q3plus = 0;
  for (const dur of durationsUs) {
    const quanta = dur / RENDER_QUANTUM_US;
    if (quanta < 1.5) q1++;
    else if (quanta < 2.5) q2++;
    else q3plus++;
  }
  console.log(`\n  Quantum multiples:`);
  console.log(`    1Q (< 1.5× quantum): ${q1}`);
  console.log(`    2Q (1.5-2.5×):       ${q2}`);
  console.log(`    3Q+ (> 2.5×):        ${q3plus}`);
}

// ─── Section 3: Clustering ──────────────────────────────────────────────────

if (gaps.length > 1) {
  const interGapMs: number[] = [];
  for (let i = 1; i < gaps.length; i++) {
    interGapMs.push(gaps[i]!.wallClockMs - gaps[i - 1]!.wallClockMs);
  }

  // Burst detection: 2+ gaps within 200ms
  interface Burst {
    startMs: number;
    count: number;
  }
  const bursts: Burst[] = [];
  let inBurst = false;
  let burstStart = 0;
  for (let i = 1; i < gaps.length; i++) {
    if (gaps[i]!.wallClockMs - gaps[i - 1]!.wallClockMs <= 200) {
      if (!inBurst) {
        inBurst = true;
        burstStart = i - 1;
      }
    } else {
      if (inBurst) {
        bursts.push({ startMs: gaps[burstStart]!.wallClockMs, count: i - burstStart });
        inBurst = false;
      }
    }
  }
  if (inBurst) {
    bursts.push({ startMs: gaps[burstStart]!.wallClockMs, count: gaps.length - burstStart });
  }

  const interSorted = [...interGapMs].sort((a, b) => a - b);

  console.log(`\n─── Clustering ───`);
  console.log(
    `  Inter-gap intervals: min=${interSorted[0]!.toFixed(1)}ms, median=${median(interSorted).toFixed(1)}ms, max=${interSorted[interSorted.length - 1]!.toFixed(1)}ms`,
  );
  console.log(`  Bursts (2+ within 200ms): ${bursts.length}`);
  if (bursts.length > 0) {
    const maxBurst = Math.max(...bursts.map((b) => b.count));
    console.log(`  Max burst size: ${maxBurst}`);
    console.log(`  First ${Math.min(10, bursts.length)} bursts:`);
    for (const b of bursts.slice(0, 10)) {
      console.log(`    Time: ${(b.startMs / 1000).toFixed(3)}s, count: ${b.count}`);
    }
  }

  // ─── Section 4: Periodicity ──────────────────────────────────────────────

  if (gaps.length > 10) {
    const igMean = mean(interGapMs);
    const igSD = stddev(interGapMs, igMean);
    const igCV = igSD / igMean;
    console.log(`\n─── Periodicity ───`);
    console.log(`  Inter-gap CV: ${igCV.toFixed(3)}`);
    if (igCV < 0.3) {
      console.log(`  → Periodic gaps detected, period ≈ ${igMean.toFixed(1)} ms`);
    } else {
      console.log(`  → Non-periodic (irregular spacing)`);
    }
  }
}

// ─── Section 5: Time distribution ────────────────────────────────────────────

if (events.length > 0 && maxWallClock > 0) {
  const segCount = 10;
  const segMs = maxWallClock / segCount;

  console.log(`\n─── Time Distribution ───`);
  console.log(
    `  ${'Segment'.padEnd(8)} | ${'Time(s)'.padStart(9)} | ${'Gaps'.padStart(5)} | ${'Overlaps'.padStart(9)} | ${'ZeroBlks'.padStart(9)}`,
  );
  console.log(`  ${'-'.repeat(50)}`);

  // Single-pass binning
  const segGaps = new Array<number>(segCount).fill(0);
  const segOverlaps = new Array<number>(segCount).fill(0);
  const segZeros = new Array<number>(segCount).fill(0);
  for (const e of events) {
    const seg = Math.min(segCount - 1, Math.floor(e.wallClockMs / segMs));
    if (e.type === 'gap') segGaps[seg]++;
    else if (e.type === 'overlap') segOverlaps[seg]++;
    else segZeros[seg]++;
  }
  for (let s = 0; s < segCount; s++) {
    const lo = s * segMs;
    console.log(
      `  ${String(s + 1).padEnd(8)} | ${(lo / 1000).toFixed(2).padStart(9)} | ${String(segGaps[s]!).padStart(5)} | ${String(segOverlaps[s]!).padStart(9)} | ${String(segZeros[s]!).padStart(9)}`,
    );
  }

  // Classify distribution
  const totalGaps = gaps.length;
  if (totalGaps > 0) {
    const first3 = segGaps.slice(0, 3).reduce((a, b) => a + b, 0);
    const last3 = segGaps.slice(-3).reduce((a, b) => a + b, 0);
    if (first3 / totalGaps > 0.6)
      console.log(
        `  → Front-loaded (first 3 segments: ${((first3 / totalGaps) * 100).toFixed(0)}%)`,
      );
    else if (last3 / totalGaps > 0.6)
      console.log(`  → Back-loaded (last 3 segments: ${((last3 / totalGaps) * 100).toFixed(0)}%)`);
    else console.log(`  → Uniform distribution`);
  }
}

// ─── Section 6: Event table ──────────────────────────────────────────────────

console.log(`\n─── Event Table (first ${Math.min(40, events.length)}) ───`);
console.log(
  `  ${'#'.padStart(4)} | ${'Time(s)'.padStart(9)} | ${'Frame'.padStart(7)} | ${'Type'.padEnd(11)} | ${'Dur(µs)'.padStart(10)} | ${'Expected TS'.padStart(14)} | ${'Actual TS'.padStart(14)}`,
);
console.log(`  ${'-'.repeat(82)}`);
for (let i = 0; i < Math.min(40, events.length); i++) {
  const e = events[i]!;
  console.log(
    `  ${String(i + 1).padStart(4)} | ` +
      `${(e.wallClockMs / 1000).toFixed(3).padStart(9)} | ` +
      `${String(e.frameIndex).padStart(7)} | ` +
      `${e.type.padEnd(11)} | ` +
      `${e.durationUs.toFixed(0).padStart(10)} | ` +
      `${e.expectedTimestamp.toFixed(0).padStart(14)} | ` +
      `${e.actualTimestamp.toFixed(0).padStart(14)}`,
  );
}

// ─── Section 7: Timing cross-reference ───────────────────────────────────────

if (timing && gaps.length > 0) {
  console.log(`\n─── Timing Cross-Reference ───`);

  // Frame count check
  const maxFrameInEvents = Math.max(...events.map((e) => e.frameIndex)) + 1;
  console.log(`  Timing frames:   ${timing.length}`);
  console.log(`  Max event frame: ${maxFrameInEvents}`);
  if (timing.length < maxFrameInEvents) {
    console.log(
      `  ⚠ ${maxFrameInEvents - timing.length} frames missing from timing — likely ReadableStream backpressure drops`,
    );
  }

  // Compute timing median for threshold
  const timingSorted = Float32Array.from(timing).sort();
  const timingMedian = timingSorted[Math.floor(timingSorted.length / 2)]!;

  // Classify ALL gaps for accurate counts
  let producerCount = 0,
    consumerCount = 0,
    streamDropCount = 0;
  for (const gap of gaps) {
    const fi = gap.frameIndex;
    if (fi >= timing.length) streamDropCount++;
    else if (timing[fi]! > 3 * timingMedian) consumerCount++;
    else producerCount++;
  }

  // Display table for first 20
  console.log(
    `\n  ${'Gap#'.padStart(5)} | ${'Time(s)'.padStart(9)} | ${'Deltas[-2..+2]'.padEnd(45)} | ${'Classification'.padEnd(25)}`,
  );
  console.log(`  ${'-'.repeat(90)}`);

  const displayCount = Math.min(20, gaps.length);
  for (let g = 0; g < displayCount; g++) {
    const gap = gaps[g]!;
    const fi = gap.frameIndex;

    let cls: string;
    const deltaStrs: string[] = [];

    if (fi >= timing.length) {
      cls = 'stream backpressure drop';
      for (let d = -2; d <= 2; d++) deltaStrs.push('N/A');
    } else {
      for (let d = -2; d <= 2; d++) {
        const idx = fi + d;
        if (idx >= 0 && idx < timing.length) {
          deltaStrs.push(timing[idx]!.toFixed(2));
        } else {
          deltaStrs.push('---');
        }
      }

      const delta = timing[fi]!;
      if (delta > 3 * timingMedian) {
        cls = 'consumer-side (read stall)';
      } else {
        cls = 'producer-side (Chrome underrun)';
      }
    }

    console.log(
      `  ${String(g + 1).padStart(5)} | ` +
        `${(gap.wallClockMs / 1000).toFixed(3).padStart(9)} | ` +
        `${deltaStrs
          .map((s) => s.padStart(8))
          .join(' ')
          .padEnd(45)} | ` +
        `${cls}`,
    );
  }

  console.log(
    `\n  Summary: ${producerCount} producer, ${consumerCount} consumer, ${streamDropCount} stream-drop`,
  );
}

// ─── Section 8: Zero-blocks without gaps ─────────────────────────────────────

if (zeroBlocks.length > 0 && gaps.length > 0) {
  const gapFrames = new Set(gaps.map((e) => e.frameIndex));
  const zbWithoutGap = zeroBlocks.filter((e) => !gapFrames.has(e.frameIndex));
  const zbWithGap = zeroBlocks.filter((e) => gapFrames.has(e.frameIndex));

  console.log(`\n─── Zero-Blocks Without Gaps ───`);
  console.log(`  Zero blocks with corresponding gap: ${zbWithGap.length}`);
  console.log(`  Zero blocks WITHOUT gap event:      ${zbWithoutGap.length}`);
  if (zbWithoutGap.length > 0) {
    console.log(`  → These represent underruns where Chrome kept timestamps continuous`);
    console.log(`    (energy dropped to zero but no timestamp discontinuity was detected)`);
    console.log(`\n  First ${Math.min(20, zbWithoutGap.length)} orphan zero-blocks:`);
    console.log(
      `  ${'#'.padStart(4)} | ${'Time(s)'.padStart(9)} | ${'Frame'.padStart(7)} | ${'Duration(µs)'.padStart(13)}`,
    );
    console.log(`  ${'-'.repeat(40)}`);
    for (let i = 0; i < Math.min(20, zbWithoutGap.length); i++) {
      const e = zbWithoutGap[i]!;
      console.log(
        `  ${String(i + 1).padStart(4)} | ` +
          `${(e.wallClockMs / 1000).toFixed(3).padStart(9)} | ` +
          `${String(e.frameIndex).padStart(7)} | ` +
          `${e.durationUs.toFixed(0).padStart(13)}`,
      );
    }
  }
} else if (zeroBlocks.length > 0 && gaps.length === 0) {
  console.log(`\n─── Zero-Blocks Without Gaps ───`);
  console.log(`  All ${zeroBlocks.length} zero blocks occurred without any gap events`);
  console.log(`  → Chrome is producing silent frames with continuous timestamps`);
}
