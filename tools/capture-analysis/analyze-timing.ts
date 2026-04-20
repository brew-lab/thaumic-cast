/**
 * Timing Analysis — classifies inter-frame read() delta patterns
 *
 * Input: Raw Float32Array of inter-frame deltas in milliseconds
 * Output: Statistics, distribution classification, periodicity, histogram
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';

const args = process.argv.slice(2);
const filePath = args.find((a) => !a.startsWith('--'));
if (!filePath) {
  console.error(
    'Usage: bun run tools/analyze-timing.ts <timing.bin> [--csv] [--summary-csv=results.csv]',
  );
  process.exit(1);
}

function getOpt(name: string, def: string): string {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg ? arg.split('=')[1]! : def;
}
const csvMode = args.includes('--csv');
const summaryCsvPath = args.find((a) => a.startsWith('--summary-csv='))?.split('=')[1];

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

function median(sorted: Float32Array): number {
  return percentile(sorted, 50);
}

// ─── Load data ───────────────────────────────────────────────────────────────

const buf = readFileSync(filePath);
const deltas = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const frameCount = deltas.length;

if (frameCount === 0) {
  console.error('Error: timing file is empty (0 frames)');
  process.exit(1);
}

const sorted = Float32Array.from(deltas).sort();

if (csvMode) {
  for (let i = 0; i < frameCount; i++) console.log(deltas[i]!.toFixed(4));
  process.exit(0);
}

// ─── Section 1: File info ────────────────────────────────────────────────────

const med = median(sorted);
console.log(`\n═══ Timing Analysis: ${filePath} ═══`);
console.log(`  Frames: ${frameCount}`);
console.log(`  Nominal interval: ${med.toFixed(3)} ms (median)`);

// ─── Section 2: Statistics ───────────────────────────────────────────────────

const m = mean(deltas);
const sd = stddev(deltas, m);
const p95 = percentile(sorted, 95);
const p99 = percentile(sorted, 99);
const minVal = sorted[0]!;
const maxVal = sorted[sorted.length - 1]!;

console.log(`\n─── Statistics ───`);
console.log(`  Count:   ${frameCount}`);
console.log(`  Min:     ${minVal.toFixed(3)} ms`);
console.log(`  Median:  ${med.toFixed(3)} ms`);
console.log(`  Mean:    ${m.toFixed(3)} ms`);
console.log(`  Stddev:  ${sd.toFixed(3)} ms`);
console.log(`  P95:     ${p95.toFixed(3)} ms`);
console.log(`  P99:     ${p99.toFixed(3)} ms`);
console.log(`  Max:     ${maxVal.toFixed(3)} ms`);

// ─── Section 3: Outliers ─────────────────────────────────────────────────────

const thresholds = [2, 3, 5, 10];
console.log(`\n─── Outliers ───`);
for (const t of thresholds) {
  const threshold = med * t;
  let count = 0;
  for (let i = 0; i < frameCount; i++) if (deltas[i]! > threshold) count++;
  console.log(
    `  > ${t}x median (${threshold.toFixed(1)} ms):  ${String(count).padStart(6)} (${((count / frameCount) * 100).toFixed(2)}%)`,
  );
}

// ─── Section 4: Distribution classification ──────────────────────────────────

const cv = sd / m;

// Bimodal detection: 100-bin histogram clipped to [min, p99]
const histMin = minVal;
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
  // All values identical — single bin
  histogram[0] = frameCount;
}

// Smooth with 5-tap moving average (wider kernel to suppress bin noise)
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

// Find local maxima (must contain ≥1% of total frames to suppress tail noise)
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

// Filter by prominence and separation
const qualifyingPeaks: Peak[] = [];
for (let i = 0; i < peaks.length; i++) {
  const p = peaks[i]!;
  let qualifies = false;
  for (let j = 0; j < peaks.length; j++) {
    if (i === j) continue;
    const other = peaks[j]!;
    // Separation check: >= 3ms apart (avoids adjacent-bin noise)
    if (Math.abs(p.center - other.center) < 3) continue;
    // Find valley between them
    const lo = Math.min(p.bin, other.bin);
    const hi = Math.max(p.bin, other.bin);
    let valley = Infinity;
    for (let k = lo + 1; k < hi; k++) valley = Math.min(valley, smoothed[k]!);
    // Prominence: peak > 2x valley (stricter to avoid tail noise)
    if (p.value <= 2 * valley) continue;
    // Valley-to-peak ratio: valley < 0.5 of lower peak
    const lowerPeak = Math.min(p.value, other.value);
    if (valley >= 0.5 * lowerPeak) continue;
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

// Trend detection: 10 segments, least-squares linear fit
const segCount = 10;
const segSize = Math.floor(frameCount / segCount);
const segMedians: number[] = [];
for (let s = 0; s < segCount; s++) {
  const seg = Float32Array.from(deltas.subarray(s * segSize, (s + 1) * segSize)).sort();
  segMedians.push(median(seg));
}

// Least-squares fit on segment medians
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

// Harmonic check: if secondary mode is within 10% of 2× primary, it's a
// missed-callback doubling pattern, not distinct thermal operating states.
let isHarmonic = false;
if (isBimodal && qualifyingPeaks.length >= 2) {
  // Primary = tallest peak, check if any other is ~2× its center
  const byHeight = [...qualifyingPeaks].sort((a, b) => b.value - a.value);
  const primary = byHeight[0]!;
  for (let i = 1; i < byHeight.length; i++) {
    const ratio = byHeight[i]!.center / primary.center;
    if (Math.abs(ratio - 2) < 0.2) {
      // within 10% of 2×
      isHarmonic = true;
      break;
    }
  }
}

let classification: string;
let evidence: string;

if (isBimodal && !isHarmonic) {
  classification = 'thermal throttling';
  evidence = `${qualifyingPeaks.length} modes at [${qualifyingPeaks.map((p) => p.center.toFixed(1) + 'ms').join(', ')}]`;
} else if (isBimodal && isHarmonic) {
  classification = 'scheduling jitter with missed callbacks';
  const byHeight = [...qualifyingPeaks].sort((a, b) => b.value - a.value);
  evidence = `primary=${byHeight[0]!.center.toFixed(1)}ms, secondary=${byHeight[1]!.center.toFixed(1)}ms (${(byHeight[1]!.center / byHeight[0]!.center).toFixed(2)}× = missed callback doubling)`;
} else if (hasTrend) {
  classification = 'memory pressure / GC';
  evidence = `slope=${slope.toFixed(4)} (${((slope / med) * 100).toFixed(1)}% of median per segment)`;
  if (isBimodal) {
    classification += ' with thermal throttling';
    evidence += `, ${qualifyingPeaks.length} thermal modes`;
  }
} else if (cv < 0.3 && p99 / med > 3) {
  classification = 'scheduling jitter';
  evidence = `CV=${cv.toFixed(2)}, p99/median=${(p99 / med).toFixed(1)}`;
} else if (cv > 0.5) {
  classification = 'worker thread contention';
  evidence = `CV=${cv.toFixed(2)}`;
} else {
  classification = 'clean capture';
  evidence = `CV=${cv.toFixed(2)}, p99/median=${(p99 / med).toFixed(1)}`;
}

console.log(`\n─── Classification ───`);
console.log(`  Pattern:  ${classification}`);
console.log(`  Evidence: ${evidence}`);

// ─── Section 5: Segment trend ────────────────────────────────────────────────

console.log(`\n─── Segment Trend ───`);
console.log(
  `  ${'Segment'.padEnd(8)} | ${'Frames'.padStart(7)} | ${'Median'.padStart(8)} | ${'Mean'.padStart(8)} | ${'P95'.padStart(8)} | ${'Outliers>2x'.padStart(12)}`,
);
console.log(`  ${'-'.repeat(63)}`);
for (let s = 0; s < segCount; s++) {
  const start = s * segSize;
  const end = Math.min((s + 1) * segSize, frameCount);
  const seg = deltas.subarray(start, end);
  const segSorted = Float32Array.from(seg).sort();
  const segMed = median(segSorted);
  const segMean = mean(seg);
  const segP95 = percentile(segSorted, 95);
  let outliers = 0;
  for (let i = 0; i < seg.length; i++) if (seg[i]! > 2 * med) outliers++;
  console.log(
    `  ${String(s + 1).padEnd(8)} | ${String(seg.length).padStart(7)} | ${segMed.toFixed(3).padStart(8)} | ${segMean.toFixed(3).padStart(8)} | ${segP95.toFixed(3).padStart(8)} | ${String(outliers).padStart(12)}`,
  );
}

// ─── Section 6: Periodicity (FFT) ───────────────────────────────────────────

function fftInPlace(real: Float64Array, imag: Float64Array, N: number): void {
  let j = 0;
  for (let i = 0; i < N - 1; i++) {
    if (i < j) {
      [real[i], real[j]] = [real[j]!, real[i]!];
      [imag[i], imag[j]] = [imag[j]!, imag[i]!];
    }
    let m = N >> 1;
    while (m >= 1 && j >= m) {
      j -= m;
      m >>= 1;
    }
    j += m;
  }
  for (let step = 2; step <= N; step <<= 1) {
    const halfStep = step >> 1;
    const angle = (-2 * Math.PI) / step;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let group = 0; group < N; group += step) {
      let twReal = 1,
        twImag = 0;
      for (let pair = 0; pair < halfStep; pair++) {
        const even = group + pair;
        const odd = even + halfStep;
        const tReal = twReal * real[odd]! - twImag * imag[odd]!;
        const tImag = twReal * imag[odd]! + twImag * real[odd]!;
        real[odd] = real[even]! - tReal;
        imag[odd] = imag[even]! - tImag;
        real[even] = real[even]! + tReal;
        imag[even] = imag[even]! + tImag;
        const newTw = twReal * wReal - twImag * wImag;
        twImag = twReal * wImag + twImag * wReal;
        twReal = newTw;
      }
    }
  }
}

// Zero-pad to power of 2
let fftN = 1;
while (fftN < frameCount) fftN <<= 1;
const real = new Float64Array(fftN);
const imag = new Float64Array(fftN);

// DC-remove + Hann window
for (let i = 0; i < frameCount; i++) {
  const hann = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (frameCount - 1)));
  real[i] = (deltas[i]! - m) * hann;
}

fftInPlace(real, imag, fftN);

// Magnitude spectrum (first half), skip bins 0-2
const halfN = fftN >> 1;
const magnitudes = new Float64Array(halfN);
for (let i = 0; i < halfN; i++) {
  magnitudes[i] = Math.sqrt(real[i]! * real[i]! + imag[i]! * imag[i]!);
}

// Median magnitude for threshold
const magSorted = Float64Array.from(magnitudes.subarray(3)).sort();
const magMedian = magSorted[Math.floor(magSorted.length / 2)]!;

// Top 3 peaks above 3x median magnitude
interface FFTPeak {
  bin: number;
  cyclesPerFrame: number;
  periodFrames: number;
  magnitude: number;
}
const fftPeaks: FFTPeak[] = [];
for (let i = 3; i < halfN; i++) {
  if (
    magnitudes[i]! > 3 * magMedian &&
    (i === 3 || magnitudes[i]! > magnitudes[i - 1]!) &&
    (i === halfN - 1 || magnitudes[i]! > magnitudes[i + 1]!)
  ) {
    fftPeaks.push({
      bin: i,
      cyclesPerFrame: i / fftN,
      periodFrames: fftN / i,
      magnitude: magnitudes[i]!,
    });
  }
}
fftPeaks.sort((a, b) => b.magnitude - a.magnitude);

console.log(`\n─── Periodicity (FFT) ───`);
if (fftPeaks.length === 0) {
  console.log('  No significant periodic components detected');
} else {
  console.log(
    `  ${'Rank'.padEnd(5)} | ${'Cycles/frame'.padStart(13)} | ${'Period(frames)'.padStart(15)} | ${'Magnitude'.padStart(10)}`,
  );
  console.log(`  ${'-'.repeat(50)}`);
  for (let i = 0; i < Math.min(3, fftPeaks.length); i++) {
    const p = fftPeaks[i]!;
    console.log(
      `  ${String(i + 1).padEnd(5)} | ${p.cyclesPerFrame.toFixed(4).padStart(13)} | ${p.periodFrames.toFixed(1).padStart(15)} | ${p.magnitude.toFixed(1).padStart(10)}`,
    );
  }
}

// ─── Section 7: Histogram ────────────────────────────────────────────────────

console.log(`\n─── Histogram (${histMin.toFixed(1)} - ${p99.toFixed(1)} ms) ───`);
const histBinsDisplay = 20;
const dispBinWidth = (p99 - histMin) / histBinsDisplay;
if (dispBinWidth > 0) {
  const dispHist = new Float64Array(histBinsDisplay);
  for (let i = 0; i < frameCount; i++) {
    const v = deltas[i]!;
    if (v >= histMin && v <= p99) {
      const bin = Math.min(histBinsDisplay - 1, Math.floor((v - histMin) / dispBinWidth));
      dispHist[bin]++;
    }
  }
  const dispMax = Math.max(...dispHist);
  const barMaxWidth = 60;
  for (let i = 0; i < histBinsDisplay; i++) {
    const lo = histMin + i * dispBinWidth;
    const hi = lo + dispBinWidth;
    const barLen = dispMax > 0 ? Math.round((dispHist[i]! / dispMax) * barMaxWidth) : 0;
    const bar = '█'.repeat(barLen);
    console.log(
      `  ${lo.toFixed(1).padStart(7)} - ${hi.toFixed(1).padStart(7)} | ${bar} ${dispHist[i]!.toFixed(0)}`,
    );
  }
} else {
  console.log(`  All ${frameCount} frames at ${histMin.toFixed(3)} ms`);
}

// ─── Summary CSV ─────────────────────────────────────────────────────────────

if (summaryCsvPath) {
  const outlierCount = (() => {
    let c = 0;
    for (let i = 0; i < frameCount; i++) if (deltas[i]! > 2 * med) c++;
    return c;
  })();
  const outlierPct = ((outlierCount / frameCount) * 100).toFixed(2);
  // Extract timestamp from filename
  const tsMatch = filePath.match(/capture-(\d+)/);
  const timestamp = tsMatch ? tsMatch[1] : 'unknown';

  const row = `${timestamp},${frameCount},${med.toFixed(3)},${m.toFixed(3)},${p95.toFixed(3)},${p99.toFixed(3)},${maxVal.toFixed(3)},${outlierPct},${classification}`;

  if (!existsSync(summaryCsvPath)) {
    writeFileSync(
      summaryCsvPath,
      'timestamp,frames,median_ms,mean_ms,p95_ms,p99_ms,max_ms,outlier_pct,classification\n' +
        row +
        '\n',
    );
  } else {
    const existing = readFileSync(summaryCsvPath, 'utf-8');
    writeFileSync(summaryCsvPath, existing + row + '\n');
  }
  console.log(`\n  Summary row appended to ${summaryCsvPath}`);
}
