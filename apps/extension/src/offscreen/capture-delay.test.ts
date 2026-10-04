import { describe, expect, it } from 'bun:test';
import { captureDelayMs } from './capture-delay';

const STEREO_48K = { sampleRate: 48000, channels: 2 };

describe('captureDelayMs', () => {
  it('should be zero with nothing held', () => {
    expect(captureDelayMs(0, 0, 0, STEREO_48K)).toBe(0);
  });

  it('should count queued and unsent bytes as 16-bit interleaved audio', () => {
    // 10 ms of 48 kHz stereo is 960 samples, 1920 bytes.
    expect(captureDelayMs(1920, 0, 0, STEREO_48K)).toBe(10);
    expect(captureDelayMs(0, 0, 1920, STEREO_48K)).toBe(10);
    expect(captureDelayMs(1920, 0, 3840, STEREO_48K)).toBe(30);
  });

  it('should count accumulator samples as interleaved samples', () => {
    expect(captureDelayMs(0, 960, 0, STEREO_48K)).toBe(10);
    expect(captureDelayMs(0, 480, 0, { sampleRate: 48000, channels: 1 })).toBe(10);
  });

  it('should add all three', () => {
    expect(captureDelayMs(1920, 960, 1920, STEREO_48K)).toBe(30);
  });

  it('should read 44.1 kHz at its own rate', () => {
    // 20 ms of 44.1 kHz stereo is 1764 samples.
    expect(captureDelayMs(1764 * 2, 0, 0, { sampleRate: 44100, channels: 2 })).toBe(20);
  });

  it('should give zero for an unknown format and ignore negative counters', () => {
    expect(captureDelayMs(1920, 0, 0, { sampleRate: 0, channels: 2 })).toBe(0);
    expect(captureDelayMs(1920, 0, 0, { sampleRate: 48000, channels: 0 })).toBe(0);
    expect(captureDelayMs(-5, -5, 1920, STEREO_48K)).toBe(10);
  });
});
