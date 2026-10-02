import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { AudioCodecSchema } from './audio.js';
import {
  createEncoderConfig,
  EncoderConfigSchema,
  getDefaultBitrate,
  getValidBitrates,
  hasEncoderImplementation,
  IMPLEMENTED_CODECS,
  isValidBitDepthForCodec,
  isValidBitrateForCodec,
  toWireEncoderConfig,
  WireEncoderConfigSchema,
} from './encoder.js';

describe('createEncoderConfig', () => {
  it('should fall back to the codec default bitrate when none is given', () => {
    expect(createEncoderConfig({ codec: 'aac-lc' }).bitrate).toBe(getDefaultBitrate('aac-lc'));
  });

  it('should keep a bitrate the codec supports', () => {
    expect(createEncoderConfig({ codec: 'aac-lc', bitrate: 256 }).bitrate).toBe(256);
  });

  it('should replace a bitrate the codec does not support with its default', () => {
    expect(createEncoderConfig({ codec: 'aac-lc', bitrate: 320 }).bitrate).toBe(
      getDefaultBitrate('aac-lc'),
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

describe('AAC', () => {
  it('should offer AAC-LC from 96 to 256 kbps', () => {
    expect(getValidBitrates('aac-lc')).toEqual([96, 128, 160, 192, 256]);
  });

  it('should no longer know the HE-AAC names', () => {
    // The browser encodes AAC-LC for every AAC profile, so both were AAC-LC
    // under another name. Core still accepts them from an older extension.
    expect(AudioCodecSchema.safeParse('he-aac').success).toBe(false);
    expect(AudioCodecSchema.safeParse('he-aac-v2').success).toBe(false);
  });
});

describe('IMPLEMENTED_CODECS', () => {
  it('should match the codec list the companion is tested against', () => {
    // fixtures/codecs.json is what a thaumic-core test resolves, name by name.
    // A codec added here must be added there, and core must then serve it.
    const fixture: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, '../fixtures/codecs.json'), 'utf8'),
    );

    expect(fixture).toEqual([...IMPLEMENTED_CODECS]);
  });

  it('should offer nothing the codec schema does not know', () => {
    for (const codec of IMPLEMENTED_CODECS) {
      expect(AudioCodecSchema.safeParse(codec).success).toBe(true);
    }
  });
});

describe('toWireEncoderConfig', () => {
  const config = createEncoderConfig({
    codec: 'pcm',
    latencyMode: 'realtime',
    jitterBufferMs: 300,
    frameDurationMs: 20,
    frameSizeSamples: 960,
  });

  it('should strip frameDurationMs and latencyMode and nothing else', () => {
    const wire = toWireEncoderConfig(config);

    expect(wire).not.toHaveProperty('frameDurationMs');
    expect(wire).not.toHaveProperty('latencyMode');
    expect<unknown>({ ...wire, frameDurationMs: 20, latencyMode: 'realtime' }).toEqual(config);
  });

  it('should keep the bitrate and the frame size the companion reads', () => {
    const wire = toWireEncoderConfig(
      createEncoderConfig({ codec: 'aac-lc', bitrate: 192, frameSizeSamples: 1024 }),
    );

    expect(wire.bitrate).toBe(192);
    expect(wire.frameSizeSamples).toBe(1024);
  });

  it('should leave the config it was given untouched', () => {
    toWireEncoderConfig(config);

    expect(config.frameDurationMs).toBe(20);
    expect(config.latencyMode).toBe('realtime');
  });

  it('should send the handshake the companion is tested against', () => {
    // fixtures/handshake.json is what a thaumic-core test parses. JSON drops
    // nothing here, so the fixture is the message byte for byte in meaning.
    const fixture: unknown = JSON.parse(
      readFileSync(join(import.meta.dir, '../fixtures/handshake.json'), 'utf8'),
    );
    const sent: unknown = JSON.parse(
      JSON.stringify({
        type: 'HANDSHAKE',
        payload: { encoderConfig: toWireEncoderConfig(config) },
      }),
    );

    expect(sent).toEqual(fixture);
  });
});

describe('WireEncoderConfigSchema', () => {
  it('should drop the two fields from a config that still carries them', () => {
    const parsed = WireEncoderConfigSchema.parse({
      codec: 'pcm',
      bitrate: 0,
      latencyMode: 'realtime',
      frameDurationMs: 20,
    });

    expect(parsed).not.toHaveProperty('latencyMode');
    expect(parsed).not.toHaveProperty('frameDurationMs');
  });

  it('should still refuse a bit depth the codec cannot carry', () => {
    const result = WireEncoderConfigSchema.safeParse({
      codec: 'aac-lc',
      bitrate: 192,
      bitsPerSample: 24,
    });

    expect(result.success).toBe(false);
  });
});
