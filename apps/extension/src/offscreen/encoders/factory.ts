import type { EncoderConfig } from '@thaumic-cast/protocol';
import { createEncoderConfig } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import type { AudioEncoder, CodecSupportResult } from './types';
import { AacEncoder, isAacSupported } from './aac-encoder';
import { Mp3Encoder } from './mp3-encoder';
import { WavEncoder } from './wav-encoder';

const log = createLogger('EncoderFactory');

/**
 * Determines codec support and appropriate fallback.
 * @param config - The encoder configuration to check
 * @returns Support result with optional fallback codec
 */
export async function checkCodecSupport(config: EncoderConfig): Promise<CodecSupportResult> {
  const { codec } = config;

  if (codec === 'wav') {
    return { codec, supported: true };
  }

  if (codec === 'mp3') {
    return { codec, supported: true };
  }

  const supported = await isAacSupported(config);
  if (supported) {
    return { codec, supported: true };
  }

  log.warn(`${codec} not supported, will fall back to MP3`);
  return { codec, supported: false, fallback: 'mp3' };
}

/**
 * Creates the appropriate encoder for the given configuration.
 * Automatically falls back to MP3 if AAC is not supported.
 * @param config - The encoder configuration
 * @returns An initialized audio encoder
 */
export async function createEncoder(config: EncoderConfig): Promise<AudioEncoder> {
  const support = await checkCodecSupport(config);

  if (!support.supported && support.fallback) {
    log.info(`Using fallback codec: ${support.fallback}`);
    const fallbackConfig = createEncoderConfig(support.fallback, config.bitrate);
    return createEncoderForCodec(fallbackConfig);
  }

  return createEncoderForCodec(config);
}

/**
 * Creates an encoder for the specified codec without fallback logic.
 * @param config - The encoder configuration
 * @returns An initialized audio encoder
 */
async function createEncoderForCodec(config: EncoderConfig): Promise<AudioEncoder> {
  switch (config.codec) {
    case 'he-aac':
    case 'aac-lc':
      return new AacEncoder(config);
    case 'mp3':
      return Mp3Encoder.create(config);
    case 'wav':
      return new WavEncoder(config);
    default: {
      const exhaustiveCheck: never = config.codec;
      throw new Error(`Unknown codec: ${exhaustiveCheck}`);
    }
  }
}
