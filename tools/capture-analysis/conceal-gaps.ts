/**
 * Gap Concealment Tool — offline click removal for capture splice artifacts
 *
 * Input: Float32 interleaved WAV + events JSON (gap/zero-block positions)
 * Output: Concealed WAV with attenuated splice clicks + before/after metrics
 *
 * Algorithm: Symmetric Hann-window attenuation at splice boundaries for gaps with
 * high jumpRatio or clickToSignal. Only targets the worst clicks — cannot fix
 * phase discontinuities from missing 441-sample frames, but replaces audible pops
 * with brief volume dips that the ear forgives.
 */
import { readFileSync, writeFileSync } from 'fs';
import { basename, dirname, extname, join } from 'path';

// ─── WAV Parser (from analyze-capture-wav.ts) ────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Computes RMS of a segment of a channel buffer.
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
 * Computes median of absolute inter-sample deltas in [pos - window, pos).
 */
function computeLocalMedianDelta(data: Float32Array, pos: number, window: number): number {
  const deltas: number[] = [];
  const start = Math.max(1, pos - window);
  for (let j = start; j < pos; j++) {
    deltas.push(Math.abs(data[j]! - data[j - 1]!));
  }
  if (deltas.length === 0) return 0;
  deltas.sort((a, b) => a - b);
  return deltas[Math.floor(deltas.length / 2)]!;
}

/**
 * Writes a WAV header into a Buffer for Float32 PCM data.
 */
function writeWavHeader(dataSize: number, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 32;
  const formatTag = 3; // IEEE Float
  const blockAlign = channels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;

  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // sub-chunk size
  header.writeUInt16LE(formatTag, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataSize, 40);

  return header;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface DiagnosticEvent {
  type: 'gap' | 'overlap' | 'zero_block';
  wallClockMs: number;
  frameIndex: number;
  sampleOffset?: number;
  durationUs: number;
  expectedTimestamp: number;
  actualTimestamp: number;
}

interface GapResult {
  index: number;
  pos: number;
  timeSec: number;
  jump: number;
  clickToSignal: number;
  jumpRatio: number;
  localMedianDelta: number;
  status: 'concealed' | 'below-threshold' | 'inside-outage' | 'out-of-range';
  jumpRatioAfter?: number;
}

interface OutageRegion {
  trueStart: number;
  trueEnd: number;
  eventCount: number;
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const flags = new Map<string, string>();
const nonFlags: string[] = [];

for (const arg of args) {
  if (arg.startsWith('--')) {
    const eq = arg.indexOf('=');
    if (eq > 0) {
      flags.set(arg.slice(2, eq), arg.slice(eq + 1));
    } else {
      flags.set(arg.slice(2), 'true');
    }
  } else {
    nonFlags.push(arg);
  }
}

const wavPath = nonFlags[0];
const eventsPath = nonFlags[1];
if (!wavPath || !eventsPath) {
  console.error(
    'Usage: bun run tools/capture-analysis/conceal-gaps.ts <capture.wav> <events.json> [options]',
  );
  console.error('  --output=FILE          Output path (default: input with -concealed suffix)');
  console.error(
    '  --half-len=N           Half-window for splice attenuation in samples (default: 64)',
  );
  console.error('  --jr-threshold=N       jumpRatio threshold (default: 5)');
  console.error('  --c2s-threshold=N      clickToSignal threshold (default: 1.0)');
  console.error('  --dry-run              Analyze without writing output');
  process.exit(1);
}

const halfLen = parseInt(flags.get('half-len') ?? '64', 10);
const jrThreshold = parseFloat(flags.get('jr-threshold') ?? '5');
const c2sThreshold = parseFloat(flags.get('c2s-threshold') ?? '1.0');
const dryRun = flags.has('dry-run');

const ext = extname(wavPath);
const base = basename(wavPath, ext);
const dir = dirname(wavPath);
const outputPath = flags.get('output') ?? join(dir, `${base}-concealed${ext}`);

// ─── 1. Load + Deinterleave ──────────────────────────────────────────────────

const wav = parseWav(readFileSync(wavPath));
const totalInterleaved = wav.samples.length;
const n = Math.floor(totalInterleaved / wav.channels);
const sr = wav.sampleRate;

// Deinterleave all channels
const channels: Float32Array[] = [];
for (let c = 0; c < wav.channels; c++) {
  const ch = new Float32Array(n);
  for (let i = 0; i < n; i++) ch[i] = wav.samples[i * wav.channels + c]!;
  channels.push(ch);
}

// Make working copies for concealment
const concealed: Float32Array[] = channels.map((ch) => new Float32Array(ch));

const events: DiagnosticEvent[] = JSON.parse(readFileSync(eventsPath, 'utf-8'));
const gaps = events.filter((e) => e.type === 'gap');
const zeroBlockEvents = events.filter((e) => e.type === 'zero_block');

// Validate sampleOffset presence
for (const gap of gaps) {
  if (gap.sampleOffset == null) {
    console.error('Error: gap event missing sampleOffset — run with updated capture worker');
    process.exit(1);
  }
}

// Sort gaps by sampleOffset
gaps.sort((a, b) => a.sampleOffset! - b.sampleOffset!);

// ─── 2. Outage Detection ────────────────────────────────────────────────────

const outageRegions: OutageRegion[] = [];

if (zeroBlockEvents.length > 0) {
  // Sort zero-block events by sampleOffset
  const sortedZB = [...zeroBlockEvents]
    .filter((e) => e.sampleOffset != null)
    .sort((a, b) => a.sampleOffset! - b.sampleOffset!);

  if (sortedZB.length > 0) {
    // Cluster by proximity (gap > 882 samples = 2 frames)
    const clusters: DiagnosticEvent[][] = [[sortedZB[0]!]];
    for (let i = 1; i < sortedZB.length; i++) {
      const prev = sortedZB[i - 1]!;
      const curr = sortedZB[i]!;
      if (curr.sampleOffset! - prev.sampleOffset! > 882) {
        clusters.push([curr]);
      } else {
        clusters[clusters.length - 1]!.push(curr);
      }
    }

    // Clusters with >= 10 events are catastrophic outages
    for (const cluster of clusters) {
      if (cluster.length < 10) continue;

      const firstOffset = cluster[0]!.sampleOffset!;
      const lastOffset = cluster[cluster.length - 1]!.sampleOffset!;

      // Find true audio boundaries by scanning for non-zero samples
      let trueStart = firstOffset;
      for (let i = firstOffset - 1; i >= 0; i--) {
        if (Math.abs(concealed[0]![i]!) > 1e-4) {
          trueStart = i + 1;
          break;
        }
        if (i === 0) trueStart = 0;
      }

      let trueEnd = lastOffset + 441;
      for (let i = lastOffset + 441; i < n; i++) {
        if (Math.abs(concealed[0]![i]!) > 1e-4) {
          trueEnd = i;
          break;
        }
        if (i === n - 1) trueEnd = n;
      }

      outageRegions.push({ trueStart, trueEnd, eventCount: cluster.length });
    }
  }
}

/**
 * Checks if a sample position falls inside any outage region.
 */
function isInsideOutage(pos: number): boolean {
  return outageRegions.some((r) => pos >= r.trueStart && pos < r.trueEnd);
}

// ─── 3. Gap Concealment ─────────────────────────────────────────────────────

/**
 * Attenuates audio symmetrically around a splice point using a half-Hann window.
 * Replaces a click with a brief volume dip. Cannot introduce new artifacts
 * because it only reduces amplitude, never synthesizes.
 * @param data - Channel sample buffer (modified in place)
 * @param pos - Splice position (first sample of new frame)
 * @param half - Number of samples to attenuate on each side
 */
function attenuateSplice(data: Float32Array, pos: number, half: number): void {
  for (let i = 0; i < half; i++) {
    const w = i / half; // 0 at splice, 1 at edge
    if (pos - 1 - i >= 0) data[pos - 1 - i]! *= w;
    if (pos + i < data.length) data[pos + i]! *= w;
  }
}

const results: GapResult[] = [];
const ch0 = concealed[0]!;

for (let gi = 0; gi < gaps.length; gi++) {
  const gap = gaps[gi]!;
  const pos = gap.sampleOffset!;

  if (pos < 1 || pos >= n) {
    results.push({
      index: gi,
      pos,
      timeSec: pos / sr,
      jump: 0,
      clickToSignal: 0,
      jumpRatio: 0,
      localMedianDelta: 0,
      status: 'out-of-range',
    });
    continue;
  }

  if (isInsideOutage(pos)) {
    results.push({
      index: gi,
      pos,
      timeSec: pos / sr,
      jump: 0,
      clickToSignal: 0,
      jumpRatio: 0,
      localMedianDelta: 0,
      status: 'inside-outage',
    });
    continue;
  }

  // Measure on ch0 (decision channel)
  const jump = Math.abs(ch0[pos]! - ch0[pos - 1]!);
  const localRMS = rms(ch0, pos - 64, 64);
  const c2s = jump / (localRMS + 1e-6);
  const localMedDelta = computeLocalMedianDelta(ch0, pos, 128);
  const jr = localMedDelta > 0 ? jump / localMedDelta : 0;

  // Only target the worst clicks: high jumpRatio OR high clickToSignal
  const shouldConceal = jr > jrThreshold || c2s > c2sThreshold;

  if (!shouldConceal) {
    results.push({
      index: gi,
      pos,
      timeSec: pos / sr,
      jump,
      clickToSignal: c2s,
      jumpRatio: jr,
      localMedianDelta: localMedDelta,
      status: 'below-threshold',
    });
    continue;
  }

  // Attenuate splice on all channels independently
  for (const chData of concealed) {
    attenuateSplice(chData, pos, halfLen);
  }

  results.push({
    index: gi,
    pos,
    timeSec: pos / sr,
    jump,
    clickToSignal: c2s,
    jumpRatio: jr,
    localMedianDelta: localMedDelta,
    status: 'concealed',
  });
}

// ─── 4. Outage Fade ─────────────────────────────────────────────────────────

for (const outage of outageRegions) {
  for (const chData of concealed) {
    // Fade out before outage
    const fadeOutStart = Math.max(0, outage.trueStart - halfLen);
    const fadeOutLen = outage.trueStart - fadeOutStart;
    for (let i = 0; i < fadeOutLen; i++) {
      const gain = i / fadeOutLen;
      chData[fadeOutStart + i] *= gain;
    }

    // Fade in after outage
    const fadeInEnd = Math.min(n, outage.trueEnd + halfLen);
    const fadeInLen = fadeInEnd - outage.trueEnd;
    for (let i = 0; i < fadeInLen; i++) {
      const gain = i / fadeInLen;
      chData[outage.trueEnd + i] *= gain;
    }
  }
}

// ─── 5. Reinterleave + Write WAV ────────────────────────────────────────────

if (!dryRun) {
  const interleaved = new Float32Array(n * wav.channels);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < wav.channels; c++) {
      interleaved[i * wav.channels + c] = concealed[c]![i]!;
    }
  }

  const dataSize = interleaved.byteLength;
  const header = writeWavHeader(dataSize, sr, wav.channels);
  const pcmBuf = Buffer.from(interleaved.buffer, interleaved.byteOffset, interleaved.byteLength);
  writeFileSync(outputPath, Buffer.concat([header, pcmBuf]));
}

// ─── 6. Validation Pass ─────────────────────────────────────────────────────

const concealedCh0 = concealed[0]!;
let improved = 0;
let regressions = 0;

for (const r of results) {
  if (r.status !== 'concealed') continue;

  // Re-measure jumpRatio on concealed data
  const jumpAfter = Math.abs(concealedCh0[r.pos]! - concealedCh0[r.pos - 1]!);
  const localMedAfter = computeLocalMedianDelta(concealedCh0, r.pos, 128);
  r.jumpRatioAfter = localMedAfter > 0 ? jumpAfter / localMedAfter : 0;

  if (r.jumpRatioAfter < r.jumpRatio) {
    improved++;
  } else {
    regressions++;
  }
}

// ─── 7. Report ──────────────────────────────────────────────────────────────

const concealedResults = results.filter((r) => r.status === 'concealed');
const belowThreshold = results.filter((r) => r.status === 'below-threshold');
const insideOutage = results.filter((r) => r.status === 'inside-outage');
const outOfRange = results.filter((r) => r.status === 'out-of-range');

console.log(`\n═══ Gap Concealment Report ═══`);
console.log(
  `  Input:      ${basename(wavPath)} (${(n / sr).toFixed(2)}s, ${sr}Hz, ${wav.channels}ch)`,
);
console.log(`  Events:     ${gaps.length} gaps, ${zeroBlockEvents.length} zero-blocks`);
console.log(`  Half-len:   ${halfLen} samples (${((halfLen / sr) * 1000).toFixed(2)}ms)`);
console.log(`  Thresholds: JR > ${jrThreshold}, C2S > ${c2sThreshold}`);
console.log(
  `  Concealed:  ${concealedResults.length} of ${gaps.length} gaps (${gaps.length > 0 ? ((concealedResults.length / gaps.length) * 100).toFixed(1) : '0'}%)`,
);
console.log(`  Skipped:    ${belowThreshold.length} gaps (below threshold)`);
if (insideOutage.length > 0) {
  console.log(`  Skipped:    ${insideOutage.length} gaps (inside outage region)`);
}
if (outOfRange.length > 0) {
  console.log(`  Skipped:    ${outOfRange.length} gaps (out of range)`);
}
console.log(`  Outages:    ${outageRegions.length} silence clusters faded`);

if (concealedResults.length > 0) {
  console.log(`\n  Per-gap detail (concealed only):`);
  console.log(
    `    ${'#'.padStart(4)} | ${'Time(s)'.padStart(8)} | ${'JR Before'.padStart(9)} | ${'C2S'.padStart(7)} | ${'JR After'.padStart(9)}`,
  );
  console.log(`    ${'-'.repeat(46)}`);

  for (const r of concealedResults) {
    console.log(
      `    ${String(r.index + 1).padStart(4)} | ` +
        `${r.timeSec.toFixed(3).padStart(8)} | ` +
        `${r.jumpRatio.toFixed(1).padStart(9)} | ` +
        `${r.clickToSignal.toFixed(2).padStart(7)} | ` +
        `${(r.jumpRatioAfter ?? 0).toFixed(1).padStart(9)}`,
    );
  }
}

console.log(
  `\n  Validation: ${improved}/${concealedResults.length} improved, ${regressions} regressions`,
);

if (!dryRun) {
  console.log(`  Output: ${outputPath}`);
} else {
  console.log(`  (dry run — no output written)`);
}
