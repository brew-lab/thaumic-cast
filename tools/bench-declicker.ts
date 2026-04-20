/**
 * Declicker Performance Benchmark
 *
 * Benchmarks the declickPass algorithm in two modes:
 *   1. Batch — full 10s buffer processed at once (current approach)
 *   2. Streaming — 480-sample chunks with ring buffer context
 *
 * Target: Surface Go (2-core Intel Pentium, ~1.6GHz)
 * Audio: 48kHz stereo Float32, chunks of 128-480 samples every 2.67-10ms
 * Minimum throughput: 96,000 samples/sec (48kHz x 2 channels)
 *
 * Usage: bun run tools/bench-declicker.ts
 */

// ─────────────────────────────────────────────────────────────────────────────
// Core functions copied from envelope-smooth.ts
// ─────────────────────────────────────────────────────────────────────────────

function hermite(t: number, v0: number, v1: number, m0: number, m1: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * v0 + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * v1 + (t3 - t2) * m1
  );
}

function declickPass(
  mono: Float32Array,
  baseD2Threshold: number,
  maxRunLength: number,
): { corrected: Float32Array; glitchCount: number; samplesFixed: number } {
  const n = mono.length;
  const corrected = new Float32Array(mono);

  // Compute |2nd derivative| for all samples
  const d2 = new Float64Array(n);
  for (let i = 2; i < n; i++) {
    d2[i] = Math.abs(mono[i]! - 2 * mono[i - 1]! + mono[i - 2]!);
  }

  // Compute local RMS for adaptive threshold (sliding window +/-64 samples)
  const rmsHalf = 64;
  const localRms = new Float64Array(n);
  // Use cumulative sum of squares for efficiency
  const cumSq = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    cumSq[i + 1] = cumSq[i]! + mono[i]! * mono[i]!;
  }
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - rmsHalf);
    const hi = Math.min(n, i + rmsHalf);
    localRms[i] = Math.sqrt((cumSq[hi]! - cumSq[lo]!) / (hi - lo));
  }

  let glitchCount = 0;
  let samplesFixed = 0;

  const anchorMargin = 3;
  let i = anchorMargin;
  while (i < n - anchorMargin) {
    const adaptiveThreshold = Math.max(baseD2Threshold, localRms[i]! * 0.008);

    if (d2[i]! <= adaptiveThreshold) {
      i++;
      continue;
    }

    const glitchStart = Math.max(anchorMargin, i - 2);

    let j = i + 1;
    while (j < n - anchorMargin && j - glitchStart < maxRunLength) {
      const thr = Math.max(baseD2Threshold, localRms[j]! * 0.008);
      if (d2[j]! <= thr && d2[Math.min(n - 1, j + 1)]! <= thr && d2[Math.min(n - 1, j + 2)]! <= thr)
        break;
      j++;
    }

    const glitchEnd = Math.min(n - anchorMargin, j + 1);
    const runLen = glitchEnd - glitchStart;

    if (
      runLen > 0 &&
      runLen <= maxRunLength &&
      glitchStart >= anchorMargin &&
      glitchEnd < n - anchorMargin
    ) {
      const a0 = glitchStart - 1;
      const a1 = glitchEnd;
      const span = a1 - a0;

      if (span > 1) {
        const v0 = mono[a0]!;
        const v1 = mono[a1]!;
        const d0 = (mono[a0]! - mono[a0 - 2]!) * 0.5;
        const d1 = (mono[Math.min(n - 1, a1 + 2)]! - mono[a1]!) * 0.5;

        for (let k = glitchStart; k < glitchEnd; k++) {
          const t = (k - a0) / span;
          corrected[k] = hermite(t, v0, v1, d0 * span, d1 * span);
        }

        glitchCount++;
        samplesFixed += runLen;
      }
    }

    i = glitchEnd + 1;
  }

  return { corrected, glitchCount, samplesFixed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming declicker — ring-buffer based, processes chunk-at-a-time
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Streaming declicker state. Maintains a ring buffer of recent samples
 * so that context (for d2, localRms, and lookahead) is available across
 * chunk boundaries.
 *
 * Design:
 * - Ring buffer holds `contextSize` historical samples + current chunk
 * - localRms computed incrementally using a running sum-of-squares
 * - Lookahead of 64 samples: we delay output by `lookahead` samples,
 *   processing once enough future context has arrived
 * - Glitch end-detection needs ~3 samples lookahead (trivially covered)
 */
class StreamingDeclicker {
  private readonly baseD2Threshold: number;
  private readonly maxRunLength: number;
  private readonly rmsHalf: number;
  private readonly lookahead: number;
  private readonly contextSamples: number;

  // Linear buffer that accumulates context + pending samples
  // We flush processed samples periodically to avoid unbounded growth
  private buffer: Float32Array;
  private bufferLen: number;
  // How many samples from the buffer have already been output
  private outputCursor: number;

  // Running sum-of-squares for incremental RMS
  private runningSumSq: number;
  private runningSumCount: number;

  public glitchCount: number;
  public samplesFixed: number;

  constructor(baseD2Threshold: number = 0.004, maxRunLength: number = 64) {
    this.baseD2Threshold = baseD2Threshold;
    this.maxRunLength = maxRunLength;
    this.rmsHalf = 64;
    this.lookahead = 64; // delay output by this many samples for RMS lookahead
    this.contextSamples = this.rmsHalf + 3 + this.maxRunLength + 10; // enough history

    // Pre-allocate buffer large enough for context + a big chunk
    const initSize = this.contextSamples + 2048;
    this.buffer = new Float32Array(initSize);
    this.bufferLen = 0;
    this.outputCursor = 0;

    this.runningSumSq = 0;
    this.runningSumCount = 0;
    this.glitchCount = 0;
    this.samplesFixed = 0;
  }

  /**
   * Push a chunk of samples and get back the declicked output.
   * Output may be shorter than input due to lookahead delay.
   * Call flush() at end of stream to get remaining samples.
   */
  process(chunk: Float32Array): Float32Array {
    // Ensure buffer has room
    const needed = this.bufferLen + chunk.length;
    if (needed > this.buffer.length) {
      const newBuf = new Float32Array(Math.max(needed * 2, this.buffer.length * 2));
      newBuf.set(this.buffer.subarray(0, this.bufferLen));
      this.buffer = newBuf;
    }

    // Append chunk
    this.buffer.set(chunk, this.bufferLen);
    this.bufferLen += chunk.length;

    // Process: we can produce output up to (bufferLen - lookahead)
    const processableEnd = this.bufferLen - this.lookahead;
    if (processableEnd <= this.outputCursor) {
      return new Float32Array(0);
    }

    // Run declick on the processable region
    const output = this.processRange(this.outputCursor, processableEnd);

    // Compact buffer: keep only what we need for context
    const keepFrom = Math.max(0, processableEnd - this.contextSamples);
    if (keepFrom > 0) {
      this.buffer.copyWithin(0, keepFrom, this.bufferLen);
      this.bufferLen -= keepFrom;
      this.outputCursor -= keepFrom;
    }

    return output;
  }

  /** Flush remaining samples at end of stream. */
  flush(): Float32Array {
    if (this.bufferLen <= this.outputCursor) {
      return new Float32Array(0);
    }
    const output = this.processRange(this.outputCursor, this.bufferLen);
    return output;
  }

  private processRange(start: number, end: number): Float32Array {
    const buf = this.buffer;
    const n = this.bufferLen;
    const outLen = end - start;
    const output = new Float32Array(outLen);
    const anchorMargin = 3;

    // Compute d2 for the range we need (with context)
    // We need d2 for indices [start..end+3] approximately
    // d2[i] depends on i, i-1, i-2

    let i = start;
    while (i < end) {
      // Compute d2 at position i
      let d2i = 0;
      if (i >= 2) {
        d2i = Math.abs(buf[i]! - 2 * buf[i - 1]! + buf[i - 2]!);
      }

      // Compute local RMS at position i
      const lo = Math.max(0, i - this.rmsHalf);
      const hi = Math.min(n, i + this.rmsHalf);
      let sumSq = 0;
      for (let s = lo; s < hi; s++) {
        sumSq += buf[s]! * buf[s]!;
      }
      const localRms = Math.sqrt(sumSq / (hi - lo));

      const adaptiveThreshold = Math.max(this.baseD2Threshold, localRms * 0.008);

      if (d2i <= adaptiveThreshold || i < anchorMargin || i >= n - anchorMargin) {
        output[i - start] = buf[i]!;
        i++;
        continue;
      }

      // Found potential glitch
      const glitchStart = Math.max(anchorMargin, i - 2);

      // Scan forward for end
      let j = i + 1;
      while (j < n - anchorMargin && j - glitchStart < this.maxRunLength) {
        const d2j = j >= 2 ? Math.abs(buf[j]! - 2 * buf[j - 1]! + buf[j - 2]!) : 0;
        // Compute local RMS at j
        const loJ = Math.max(0, j - this.rmsHalf);
        const hiJ = Math.min(n, j + this.rmsHalf);
        let sqJ = 0;
        for (let s = loJ; s < hiJ; s++) sqJ += buf[s]! * buf[s]!;
        const rmsJ = Math.sqrt(sqJ / (hiJ - loJ));
        const thrJ = Math.max(this.baseD2Threshold, rmsJ * 0.008);

        const j1 = Math.min(n - 1, j + 1);
        const d2j1 = j1 >= 2 ? Math.abs(buf[j1]! - 2 * buf[j1 - 1]! + buf[j1 - 2]!) : 0;
        const j2 = Math.min(n - 1, j + 2);
        const d2j2 = j2 >= 2 ? Math.abs(buf[j2]! - 2 * buf[j2 - 1]! + buf[j2 - 2]!) : 0;

        if (d2j <= thrJ && d2j1 <= thrJ && d2j2 <= thrJ) break;
        j++;
      }

      const glitchEnd = Math.min(n - anchorMargin, j + 1);
      const runLen = glitchEnd - glitchStart;

      if (
        runLen > 0 &&
        runLen <= this.maxRunLength &&
        glitchStart >= anchorMargin &&
        glitchEnd < n - anchorMargin
      ) {
        const a0 = glitchStart - 1;
        const a1 = glitchEnd;
        const span = a1 - a0;

        if (span > 1) {
          const v0 = buf[a0]!;
          const v1 = buf[a1]!;
          const d0 = (buf[a0]! - buf[a0 - 2]!) * 0.5;
          const d1 = (buf[Math.min(n - 1, a1 + 2)]! - buf[a1]!) * 0.5;

          for (let k = glitchStart; k < glitchEnd; k++) {
            const t = (k - a0) / span;
            const repaired = hermite(t, v0, v1, d0 * span, d1 * span);
            buf[k] = repaired; // mutate buffer so subsequent chunks see repairs
            if (k >= start && k < end) {
              output[k - start] = repaired;
            }
          }

          this.glitchCount++;
          this.samplesFixed += runLen;
        }
      }

      // Copy any unmodified samples in [start..glitchStart) that we skipped
      // (already handled by the passthrough above, but glitch region needs filling)
      // Fill passthrough for samples in [glitchStart..glitchEnd) already done above
      // Fill passthrough for samples before glitchStart if they weren't set
      for (let k = i; k < Math.min(glitchStart, end); k++) {
        if (k >= start) output[k - start] = buf[k]!;
      }

      i = Math.max(i + 1, glitchEnd + 1);
    }

    this.outputCursor = end;
    return output;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Optimized streaming declicker — avoids per-sample RMS recomputation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Optimized streaming declicker. Key differences from naive streaming:
 * - Pre-computes cumulative sum-of-squares over the buffer for O(1) RMS queries
 * - Pre-computes d2 array over the buffer (same as batch)
 * - Only recomputes these arrays when new data arrives, not per-sample
 *
 * This is essentially a "chunked batch" approach: run the batch algorithm
 * on buffer windows that overlap by contextSamples.
 */
class OptimizedStreamingDeclicker {
  private readonly baseD2Threshold: number;
  private readonly maxRunLength: number;
  private readonly rmsHalf: number;
  private readonly lookahead: number;
  private readonly contextSamples: number;

  private buffer: Float32Array;
  private bufferLen: number;
  private outputCursor: number;

  public glitchCount: number;
  public samplesFixed: number;

  constructor(baseD2Threshold: number = 0.004, maxRunLength: number = 64) {
    this.baseD2Threshold = baseD2Threshold;
    this.maxRunLength = maxRunLength;
    this.rmsHalf = 64;
    this.lookahead = 64;
    // Need: rmsHalf behind, anchorMargin behind, maxRunLength behind for glitch that
    // started in previous chunk, plus lookahead + rmsHalf ahead
    this.contextSamples = this.rmsHalf + this.maxRunLength + 10;

    const initSize = this.contextSamples + 2048;
    this.buffer = new Float32Array(initSize);
    this.bufferLen = 0;
    this.outputCursor = 0;

    this.glitchCount = 0;
    this.samplesFixed = 0;
  }

  process(chunk: Float32Array): Float32Array {
    // Ensure buffer capacity
    const needed = this.bufferLen + chunk.length;
    if (needed > this.buffer.length) {
      const newBuf = new Float32Array(Math.max(needed * 2, this.buffer.length * 2));
      newBuf.set(this.buffer.subarray(0, this.bufferLen));
      this.buffer = newBuf;
    }

    this.buffer.set(chunk, this.bufferLen);
    this.bufferLen += chunk.length;

    const processableEnd = this.bufferLen - this.lookahead;
    if (processableEnd <= this.outputCursor) {
      return new Float32Array(0);
    }

    const output = this.processRangeBatch(this.outputCursor, processableEnd);

    // Compact
    const keepFrom = Math.max(0, processableEnd - this.contextSamples);
    if (keepFrom > 0) {
      this.buffer.copyWithin(0, keepFrom, this.bufferLen);
      this.bufferLen -= keepFrom;
      this.outputCursor -= keepFrom;
    }

    return output;
  }

  flush(): Float32Array {
    if (this.bufferLen <= this.outputCursor) return new Float32Array(0);
    return this.processRangeBatch(this.outputCursor, this.bufferLen);
  }

  /**
   * Run batch-style declick on a sub-range of the buffer, using the full
   * buffer for context (cumSq, d2, localRms all computed over full buffer).
   */
  private processRangeBatch(start: number, end: number): Float32Array {
    const buf = this.buffer;
    const n = this.bufferLen;
    const outLen = end - start;
    const output = new Float32Array(outLen);
    const anchorMargin = 3;
    const rmsHalf = this.rmsHalf;

    // Pre-compute d2 over the full buffer
    const d2 = new Float64Array(n);
    for (let i = 2; i < n; i++) {
      d2[i] = Math.abs(buf[i]! - 2 * buf[i - 1]! + buf[i - 2]!);
    }

    // Pre-compute cumulative sum of squares for O(1) RMS
    const cumSq = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      cumSq[i + 1] = cumSq[i]! + buf[i]! * buf[i]!;
    }

    // Copy input to output (passthrough)
    for (let i = 0; i < outLen; i++) {
      output[i] = buf[start + i]!;
    }

    // Detect and repair glitches
    let i = Math.max(start, anchorMargin);
    while (i < end && i < n - anchorMargin) {
      const lo = Math.max(0, i - rmsHalf);
      const hi = Math.min(n, i + rmsHalf);
      const localRms = Math.sqrt((cumSq[hi]! - cumSq[lo]!) / (hi - lo));

      const adaptiveThreshold = Math.max(this.baseD2Threshold, localRms * 0.008);

      if (d2[i]! <= adaptiveThreshold) {
        i++;
        continue;
      }

      const glitchStart = Math.max(anchorMargin, i - 2);

      let j = i + 1;
      while (j < n - anchorMargin && j - glitchStart < this.maxRunLength) {
        const loJ = Math.max(0, j - rmsHalf);
        const hiJ = Math.min(n, j + rmsHalf);
        const rmsJ = Math.sqrt((cumSq[hiJ]! - cumSq[loJ]!) / (hiJ - loJ));
        const thrJ = Math.max(this.baseD2Threshold, rmsJ * 0.008);

        if (
          d2[j]! <= thrJ &&
          d2[Math.min(n - 1, j + 1)]! <= thrJ &&
          d2[Math.min(n - 1, j + 2)]! <= thrJ
        )
          break;
        j++;
      }

      const glitchEnd = Math.min(n - anchorMargin, j + 1);
      const runLen = glitchEnd - glitchStart;

      if (
        runLen > 0 &&
        runLen <= this.maxRunLength &&
        glitchStart >= anchorMargin &&
        glitchEnd < n - anchorMargin
      ) {
        const a0 = glitchStart - 1;
        const a1 = glitchEnd;
        const span = a1 - a0;

        if (span > 1) {
          const v0 = buf[a0]!;
          const v1 = buf[a1]!;
          const d0 = (buf[a0]! - buf[a0 - 2]!) * 0.5;
          const d1 = (buf[Math.min(n - 1, a1 + 2)]! - buf[a1]!) * 0.5;

          for (let k = glitchStart; k < glitchEnd; k++) {
            const t = (k - a0) / span;
            const repaired = hermite(t, v0, v1, d0 * span, d1 * span);
            buf[k] = repaired;
            if (k >= start && k < end) {
              output[k - start] = repaired;
            }
          }

          this.glitchCount++;
          this.samplesFixed += runLen;
        }
      }

      i = Math.max(i + 1, glitchEnd + 1);
    }

    this.outputCursor = end;
    return output;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test signal generation
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generates 10 seconds of stereo 48kHz sine wave with injected glitches.
 * Returns interleaved stereo Float32Array.
 */
function generateTestSignal(
  sampleRate: number,
  durationSec: number,
  channels: number,
): { signal: Float32Array; mono: Float32Array; glitchPositions: number[] } {
  const totalFrames = sampleRate * durationSec;
  const mono = new Float32Array(totalFrames);
  const glitchPositions: number[] = [];

  // 440Hz sine at -6dBFS
  const amplitude = 0.5;
  const freq = 440;
  for (let i = 0; i < totalFrames; i++) {
    mono[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  }

  // Inject glitches: ~20 per second (typical for the Chrome issue)
  // Mix of types: single-sample spikes, short dropouts, phase jumps
  const rng = mulberry32(42); // deterministic seed
  const glitchesPerSecond = 20;
  const totalGlitches = glitchesPerSecond * durationSec;

  for (let g = 0; g < totalGlitches; g++) {
    const pos = Math.floor(rng() * (totalFrames - 100)) + 50;
    const type = Math.floor(rng() * 3);
    glitchPositions.push(pos);

    switch (type) {
      case 0: // Single-sample spike
        mono[pos] = (rng() > 0.5 ? 1 : -1) * (0.3 + rng() * 0.7);
        break;
      case 1: // Short dropout (2-8 samples zeroed)
        {
          const len = 2 + Math.floor(rng() * 7);
          for (let k = 0; k < len && pos + k < totalFrames; k++) {
            mono[pos + k] = 0;
          }
        }
        break;
      case 2: // Phase jump (sudden offset)
        {
          const offset = (rng() - 0.5) * 0.4;
          const len = 4 + Math.floor(rng() * 12);
          for (let k = 0; k < len && pos + k < totalFrames; k++) {
            mono[pos + k] += offset;
          }
        }
        break;
    }
  }

  // Interleave to stereo (same signal both channels for simplicity)
  const signal = new Float32Array(totalFrames * channels);
  for (let i = 0; i < totalFrames; i++) {
    for (let ch = 0; ch < channels; ch++) {
      signal[i * channels + ch] = mono[i]!;
    }
  }

  return { signal, mono, glitchPositions };
}

/** Simple deterministic PRNG (Mulberry32). */
function mulberry32(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark harness
// ─────────────────────────────────────────────────────────────────────────────

interface BenchResult {
  label: string;
  durationMs: number;
  samplesProcessed: number;
  samplesPerSec: number;
  glitchesFound: number;
  samplesRepaired: number;
  cpuPercent: number; // estimated CPU% for real-time 48kHz stereo
}

function formatResult(r: BenchResult): string {
  const lines = [
    `  ${r.label}`,
    `    Wall time:        ${r.durationMs.toFixed(2)} ms`,
    `    Samples processed: ${r.samplesProcessed.toLocaleString()}`,
    `    Throughput:        ${(r.samplesPerSec / 1e6).toFixed(2)} M samples/sec`,
    `    Glitches found:   ${r.glitchesFound}`,
    `    Samples repaired: ${r.samplesRepaired}`,
    `    Est. CPU% @ 48kHz stereo: ${r.cpuPercent.toFixed(1)}%`,
    `    Real-time capable: ${r.cpuPercent < 100 ? 'YES' : 'NO'} ${r.cpuPercent < 50 ? '(comfortable headroom)' : r.cpuPercent < 100 ? '(tight)' : '(TOO SLOW)'}`,
  ];
  return lines.join('\n');
}

function benchBatch(
  mono: Float32Array,
  passes: number,
  baseD2Threshold: number,
  maxRunLength: number,
  warmup: number,
  iterations: number,
): BenchResult {
  // Warmup
  for (let w = 0; w < warmup; w++) {
    let current = new Float32Array(mono);
    for (let p = 0; p < passes; p++) {
      const thr = p === 0 ? baseD2Threshold : baseD2Threshold * 0.6;
      const { corrected } = declickPass(current, thr, maxRunLength);
      current = corrected;
    }
  }

  // Timed iterations
  let totalGlitches = 0;
  let totalFixed = 0;
  const startTime = performance.now();

  for (let iter = 0; iter < iterations; iter++) {
    let current = new Float32Array(mono);
    let glitches = 0;
    let fixed = 0;
    for (let p = 0; p < passes; p++) {
      const thr = p === 0 ? baseD2Threshold : baseD2Threshold * 0.6;
      const { corrected, glitchCount, samplesFixed } = declickPass(current, thr, maxRunLength);
      current = corrected;
      glitches += glitchCount;
      fixed += samplesFixed;
    }
    totalGlitches = glitches;
    totalFixed = fixed;
  }

  const elapsed = performance.now() - startTime;
  const avgMs = elapsed / iterations;
  const samplesProcessed = mono.length * passes; // each pass processes all samples
  const samplesPerSec = (samplesProcessed / avgMs) * 1000;

  // CPU% estimate: at 48kHz stereo, we need to process 96000 samples/sec
  // The declicker runs per-channel, so for stereo it runs twice
  // Time budget per second of audio: 1000ms
  // Time actually used per second of audio:
  const audioSeconds = mono.length / 48000;
  const msPerAudioSecond = avgMs / audioSeconds;
  // For stereo: double it (runs on each channel independently)
  const stereoCpuPercent = ((msPerAudioSecond * 2) / 1000) * 100;

  return {
    label: `Batch mode (${passes} pass${passes > 1 ? 'es' : ''})`,
    durationMs: avgMs,
    samplesProcessed,
    samplesPerSec,
    glitchesFound: totalGlitches,
    samplesRepaired: totalFixed,
    cpuPercent: stereoCpuPercent,
  };
}

function benchStreamingNaive(
  mono: Float32Array,
  chunkSize: number,
  baseD2Threshold: number,
  maxRunLength: number,
  warmup: number,
  iterations: number,
): BenchResult {
  // Warmup
  for (let w = 0; w < warmup; w++) {
    const declicker = new StreamingDeclicker(baseD2Threshold, maxRunLength);
    for (let offset = 0; offset < mono.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, mono.length);
      declicker.process(mono.subarray(offset, end));
    }
    declicker.flush();
  }

  // Timed
  let totalGlitches = 0;
  let totalFixed = 0;
  const startTime = performance.now();

  for (let iter = 0; iter < iterations; iter++) {
    const declicker = new StreamingDeclicker(baseD2Threshold, maxRunLength);
    for (let offset = 0; offset < mono.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, mono.length);
      declicker.process(mono.subarray(offset, end));
    }
    declicker.flush();
    totalGlitches = declicker.glitchCount;
    totalFixed = declicker.samplesFixed;
  }

  const elapsed = performance.now() - startTime;
  const avgMs = elapsed / iterations;
  const samplesPerSec = (mono.length / avgMs) * 1000;

  const audioSeconds = mono.length / 48000;
  const msPerAudioSecond = avgMs / audioSeconds;
  const stereoCpuPercent = ((msPerAudioSecond * 2) / 1000) * 100;

  return {
    label: `Streaming NAIVE (chunk=${chunkSize}, per-sample RMS)`,
    durationMs: avgMs,
    samplesProcessed: mono.length,
    samplesPerSec,
    glitchesFound: totalGlitches,
    samplesRepaired: totalFixed,
    cpuPercent: stereoCpuPercent,
  };
}

function benchStreamingOptimized(
  mono: Float32Array,
  chunkSize: number,
  baseD2Threshold: number,
  maxRunLength: number,
  warmup: number,
  iterations: number,
): BenchResult {
  // Warmup
  for (let w = 0; w < warmup; w++) {
    const declicker = new OptimizedStreamingDeclicker(baseD2Threshold, maxRunLength);
    for (let offset = 0; offset < mono.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, mono.length);
      declicker.process(mono.subarray(offset, end));
    }
    declicker.flush();
  }

  // Timed
  let totalGlitches = 0;
  let totalFixed = 0;
  const startTime = performance.now();

  for (let iter = 0; iter < iterations; iter++) {
    const declicker = new OptimizedStreamingDeclicker(baseD2Threshold, maxRunLength);
    for (let offset = 0; offset < mono.length; offset += chunkSize) {
      const end = Math.min(offset + chunkSize, mono.length);
      declicker.process(mono.subarray(offset, end));
    }
    declicker.flush();
    totalGlitches = declicker.glitchCount;
    totalFixed = declicker.samplesFixed;
  }

  const elapsed = performance.now() - startTime;
  const avgMs = elapsed / iterations;
  const samplesPerSec = (mono.length / avgMs) * 1000;

  const audioSeconds = mono.length / 48000;
  const msPerAudioSecond = avgMs / audioSeconds;
  const stereoCpuPercent = ((msPerAudioSecond * 2) / 1000) * 100;

  return {
    label: `Streaming OPTIMIZED (chunk=${chunkSize}, cumSq batch-on-window)`,
    durationMs: avgMs,
    samplesProcessed: mono.length,
    samplesPerSec,
    glitchesFound: totalGlitches,
    samplesRepaired: totalFixed,
    cpuPercent: stereoCpuPercent,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 48000;
const DURATION_SEC = 10;
const CHANNELS = 2;
const BASE_D2_THRESHOLD = 0.004;
const MAX_RUN_LENGTH = 64;
const WARMUP = 2;
const ITERATIONS = 5;

console.log('='.repeat(72));
console.log('  Declicker Performance Benchmark');
console.log('  Target: Surface Go (2-core Intel Pentium 4415Y, 1.6GHz)');
console.log('  Audio: 48kHz stereo Float32');
console.log('  Minimum throughput: 96,000 samples/sec (real-time stereo)');
console.log('='.repeat(72));

console.log('\nGenerating test signal...');
const { mono, glitchPositions } = generateTestSignal(SAMPLE_RATE, DURATION_SEC, CHANNELS);
console.log(`  ${DURATION_SEC}s @ ${SAMPLE_RATE}Hz = ${mono.length.toLocaleString()} mono samples`);
console.log(
  `  ${glitchPositions.length} glitches injected (${glitchPositions.length / DURATION_SEC}/sec)`,
);
console.log(`  Stereo interleaved: ${(mono.length * CHANNELS).toLocaleString()} total samples`);

const results: BenchResult[] = [];

// ─── Batch benchmarks ───────────────────────────────────────────────────────

console.log('\n--- Batch Mode ---');

console.log('  Running batch 1-pass...');
results.push(benchBatch(mono, 1, BASE_D2_THRESHOLD, MAX_RUN_LENGTH, WARMUP, ITERATIONS));
console.log(formatResult(results[results.length - 1]!));

console.log('\n  Running batch 2-pass (current production approach)...');
results.push(benchBatch(mono, 2, BASE_D2_THRESHOLD, MAX_RUN_LENGTH, WARMUP, ITERATIONS));
console.log(formatResult(results[results.length - 1]!));

// ─── Streaming benchmarks ───────────────────────────────────────────────────

const chunkSizes = [128, 480];

for (const chunkSize of chunkSizes) {
  console.log(
    `\n--- Streaming Mode (chunk=${chunkSize} samples, ${((chunkSize / SAMPLE_RATE) * 1000).toFixed(2)}ms) ---`,
  );

  console.log('  Running streaming naive...');
  results.push(
    benchStreamingNaive(mono, chunkSize, BASE_D2_THRESHOLD, MAX_RUN_LENGTH, WARMUP, ITERATIONS),
  );
  console.log(formatResult(results[results.length - 1]!));

  console.log('\n  Running streaming optimized...');
  results.push(
    benchStreamingOptimized(mono, chunkSize, BASE_D2_THRESHOLD, MAX_RUN_LENGTH, WARMUP, ITERATIONS),
  );
  console.log(formatResult(results[results.length - 1]!));
}

// ─── Memory analysis ────────────────────────────────────────────────────────

console.log('\n' + '='.repeat(72));
console.log('  Memory Analysis');
console.log('='.repeat(72));

const monoSamples = SAMPLE_RATE * DURATION_SEC;
const batchMemory = {
  input: monoSamples * 4, // Float32Array input
  corrected: monoSamples * 4, // Float32Array output copy
  d2: monoSamples * 8, // Float64Array
  cumSq: (monoSamples + 1) * 8, // Float64Array
  localRms: monoSamples * 8, // Float64Array
};
const batchTotal = Object.values(batchMemory).reduce((a, b) => a + b, 0);

const streamCtx = 64 + 64 + 10 + 480; // contextSamples + chunk
const streamMemory = {
  buffer: streamCtx * 4, // Float32Array ring buffer
  d2: streamCtx * 8, // Float64Array per-window
  cumSq: (streamCtx + 1) * 8, // Float64Array per-window
};
const streamTotal = Object.values(streamMemory).reduce((a, b) => a + b, 0);

console.log(`\n  Batch mode (10s mono):`);
for (const [k, v] of Object.entries(batchMemory)) {
  console.log(`    ${k.padEnd(12)}: ${(v / 1024).toFixed(1)} KB`);
}
console.log(
  `    ${'TOTAL'.padEnd(12)}: ${(batchTotal / 1024).toFixed(1)} KB (${(batchTotal / 1024 / 1024).toFixed(2)} MB)`,
);

console.log(`\n  Streaming optimized (per chunk):`);
for (const [k, v] of Object.entries(streamMemory)) {
  console.log(`    ${k.padEnd(12)}: ${(v / 1024).toFixed(1)} KB`);
}
console.log(`    ${'TOTAL'.padEnd(12)}: ${(streamTotal / 1024).toFixed(1)} KB`);
console.log(`    Memory reduction: ${(batchTotal / streamTotal).toFixed(0)}x`);

// ─── Summary and recommendations ───────────────────────────────────────────

console.log('\n' + '='.repeat(72));
console.log('  Summary & Recommendations');
console.log('='.repeat(72));

console.log('\n  Throughput comparison:');
console.log('  ' + '-'.repeat(70));
console.log(`  ${'Mode'.padEnd(55)} | ${'M samp/s'.padStart(10)} | ${'CPU%'.padStart(5)}`);
console.log('  ' + '-'.repeat(70));
for (const r of results) {
  console.log(
    `  ${r.label.padEnd(55)} | ${(r.samplesPerSec / 1e6).toFixed(2).padStart(10)} | ${r.cpuPercent.toFixed(1).padStart(5)}%`,
  );
}
console.log('  ' + '-'.repeat(70));

const realTimeThreshold = 96000; // samples/sec for stereo 48kHz
console.log(
  `\n  Real-time threshold: ${(realTimeThreshold / 1000).toFixed(0)}K samples/sec (48kHz x 2ch)`,
);

console.log('\n  Bottleneck Analysis:');
console.log('  1. cumSq array: O(n) memory + full scan. In batch mode on 10s audio,');
console.log('     this is 480K entries x 8 bytes = 3.75 MB. Streaming eliminates this.');
console.log('  2. localRms per-sample computation: O(n) with cumSq, but O(n*w) naive.');
console.log('     The naive streaming version recomputes a 128-sample window per sample.');
console.log('  3. d2 array: O(n) full precompute. Streaming must compute on-the-fly.');
console.log('  4. 2-pass doubles total work. Consider single-pass with lower threshold.');
console.log('  5. Float64Array d2/cumSq/localRms: 2x memory vs Float32. d2 and localRms');
console.log('     could use Float32 with negligible precision loss.');

console.log('\n  Recommended streaming architecture:');
console.log('  - Use "chunked batch" (OptimizedStreamingDeclicker): run the batch');
console.log('    algorithm on overlapping windows of ~700 samples (context + chunk).');
console.log('  - Pre-compute cumSq and d2 over the small window (not full stream).');
console.log('  - 64-sample lookahead delay is acceptable (1.3ms at 48kHz).');
console.log('  - Single pass at a slightly lower threshold instead of 2-pass.');
console.log('  - Process both channels in the same Worker to share context arrays.');
console.log('  - Use AudioWorklet if latency matters, dedicated Worker if not.');
console.log('  - On Surface Go, target <30% CPU to leave headroom for the rest of');
console.log('    the extension (WebSocket, resampling, UI).');

// ─── Surface Go estimate ────────────────────────────────────────────────────

console.log('\n  Surface Go Performance Estimate:');
console.log('  Pentium 4415Y is ~2-3x slower than a modern i7 for single-thread JS.');
console.log('  Apply 2.5x slowdown factor to benchmark results:');
console.log('  ' + '-'.repeat(70));
for (const r of results) {
  const adjustedCpu = r.cpuPercent * 2.5;
  const viable = adjustedCpu < 100;
  console.log(
    `  ${r.label.padEnd(55)} | ${adjustedCpu.toFixed(1).padStart(6)}% | ${viable ? 'OK' : 'FAIL'}`,
  );
}
console.log('  ' + '-'.repeat(70));

console.log('\nBenchmark complete.');
