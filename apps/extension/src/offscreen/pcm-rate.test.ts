import { describe, expect, it } from 'bun:test';
import { SUPPORTED_SAMPLE_RATES } from '@thaumic-cast/protocol';

import { KeyedError, errorParamsOf } from '../lib/keyed-error';
import en from '../locales/en.json';
import {
  PCM_FALLBACK_SAMPLE_RATE,
  pcmFrameSizeInterleaved,
  resolvePcmDeclaredRate,
} from './pcm-rate';

/**
 * Runs the resolver and returns what it threw.
 * @param rate - The captured rate to resolve
 * @returns The thrown value, or undefined when nothing was thrown
 */
function thrownBy(rate: number): unknown {
  try {
    resolvePcmDeclaredRate(rate);
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('resolvePcmDeclaredRate', () => {
  it('should declare the captured rate when it is a supported one', () => {
    for (const rate of SUPPORTED_SAMPLE_RATES) {
      expect(resolvePcmDeclaredRate(rate)).toBe(rate);
    }
  });

  it('should declare 44100 for a 44.1 kHz capture, never a rate left in the settings', () => {
    // The resolver is not given the stored rate at all: the capture decides.
    expect(resolvePcmDeclaredRate(44100)).toBe(44100);
  });

  it('should declare 48000 when the capture states no rate', () => {
    expect(PCM_FALLBACK_SAMPLE_RATE).toBe(48000);
    expect(resolvePcmDeclaredRate(undefined)).toBe(48000);
    expect(resolvePcmDeclaredRate(null)).toBe(48000);
    expect(resolvePcmDeclaredRate(0)).toBe(48000);
  });

  it('should refuse an unsupported rate with the key and the rate', () => {
    for (const rate of [96000, 88200, 192000, 12345]) {
      const err = thrownBy(rate);
      expect(err).toBeInstanceOf(KeyedError);
      expect((err as KeyedError).message).toBe('error_pcm_rate_unsupported');
      expect(errorParamsOf(err)).toEqual({ rate });
    }
  });
});

describe('error_pcm_rate_unsupported', () => {
  it('should print the rate the resolver passes, with a space before the unit', () => {
    const line = (en as Record<string, string>).error_pcm_rate_unsupported;
    expect(line).toContain('{{rate}} Hz');
    // The only placeholder the call site fills is the rate.
    expect(line.match(/{{\w+}}/g)).toEqual(['{{rate}}']);
  });
});

describe('pcmFrameSizeInterleaved', () => {
  it('should size a frame from the declared rate', () => {
    expect(pcmFrameSizeInterleaved(48000, 20, 2)).toBe(1920);
    expect(pcmFrameSizeInterleaved(44100, 20, 2)).toBe(1764);
    expect(pcmFrameSizeInterleaved(48000, 10, 1)).toBe(480);
  });

  it('should keep whole frames per channel when the duration does not divide evenly', () => {
    // 11025 Hz for 10 ms is 110.25 samples: round per channel, then interleave.
    expect(pcmFrameSizeInterleaved(11025, 10, 2)).toBe(220);
  });
});
