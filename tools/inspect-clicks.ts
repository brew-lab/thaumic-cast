/**
 * Inspect raw waveform around known click regions to understand artifact shape.
 * Looks for: zero runs, sample repetition, level jumps, quantum-boundary artifacts.
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
  console.error('Usage: bun run tools/inspect-clicks.ts <input.wav>');
  process.exit(1);
}

const wav = parseWav(readFileSync(filePath));
const n = Math.floor(wav.samples.length / wav.channels);
const sr = wav.sampleRate;

// Extract channel 0
const ch0 = new Float32Array(n);
for (let i = 0; i < n; i++) ch0[i] = wav.samples[i * wav.channels]!;

console.log(`\nInspecting: ${filePath}`);
console.log(`  ${sr}Hz, ${wav.channels}ch, ${(n / sr).toFixed(2)}s\n`);

// ── 1. Find zero runs ──────────────────────────────────────────────────────
console.log('═══ Zero Runs (≥4 consecutive zeros) ═══');
let zeroRuns = 0;
for (let i = 0; i < n; ) {
  if (ch0[i] === 0) {
    let runStart = i;
    while (i < n && ch0[i] === 0) i++;
    const runLen = i - runStart;
    if (runLen >= 4) {
      const timeSec = runStart / sr;
      console.log(
        `  ${timeSec.toFixed(4)}s  pos=${runStart}  len=${runLen} (${(runLen / 128).toFixed(1)} quanta)`,
      );
      zeroRuns++;
    }
  } else {
    i++;
  }
}
console.log(`  Total: ${zeroRuns} zero runs\n`);

// ── 2. Find sample repetition runs ─────────────────────────────────────────
console.log('═══ Sample Repetition (≥8 identical non-zero consecutive samples) ═══');
let repRuns = 0;
for (let i = 0; i < n; ) {
  const val = ch0[i]!;
  if (val !== 0) {
    let runStart = i;
    while (i < n && ch0[i] === val) i++;
    const runLen = i - runStart;
    if (runLen >= 8) {
      const timeSec = runStart / sr;
      console.log(
        `  ${timeSec.toFixed(4)}s  pos=${runStart}  len=${runLen}  val=${val.toFixed(6)}`,
      );
      repRuns++;
    }
  } else {
    i++;
  }
}
console.log(`  Total: ${repRuns} repetition runs\n`);

// ── 3. Large instantaneous jumps (d1) ──────────────────────────────────────
// Compute all d1 values, find outliers
const d1 = new Float64Array(n - 1);
for (let i = 0; i < n - 1; i++) d1[i] = Math.abs(ch0[i + 1]! - ch0[i]!);
const d1sorted = Array.from(d1).sort((a, b) => a - b);
const d1p99 = d1sorted[Math.floor(d1sorted.length * 0.99)]!;
const d1p999 = d1sorted[Math.floor(d1sorted.length * 0.999)]!;
const d1p9999 = d1sorted[Math.floor(d1sorted.length * 0.9999)]!;
console.log(`═══ Instantaneous Jumps (d1) ═══`);
console.log(`  P99=${d1p99.toFixed(6)}, P99.9=${d1p999.toFixed(6)}, P99.99=${d1p9999.toFixed(6)}`);

// Find extreme jumps (>10x p99.9) in the target regions
const targetRegions = [
  { label: '13-15s', start: 13, end: 15 },
  { label: '22-24s', start: 22, end: 24 },
  { label: '25-28s', start: 25, end: 28 },
];

for (const r of targetRegions) {
  const rStart = Math.floor(r.start * sr);
  const rEnd = Math.min(Math.floor(r.end * sr), n - 1);
  const jumps: { pos: number; d1: number }[] = [];
  for (let i = rStart; i < rEnd; i++) {
    if (d1[i]! > d1p999 * 3) {
      jumps.push({ pos: i, d1: d1[i]! });
    }
  }
  jumps.sort((a, b) => b.d1 - a.d1);
  console.log(`\n  ${r.label}: ${jumps.length} extreme jumps (>3x P99.9)`);
  for (const j of jumps.slice(0, 10)) {
    const timeSec = j.pos / sr;
    // Show surrounding samples
    const ctx = 4;
    const before = Array.from(
      { length: ctx },
      (_, k) => ch0[j.pos - ctx + k]?.toFixed(5) ?? '?',
    ).join(', ');
    const after = Array.from({ length: ctx }, (_, k) => ch0[j.pos + 1 + k]?.toFixed(5) ?? '?').join(
      ', ',
    );
    console.log(
      `    ${timeSec.toFixed(4)}s pos=${j.pos} d1=${j.d1.toFixed(5)}: [...${before}] | [${after}...]`,
    );
  }
}

// ── 4. Quantum boundary analysis ───────────────────────────────────────────
// Check if artifacts align with 128-sample boundaries
console.log(`\n═══ Quantum Boundary Analysis ═══`);
const quantumSize = 128;
const boundaryJumps: { pos: number; d1: number }[] = [];
const nonBoundaryJumps: { pos: number; d1: number }[] = [];

for (let i = 0; i < n - 1; i++) {
  if (d1[i]! > d1p999 * 3) {
    if (i % quantumSize === 0 || i % quantumSize === quantumSize - 1) {
      boundaryJumps.push({ pos: i, d1: d1[i]! });
    } else {
      nonBoundaryJumps.push({ pos: i, d1: d1[i]! });
    }
  }
}
console.log(`  Extreme jumps at quantum boundaries: ${boundaryJumps.length}`);
console.log(`  Extreme jumps NOT at quantum boundaries: ${nonBoundaryJumps.length}`);

// ── 5. d² analysis in target regions ───────────────────────────────────────
console.log(`\n═══ d² Spikes in Target Regions ═══`);
const d2 = new Float64Array(n - 2);
for (let i = 0; i < n - 2; i++) d2[i] = Math.abs(ch0[i + 2]! - 2 * ch0[i + 1]! + ch0[i]!);
const d2sorted = Array.from(d2).sort((a, b) => a - b);
const d2p999 = d2sorted[Math.floor(d2sorted.length * 0.999)]!;

for (const r of targetRegions) {
  const rStart = Math.floor(r.start * sr);
  const rEnd = Math.min(Math.floor(r.end * sr), n - 2);

  // Find clusters of high d² values
  const spikes: { pos: number; d2: number }[] = [];
  for (let i = rStart; i < rEnd; i++) {
    if (d2[i]! > d2p999 * 5) {
      spikes.push({ pos: i, d2: d2[i]! });
    }
  }

  // Cluster nearby spikes
  const clusters: { start: number; end: number; maxD2: number }[] = [];
  for (const s of spikes) {
    const last = clusters[clusters.length - 1];
    if (last && s.pos - last.end < 256) {
      last.end = s.pos;
      last.maxD2 = Math.max(last.maxD2, s.d2);
    } else {
      clusters.push({ start: s.pos, end: s.pos, maxD2: s.d2 });
    }
  }

  console.log(`\n  ${r.label}: ${clusters.length} d² spike clusters (>5x P99.9)`);
  for (const c of clusters.slice(0, 10)) {
    const timeSec = c.start / sr;
    const len = c.end - c.start + 1;
    console.log(`    ${timeSec.toFixed(4)}s  len=${len}  maxD2=${c.maxD2.toFixed(5)}`);
    // Show raw samples around the start of the cluster
    const ctx = 6;
    const samples = Array.from({ length: ctx * 2 + 1 }, (_, k) => {
      const idx = c.start - ctx + k;
      return ch0[idx]?.toFixed(4) ?? '?';
    });
    console.log(`      samples: [${samples.join(', ')}]`);
  }
}

// ── 6. Compare bad vs good: look at d1 histogram in target regions ────────
console.log(`\n═══ d1 Distribution in Target Regions ═══`);
for (const r of targetRegions) {
  const rStart = Math.floor(r.start * sr);
  const rEnd = Math.min(Math.floor(r.end * sr), n - 1);
  const regionD1: number[] = [];
  for (let i = rStart; i < rEnd; i++) regionD1.push(d1[i]!);
  regionD1.sort((a, b) => a - b);
  const p = (pct: number) => regionD1[Math.floor((regionD1.length * pct) / 100)]!;
  console.log(
    `  ${r.label}: P95=${p(95).toFixed(5)} P99=${p(99).toFixed(5)} P99.9=${p(99.9).toFixed(5)} P99.99=${p(99.99).toFixed(5)} max=${regionD1[regionD1.length - 1]!.toFixed(5)}`,
  );
}
