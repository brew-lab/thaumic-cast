import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  FRAME_DURATION_MS_DEFAULT,
  FRAME_DURATION_MS_MAX,
  FRAME_DURATION_MS_MIN,
  FRAME_DURATIONS,
  HEAD_START_MS_MAX,
  JITTER_BUFFER_MS_DEFAULT,
  JITTER_BUFFER_MS_MAX,
  JITTER_BUFFER_MS_MIN,
  PCM_SMOOTHING_DEFAULT_MS,
  PCM_SMOOTHING_OPTIONS,
  SUPPORTED_SAMPLE_RATES,
  clampSample,
  isSupportedSampleRate,
  tpdfDither,
} from './audio.js';

describe('SUPPORTED_SAMPLE_RATES', () => {
  it('should match the rate list the companion is tested against', () => {
    // fixtures/sample-rates.json is what a thaumic-core test compares with the
    // rates its handshake accepts. A rate added here must be added there, and
    // core must then serve it.
    const fixture: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, '../fixtures/sample-rates.json'), 'utf8'),
    );

    expect(fixture).toEqual([...SUPPORTED_SAMPLE_RATES]);
  });
});

describe('cast limits', () => {
  it('should match the limits the companion is tested against', () => {
    // fixtures/cast-limits.json is what a thaumic-core test compares with the
    // limits its handshake and settings enforce. A limit changed here must be
    // changed there, and core must then enforce it.
    const fixture: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, '../fixtures/cast-limits.json'), 'utf8'),
    );

    expect(fixture).toEqual({
      smoothingMs: {
        min: JITTER_BUFFER_MS_MIN,
        max: JITTER_BUFFER_MS_MAX,
        default: JITTER_BUFFER_MS_DEFAULT,
      },
      frameDurationMs: {
        min: FRAME_DURATION_MS_MIN,
        max: FRAME_DURATION_MS_MAX,
        default: FRAME_DURATION_MS_DEFAULT,
      },
      headStartMs: { max: HEAD_START_MS_MAX },
    });
  });

  it('should offer only smoothing steps and frame durations inside those limits', () => {
    expect(PCM_SMOOTHING_DEFAULT_MS).toBe(JITTER_BUFFER_MS_DEFAULT);
    for (const step of PCM_SMOOTHING_OPTIONS) {
      expect(step).toBeGreaterThanOrEqual(JITTER_BUFFER_MS_MIN);
      expect(step).toBeLessThanOrEqual(JITTER_BUFFER_MS_MAX);
    }
    for (const duration of FRAME_DURATIONS) {
      expect(duration).toBeGreaterThanOrEqual(FRAME_DURATION_MS_MIN);
      expect(duration).toBeLessThanOrEqual(FRAME_DURATION_MS_MAX);
    }
  });
});

describe('isSupportedSampleRate', () => {
  it('should accept both the 48kHz and 44.1kHz families', () => {
    expect(isSupportedSampleRate(48000)).toBe(true);
    expect(isSupportedSampleRate(44100)).toBe(true);
    expect(isSupportedSampleRate(8000)).toBe(true);
  });

  it('should reject rates Sonos cannot play', () => {
    expect(isSupportedSampleRate(96000)).toBe(false);
    expect(isSupportedSampleRate(0)).toBe(false);
  });
});

describe('clampSample', () => {
  it('should keep in-range samples untouched', () => {
    expect(clampSample(0.5)).toBe(0.5);
    expect(clampSample(-1)).toBe(-1);
  });

  it('should clamp over-range samples to the unit interval', () => {
    expect(clampSample(2)).toBe(1);
    expect(clampSample(-3)).toBe(-1);
  });
});

describe('tpdfDither', () => {
  it('should stay within [-1, 1] and vary across a full table cycle', () => {
    const values = Array.from({ length: 4096 }, () => tpdfDither());

    expect(Math.max(...values)).toBeLessThanOrEqual(1);
    expect(Math.min(...values)).toBeGreaterThanOrEqual(-1);
    expect(new Set(values).size).toBeGreaterThan(1);
  });
});
