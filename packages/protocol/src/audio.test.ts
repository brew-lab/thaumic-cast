import { describe, expect, it } from 'bun:test';

import { clampSample, isSupportedSampleRate, tpdfDither } from './audio.js';

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
