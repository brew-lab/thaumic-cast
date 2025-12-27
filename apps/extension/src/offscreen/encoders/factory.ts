import type { EncoderConfig } from '@thaumic-cast/protocol';
import { isCodecSupported, hasEncoderImplementation } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import type { AudioEncoder } from './types';
import { AacEncoder } from './aac-encoder';
import { FlacEncoder } from './flac-encoder';
import { VorbisEncoder } from './vorbis-encoder';

const log = createLogger('EncoderFactory');

/**
 * Checks if the given encoder configuration is supported.
 * Must be supported by WebCodecs AND have an encoder implementation.
 * @param config - The encoder configuration to check
 * @returns Promise resolving to true if fully supported
 */
export async function checkCodecSupport(config: EncoderConfig): Promise<boolean> {
  // Must have encoder implementation
  if (!hasEncoderImplementation(config.codec)) {
    return false;
  }
  // Must be supported by WebCodecs
  return isCodecSupported(config.codec, config.bitrate, config.sampleRate, config.channels);
}

/**
 * Creates an encoder for the given configuration.
 * @param config - The encoder configuration
 * @returns An initialized audio encoder
 * @throws Error if the codec is not supported or not implemented
 */
export async function createEncoder(config: EncoderConfig): Promise<AudioEncoder> {
  // Check if we have an encoder implementation
  if (!hasEncoderImplementation(config.codec)) {
    log.error(`Codec ${config.codec} is not yet implemented`);
    throw new Error(`Codec ${config.codec} encoder is not yet implemented.`);
  }

  // Check WebCodecs support
  const supported = await isCodecSupported(
    config.codec,
    config.bitrate,
    config.sampleRate,
    config.channels,
  );

  if (!supported) {
    log.error(`Codec ${config.codec} @ ${config.bitrate}kbps is not supported by this browser`);
    throw new Error(
      `Codec ${config.codec} @ ${config.bitrate}kbps is not supported by your browser.`,
    );
  }

  log.info(`Creating encoder: ${config.codec} @ ${config.bitrate}kbps`);

  // Route to appropriate encoder based on codec
  switch (config.codec) {
    case 'aac-lc':
    case 'he-aac':
    case 'he-aac-v2':
      return new AacEncoder(config);
    case 'flac':
      return new FlacEncoder(config);
    case 'vorbis':
      return new VorbisEncoder(config);
    default:
      throw new Error(`No encoder implementation for ${config.codec}`);
  }
}
