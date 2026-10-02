import { describe, expect, it } from 'bun:test';
import { SUPPORTED_SAMPLE_RATES } from '@thaumic-cast/protocol';

import { KeyedError, errorParamsOf } from '../lib/keyed-error';
import en from '../locales/en.json';
import {
  PCM_FALLBACK_SAMPLE_RATE,
  PCM_FIRST_FRAME_WAIT_MS,
  pcmFrameSizeInterleaved,
  pcmRateMismatch,
  readFirstWithin,
  resolvePcmDeclaredRate,
  resolvePcmSilentStartRate,
  type ReadOutcome,
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

describe('resolvePcmSilentStartRate', () => {
  it('should declare the rate the track reports when it is a supported one', () => {
    for (const rate of SUPPORTED_SAMPLE_RATES) {
      expect(resolvePcmSilentStartRate(rate)).toBe(rate);
    }
  });

  it('should declare 48000 when the track reports no rate', () => {
    expect(resolvePcmSilentStartRate(undefined)).toBe(48000);
    expect(resolvePcmSilentStartRate(null)).toBe(48000);
    expect(resolvePcmSilentStartRate(0)).toBe(48000);
  });

  it('should declare 48000, without refusing, when the track reports an unsupported rate', () => {
    // The report is not the capture: the first real frame decides whether the cast can go on.
    for (const rate of [96000, 88200, 192000, 12345]) {
      expect(resolvePcmSilentStartRate(rate)).toBe(48000);
    }
  });
});

describe('pcmRateMismatch', () => {
  it('should let the cast carry on when the frame is at the declared rate', () => {
    expect(pcmRateMismatch(48000, 48000)).toBeNull();
    expect(pcmRateMismatch(44100, 44100)).toBeNull();
  });

  it('should let the cast carry on when the frame states no rate', () => {
    expect(pcmRateMismatch(0, 48000)).toBeNull();
    expect(pcmRateMismatch(undefined, 48000)).toBeNull();
  });

  it('should stop a cast declared from a silent tab when the audio arrives at another rate', () => {
    expect(pcmRateMismatch(44100, 48000)).toEqual({
      reason: 'pcm_rate_changed',
      params: { rate: 44100, declared: 48000 },
    });
  });

  it('should name the rate as unsupported when no PCM cast could declare it', () => {
    expect(pcmRateMismatch(96000, 48000)).toEqual({
      reason: 'pcm_rate_unsupported',
      params: { rate: 96000, declared: 48000 },
    });
  });

  it('should fill every placeholder of the message each reason shows, and no others', () => {
    const strings = en as Record<string, string>;
    for (const frameRate of [44100, 96000]) {
      const mismatch = pcmRateMismatch(frameRate, 48000)!;
      const line = strings[`auto_stop_${mismatch.reason}`];
      const placeholders = (line.match(/{{(\w+)}}/g) ?? []).map((p) => p.slice(2, -2));
      expect(placeholders.length).toBeGreaterThan(0);
      for (const name of placeholders) {
        expect(mismatch.params[name]).toBeDefined();
      }
      expect(line).toContain('{{rate}} Hz');
    }
  });
});

/** A read result carrying a chunk. */
type Chunk = ReadOutcome<string>;

/**
 * Builds a reader whose single read settles as the test directs.
 * @returns The reader, how many reads were started, and the controls to settle the read
 */
function fakeReader(): {
  reader: { read: () => Promise<Chunk> };
  reads: () => number;
  resolve: (result: Chunk) => void;
  reject: (reason: unknown) => void;
} {
  let count = 0;
  let resolve!: (result: Chunk) => void;
  let reject!: (reason: unknown) => void;
  const pending = new Promise<Chunk>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return {
    reader: {
      read: () => {
        count++;
        return pending;
      },
    },
    reads: () => count,
    resolve,
    reject,
  };
}

describe('readFirstWithin', () => {
  const LIMIT_MS = 20;

  it('should wait well inside the 15 s the session allows itself to initialise', () => {
    expect(PCM_FIRST_FRAME_WAIT_MS).toBeGreaterThanOrEqual(100);
    expect(PCM_FIRST_FRAME_WAIT_MS).toBeLessThanOrEqual(500);
  });

  it('should return the chunk when the read settles at once', async () => {
    const fake = fakeReader();
    fake.resolve({ done: false, value: 'first' });
    const first = await readFirstWithin(fake.reader, LIMIT_MS);
    expect(first.settled).toEqual({ done: false, value: 'first' });
    expect(fake.reads()).toBe(1);
  });

  it('should return the chunk when the read settles inside the limit', async () => {
    const fake = fakeReader();
    setTimeout(() => fake.resolve({ done: false, value: 'first' }), 5);
    const first = await readFirstWithin(fake.reader, 200);
    expect(first.settled).toEqual({ done: false, value: 'first' });
    expect(fake.reads()).toBe(1);
  });

  it('should hand back the same read, still outstanding, when the limit passes first', async () => {
    const fake = fakeReader();
    const started = performance.now();
    const first = await readFirstWithin(fake.reader, LIMIT_MS);
    expect(performance.now() - started).toBeGreaterThanOrEqual(LIMIT_MS - 2);
    expect(first.settled).toBeNull();
    expect(fake.reads()).toBe(1);

    // The frame that arrives late comes out of the read already started: not lost, not doubled.
    fake.resolve({ done: false, value: 'late' });
    expect(await first.read).toEqual({ done: false, value: 'late' });
    expect(fake.reads()).toBe(1);
  });

  it('should give up after the limit when the read never settles', async () => {
    const fake = fakeReader();
    const first = await readFirstWithin(fake.reader, LIMIT_MS);
    expect(first.settled).toBeNull();
    expect(fake.reads()).toBe(1);
  });

  it('should report the end of the stream when the read is done inside the limit', async () => {
    const fake = fakeReader();
    fake.resolve({ done: true, value: undefined });
    const first = await readFirstWithin(fake.reader, LIMIT_MS);
    expect(first.settled).toEqual({ done: true, value: undefined });
  });

  it('should report a cancel that lands while waiting, as a stop does', async () => {
    const fake = fakeReader();
    setTimeout(() => fake.resolve({ done: true, value: undefined }), 5);
    const first = await readFirstWithin(fake.reader, 200);
    expect(first.settled?.done).toBe(true);
  });

  it('should reject when the read fails inside the limit', async () => {
    const fake = fakeReader();
    fake.reject(new Error('capture failed'));
    expect(readFirstWithin(fake.reader, LIMIT_MS)).rejects.toThrow('capture failed');
  });

  it('should leave a failure after the limit to whoever awaits the read', async () => {
    const fake = fakeReader();
    const first = await readFirstWithin(fake.reader, LIMIT_MS);
    fake.reject(new Error('capture failed late'));
    expect(first.read).rejects.toThrow('capture failed late');
  });
});
