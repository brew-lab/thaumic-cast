/**
 * Music Safety Test for Declicker Algorithm
 *
 * Generates synthetic test signals that represent musical features,
 * runs the declicker on each, and reports false positive rates.
 *
 * Usage: bun run tools/test-music-safety.ts
 */

// ─────────────────────────────────────────────────────────────────────────────
// Declicker (extracted from envelope-smooth.ts)
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

  const d2 = new Float64Array(n);
  for (let i = 2; i < n; i++) {
    d2[i] = Math.abs(mono[i]! - 2 * mono[i - 1]! + mono[i - 2]!);
  }

  const rmsHalf = 64;
  const localRms = new Float64Array(n);
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

function declickChannel(
  mono: Float32Array,
  baseD2Threshold: number,
  maxRunLength: number,
  passes: number,
): { corrected: Float32Array; glitchCount: number; samplesFixed: number } {
  let current = new Float32Array(mono);
  let totalGlitchCount = 0;
  let totalSamplesFixed = 0;

  for (let pass = 0; pass < passes; pass++) {
    const thresholdMult = pass === 0 ? 1.0 : 0.6;
    const { corrected, glitchCount, samplesFixed } = declickPass(
      current,
      baseD2Threshold * thresholdMult,
      maxRunLength,
    );
    current = corrected;
    totalGlitchCount += glitchCount;
    totalSamplesFixed += samplesFixed;
  }

  return { corrected: current, glitchCount: totalGlitchCount, samplesFixed: totalSamplesFixed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Signal Generators
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_RATE = 48000;
const DURATION = 2.0; // seconds
const N = Math.floor(SAMPLE_RATE * DURATION);

/** Single-sample impulse (click) at multiple positions */
function generateImpulses(): { name: string; signal: Float32Array; description: string } {
  const signal = new Float32Array(N);
  // Place impulses at various positions with varying amplitudes
  const positions = [4800, 9600, 14400, 24000, 48000, 72000];
  const amplitudes = [0.9, 0.7, 0.5, 0.8, 0.6, 1.0];
  for (let k = 0; k < positions.length; k++) {
    if (positions[k]! < N) {
      signal[positions[k]!] = amplitudes[k]!;
    }
  }
  return {
    name: 'Impulses (clicks)',
    signal,
    description: '6 single-sample impulses at various amplitudes — models real clicks/pops',
  };
}

/** Short burst simulating a snare hit: exponentially decaying noise */
function generateSnareBurst(): { name: string; signal: Float32Array; description: string } {
  const signal = new Float32Array(N);
  const burstPositions = [4800, 24000, 48000, 72000];

  for (const pos of burstPositions) {
    if (pos >= N) continue;
    const decayLen = 2400; // 50ms
    for (let i = 0; i < decayLen && pos + i < N; i++) {
      const env = Math.exp(-i / 400) * 0.8;
      signal[pos + i] += env * (Math.random() * 2 - 1);
    }
  }
  return {
    name: 'Snare bursts',
    signal,
    description: '4 exponentially decaying noise bursts (50ms each) — models snare/percussion',
  };
}

/** Frequency sweep (chirp) from 100Hz to 15kHz */
function generateChirp(): { name: string; signal: Float32Array; description: string } {
  const signal = new Float32Array(N);
  const f0 = 100;
  const f1 = 15000;
  for (let i = 0; i < N; i++) {
    const t = i / SAMPLE_RATE;
    const freq = f0 + (f1 - f0) * (t / DURATION);
    signal[i] = 0.7 * Math.sin(2 * Math.PI * freq * t);
  }
  return {
    name: 'Frequency chirp (100Hz-15kHz)',
    signal,
    description: 'Linear frequency sweep — tests |d2| scaling with frequency',
  };
}

/** Amplitude step: sudden volume change */
function generateAmplitudeStep(): { name: string; signal: Float32Array; description: string } {
  const signal = new Float32Array(N);
  const freq = 440;
  for (let i = 0; i < N; i++) {
    const t = i / SAMPLE_RATE;
    // Step from 0.3 to 0.9 at midpoint
    const amp = i < N / 2 ? 0.3 : 0.9;
    signal[i] = amp * Math.sin(2 * Math.PI * freq * t);
  }
  return {
    name: 'Amplitude step (0.3 -> 0.9)',
    signal,
    description: '440Hz tone with sudden amplitude tripling at midpoint — models volume automation',
  };
}

/** White noise burst embedded in sine wave */
function generateNoiseBurst(): { name: string; signal: Float32Array; description: string } {
  const signal = new Float32Array(N);
  const freq = 440;
  for (let i = 0; i < N; i++) {
    const t = i / SAMPLE_RATE;
    signal[i] = 0.5 * Math.sin(2 * Math.PI * freq * t);
  }
  // Insert noise bursts
  const burstLen = 960; // 20ms
  const burstPositions = [12000, 48000, 72000];
  for (const pos of burstPositions) {
    for (let i = 0; i < burstLen && pos + i < N; i++) {
      signal[pos + i] = 0.6 * (Math.random() * 2 - 1);
    }
  }
  return {
    name: 'Noise bursts in sine',
    signal,
    description:
      '440Hz sine with 3 white noise bursts (20ms each) — models cymbal crashes over tone',
  };
}

/** Sum of 5 sine waves at different frequencies (polyphonic) */
function generatePolyphonic(): { name: string; signal: Float32Array; description: string } {
  const signal = new Float32Array(N);
  const freqs = [261.63, 329.63, 392.0, 523.25, 783.99]; // C4 E4 G4 C5 G5
  const amps = [0.3, 0.25, 0.2, 0.15, 0.1];
  for (let i = 0; i < N; i++) {
    const t = i / SAMPLE_RATE;
    for (let f = 0; f < freqs.length; f++) {
      signal[i] += amps[f]! * Math.sin(2 * Math.PI * freqs[f]! * t);
    }
  }
  return {
    name: 'Polyphonic (5 sines)',
    signal,
    description: 'C major chord (C4-G5) — tests natural curvature from multiple simultaneous tones',
  };
}

/** Simulated hi-hat: high-frequency filtered noise */
function generateHiHat(): { name: string; signal: Float32Array; description: string } {
  const signal = new Float32Array(N);
  // Generate at 16 regularly-spaced positions (8th notes at 120bpm)
  const interval = Math.floor(SAMPLE_RATE * 0.25); // 250ms apart
  for (let beat = 0; beat < 8; beat++) {
    const pos = beat * interval;
    const decayLen = Math.floor(SAMPLE_RATE * 0.05); // 50ms
    for (let i = 0; i < decayLen && pos + i < N; i++) {
      const env = Math.exp(-i / (SAMPLE_RATE * 0.01)) * 0.5;
      // Crude high-pass: use difference of successive random samples
      const noise = Math.random() * 2 - 1;
      signal[pos + i] += env * noise;
    }
  }
  return {
    name: 'Hi-hat pattern',
    signal,
    description: '8 hi-hat hits (50ms decaying noise bursts) — tests dense HF transients',
  };
}

/** Fast attack piano-like: sine with instant onset */
function generatePianoAttack(): { name: string; signal: Float32Array; description: string } {
  const signal = new Float32Array(N);
  const notePositions = [2400, 24000, 48000, 72000];
  const freqs = [261.63, 440, 523.25, 659.25]; // C4, A4, C5, E5

  for (let n = 0; n < notePositions.length; n++) {
    const pos = notePositions[n]!;
    const freq = freqs[n]!;
    const noteLen = 12000; // 250ms
    for (let i = 0; i < noteLen && pos + i < N; i++) {
      const t = i / SAMPLE_RATE;
      // Fast attack (1ms), slow decay
      const attackSamples = 48; // 1ms
      const env =
        i < attackSamples ? (i / attackSamples) * 0.8 : 0.8 * Math.exp(-i / (SAMPLE_RATE * 0.2));
      // Add harmonics for realism
      signal[pos + i] +=
        env *
        (0.6 * Math.sin(2 * Math.PI * freq * t) +
          0.25 * Math.sin(2 * Math.PI * freq * 2 * t) +
          0.1 * Math.sin(2 * Math.PI * freq * 3 * t) +
          0.05 * Math.sin(2 * Math.PI * freq * 4 * t));
    }
  }
  return {
    name: 'Piano attacks',
    signal,
    description: '4 piano-like notes with 1ms attack, harmonics, and exponential decay',
  };
}

/** Distorted guitar: hard-clipped sine with harmonics */
function generateDistortedGuitar(): { name: string; signal: Float32Array; description: string } {
  const signal = new Float32Array(N);
  const freq = 82.41; // E2, low power chord
  for (let i = 0; i < N; i++) {
    const t = i / SAMPLE_RATE;
    let val = 0;
    // Fundamental + harmonics
    val += 1.0 * Math.sin(2 * Math.PI * freq * t);
    val += 0.7 * Math.sin(2 * Math.PI * freq * 2 * t);
    val += 0.5 * Math.sin(2 * Math.PI * freq * 3 * t);
    val += 0.3 * Math.sin(2 * Math.PI * freq * 5 * t);
    // Hard clip for distortion
    val = Math.max(-0.6, Math.min(0.6, val * 0.8));
    signal[i] = val;
  }
  return {
    name: 'Distorted guitar (clipped)',
    signal,
    description:
      'E2 power chord with hard clipping — creates sharp transitions and dense harmonics',
  };
}

/** Quantum glitch: the actual defect the algorithm should catch */
function generateQuantumGlitch(): { name: string; signal: Float32Array; description: string } {
  const signal = new Float32Array(N);
  const freq = 440;
  for (let i = 0; i < N; i++) {
    const t = i / SAMPLE_RATE;
    signal[i] = 0.7 * Math.sin(2 * Math.PI * freq * t);
  }
  // Insert quantum glitches: sudden zero-crossing or value discontinuities
  const glitchPositions = [12800, 25600, 38400, 51200, 64000];
  for (const pos of glitchPositions) {
    if (pos + 4 >= N) continue;
    // Abrupt jump to wrong value for a few samples
    signal[pos] = -signal[pos]!; // phase flip
    signal[pos + 1] = 0;
    signal[pos + 2] = -signal[pos + 2]!;
  }
  return {
    name: 'Quantum glitches (target defect)',
    signal,
    description: '440Hz sine with 5 quantum glitches (3-sample phase flips) — the actual defect',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Analysis
// ─────────────────────────────────────────────────────────────────────────────

interface TestResult {
  name: string;
  description: string;
  totalSamples: number;
  glitchCount: number;
  samplesFixed: number;
  falsePositiveRate: number;
  maxD2: number;
  meanD2: number;
  p99D2: number;
  verdict: string;
}

function computeD2Stats(signal: Float32Array): { maxD2: number; meanD2: number; p99D2: number } {
  const d2Values: number[] = [];
  for (let i = 2; i < signal.length; i++) {
    d2Values.push(Math.abs(signal[i]! - 2 * signal[i - 1]! + signal[i - 2]!));
  }
  d2Values.sort((a, b) => a - b);
  const sum = d2Values.reduce((a, b) => a + b, 0);
  return {
    maxD2: d2Values[d2Values.length - 1]!,
    meanD2: sum / d2Values.length,
    p99D2: d2Values[Math.floor(d2Values.length * 0.99)]!,
  };
}

function runTest(
  gen: { name: string; signal: Float32Array; description: string },
  isTargetDefect: boolean,
): TestResult {
  const { corrected, glitchCount, samplesFixed } = declickChannel(
    gen.signal,
    0.004, // baseD2Threshold
    64, // maxRunLength
    2, // passes
  );

  const d2Stats = computeD2Stats(gen.signal);

  // For non-defect signals, any modification is a false positive
  const falsePositiveRate = isTargetDefect ? 0 : samplesFixed / gen.signal.length;

  let verdict: string;
  if (isTargetDefect) {
    verdict = glitchCount > 0 ? 'PASS (detected target defect)' : 'FAIL (missed target defect)';
  } else {
    if (samplesFixed === 0) {
      verdict = 'SAFE (no false positives)';
    } else if (falsePositiveRate < 0.001) {
      verdict = 'MARGINAL (< 0.1% modified)';
    } else {
      verdict = 'UNSAFE (significant false positives)';
    }
  }

  // Compute max sample-level deviation for context
  let maxDeviation = 0;
  for (let i = 0; i < gen.signal.length; i++) {
    const dev = Math.abs(corrected[i]! - gen.signal[i]!);
    if (dev > maxDeviation) maxDeviation = dev;
  }

  return {
    name: gen.name,
    description: gen.description,
    totalSamples: gen.signal.length,
    glitchCount,
    samplesFixed,
    falsePositiveRate,
    maxD2: d2Stats.maxD2,
    meanD2: d2Stats.meanD2,
    p99D2: d2Stats.p99D2,
    verdict,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

console.log('=== Declicker Music Safety Test ===');
console.log(`Sample rate: ${SAMPLE_RATE}Hz, Duration: ${DURATION}s, Samples: ${N}`);
console.log(`Algorithm params: baseD2Threshold=0.004, maxRunLength=64, passes=2 (pass 2 at 60%)\n`);

const generators = [
  { gen: generateImpulses(), isTarget: false },
  { gen: generateSnareBurst(), isTarget: false },
  { gen: generateChirp(), isTarget: false },
  { gen: generateAmplitudeStep(), isTarget: false },
  { gen: generateNoiseBurst(), isTarget: false },
  { gen: generatePolyphonic(), isTarget: false },
  { gen: generateHiHat(), isTarget: false },
  { gen: generatePianoAttack(), isTarget: false },
  { gen: generateDistortedGuitar(), isTarget: false },
  { gen: generateQuantumGlitch(), isTarget: true },
];

const results: TestResult[] = [];

for (const { gen, isTarget } of generators) {
  const result = runTest(gen, isTarget);
  results.push(result);
}

// ─── Print Results Table ─────────────────────────────────────────────────────

console.log('--- |d2| Statistics per Signal ---\n');
console.log(
  'Signal'.padEnd(35) +
    'Mean |d2|'.padStart(12) +
    'P99 |d2|'.padStart(12) +
    'Max |d2|'.padStart(12),
);
console.log('-'.repeat(71));
for (const r of results) {
  console.log(
    r.name.padEnd(35) +
      r.meanD2.toExponential(3).padStart(12) +
      r.p99D2.toExponential(3).padStart(12) +
      r.maxD2.toExponential(3).padStart(12),
  );
}

console.log('\n--- False Positive Report ---\n');
console.log(
  'Signal'.padEnd(35) +
    'Glitches'.padStart(10) +
    'Samples Fixed'.padStart(15) +
    'FP Rate'.padStart(10) +
    '  Verdict',
);
console.log('-'.repeat(90));
for (const r of results) {
  const fpStr = r.falsePositiveRate > 0 ? (r.falsePositiveRate * 100).toFixed(4) + '%' : '0%';
  console.log(
    r.name.padEnd(35) +
      String(r.glitchCount).padStart(10) +
      String(r.samplesFixed).padStart(15) +
      fpStr.padStart(10) +
      '  ' +
      r.verdict,
  );
}

// ─── Detailed Analysis ───────────────────────────────────────────────────────

console.log('\n--- Detailed Analysis ---\n');

// Compute what the adaptive threshold would be for each signal at peak
for (const { gen } of generators) {
  // Find local RMS at the loudest point
  const signal = gen.signal;
  let maxRms = 0;
  const windowSize = 128;
  for (let start = 0; start + windowSize < signal.length; start += windowSize) {
    let sumSq = 0;
    for (let i = 0; i < windowSize; i++) {
      sumSq += signal[start + i]! * signal[start + i]!;
    }
    const rms = Math.sqrt(sumSq / windowSize);
    if (rms > maxRms) maxRms = rms;
  }
  const adaptiveThreshold = Math.max(0.004, maxRms * 0.008);
  const d2Stats = computeD2Stats(signal);
  const ratio = d2Stats.maxD2 / adaptiveThreshold;

  console.log(`${gen.name}:`);
  console.log(`  Peak local RMS: ${maxRms.toFixed(4)}`);
  console.log(`  Adaptive threshold at peak: ${adaptiveThreshold.toExponential(3)}`);
  console.log(`  Max |d2| / threshold ratio: ${ratio.toFixed(1)}x`);
  console.log(`  P99 |d2| / threshold ratio: ${(d2Stats.p99D2 / adaptiveThreshold).toFixed(1)}x`);
  console.log('');
}

// ─── Summary ─────────────────────────────────────────────────────────────────

const unsafeCount = results.filter((r) => r.verdict.startsWith('UNSAFE')).length;
const marginalCount = results.filter((r) => r.verdict.startsWith('MARGINAL')).length;
const safeCount = results.filter((r) => r.verdict.startsWith('SAFE')).length;
const targetDetected = results.filter((r) => r.verdict.includes('detected')).length;

console.log('=== SUMMARY ===');
console.log(`  SAFE:     ${safeCount}/9 music signals`);
console.log(`  MARGINAL: ${marginalCount}/9 music signals`);
console.log(`  UNSAFE:   ${unsafeCount}/9 music signals`);
console.log(`  Target defect detected: ${targetDetected}/1`);

if (unsafeCount > 0) {
  console.log('\n  WARNING: Algorithm has significant false positives on music signals!');
} else if (marginalCount > 0) {
  console.log('\n  CAUTION: Algorithm has minor false positives on some music signals.');
} else {
  console.log('\n  Algorithm appears safe for music signals with current parameters.');
}
