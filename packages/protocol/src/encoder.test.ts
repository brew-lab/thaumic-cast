import { describe, expect, it } from 'bun:test';

import { AudioCodecSchema } from './audio.js';
import {
  createEncoderConfig,
  EncoderConfigSchema,
  getDefaultBitrate,
  getValidBitrates,
  hasEncoderImplementation,
  isValidBitDepthForCodec,
  isValidBitrateForCodec,
} from './encoder.js';

describe('createEncoderConfig', () => {
  it('should fall back to the codec default bitrate when none is given', () => {
    expect(createEncoderConfig({ codec: 'aac-lc' }).bitrate).toBe(getDefaultBitrate('aac-lc'));
  });

  it('should keep a bitrate the codec supports', () => {
    expect(createEncoderConfig({ codec: 'vorbis', bitrate: 320 }).bitrate).toBe(320);
  });

  it('should replace a bitrate the codec does not support with its default', () => {
    expect(createEncoderConfig({ codec: 'he-aac-v2', bitrate: 320 }).bitrate).toBe(
      getDefaultBitrate('he-aac-v2'),
    );
  });

  it('should resolve lossless codecs to bitrate 0', () => {
    expect(createEncoderConfig({ codec: 'flac', bitrate: 192 }).bitrate).toBe(0);
    expect(createEncoderConfig({ codec: 'pcm' }).bitrate).toBe(0);
  });

  it('should drop 24-bit to 16-bit for codecs that cannot encode it', () => {
    expect(createEncoderConfig({ codec: 'aac-lc', bitsPerSample: 24 }).bitsPerSample).toBe(16);
  });

  it('should keep 24-bit for FLAC', () => {
    expect(createEncoderConfig({ codec: 'flac', bitsPerSample: 24 }).bitsPerSample).toBe(24);
  });

  it('should apply the documented defaults for everything else', () => {
    expect(createEncoderConfig({ codec: 'pcm' })).toEqual({
      codec: 'pcm',
      bitrate: 0,
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 16,
      latencyMode: 'quality',
      jitterBufferMs: 200,
      frameDurationMs: 10,
      frameSizeSamples: undefined,
    });
  });
});

describe('EncoderConfigSchema', () => {
  const pcm = { codec: 'pcm', bitrate: 0 };

  it('should fill defaults for omitted optional fields', () => {
    expect(EncoderConfigSchema.parse(pcm)).toMatchObject({
      sampleRate: 48000,
      channels: 2,
      bitsPerSample: 16,
      latencyMode: 'quality',
      jitterBufferMs: 200,
    });
  });

  it('should reject a bit depth the codec does not support', () => {
    const aac24 = { codec: 'aac-lc', bitrate: 192, bitsPerSample: 24 };
    const flac24 = { codec: 'flac', bitrate: 0, bitsPerSample: 24 };

    expect(EncoderConfigSchema.safeParse(aac24).success).toBe(false);
    expect(EncoderConfigSchema.safeParse(flac24).success).toBe(true);
  });

  it('should keep the jitter buffer within its documented range', () => {
    expect(EncoderConfigSchema.safeParse({ ...pcm, jitterBufferMs: 50 }).success).toBe(false);
    expect(EncoderConfigSchema.safeParse({ ...pcm, jitterBufferMs: 1000 }).success).toBe(true);
    expect(EncoderConfigSchema.safeParse({ ...pcm, jitterBufferMs: 1001 }).success).toBe(false);
  });

  it('should keep the frame size within the bounds the server accepts', () => {
    expect(EncoderConfigSchema.safeParse({ ...pcm, frameSizeSamples: 63 }).success).toBe(false);
    expect(EncoderConfigSchema.safeParse({ ...pcm, frameSizeSamples: 480 }).success).toBe(true);
    expect(EncoderConfigSchema.safeParse({ ...pcm, frameSizeSamples: 480.5 }).success).toBe(false);
    expect(EncoderConfigSchema.safeParse({ ...pcm, frameSizeSamples: 8193 }).success).toBe(false);
  });

  it('should reject a bitrate outside the supported set', () => {
    expect(EncoderConfigSchema.safeParse({ codec: 'aac-lc', bitrate: 100 }).success).toBe(false);
  });
});

describe('codec metadata helpers', () => {
  it('should only allow 24-bit for FLAC', () => {
    for (const codec of AudioCodecSchema.options) {
      expect(isValidBitDepthForCodec(codec, 24)).toBe(codec === 'flac');
      expect(isValidBitDepthForCodec(codec, 16)).toBe(true);
    }
  });

  it('should treat the default bitrate of each codec as valid for it', () => {
    for (const codec of AudioCodecSchema.options) {
      const bitrate = getDefaultBitrate(codec);
      expect(isValidBitrateForCodec(codec, bitrate) || getValidBitrates(codec).length === 0).toBe(
        true,
      );
    }
  });

  it('should have an encoder implementation for every codec the schema allows', () => {
    for (const codec of AudioCodecSchema.options) {
      expect(hasEncoderImplementation(codec)).toBe(true);
    }
  });
});
