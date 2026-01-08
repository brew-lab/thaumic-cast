/**
 * Codec Support Detection
 *
 * Handles detection and caching of supported audio codecs.
 * AudioEncoder is only available in window contexts (offscreen document),
 * so detection must be delegated there.
 *
 * Responsibilities:
 * - Request codec detection from offscreen
 * - Cache detection results
 * - Provide codec support for encoder selection
 *
 * Non-responsibilities:
 * - Encoder configuration selection (handled by device-config.ts)
 */

import { createLogger } from '@thaumic-cast/shared';
import type { SupportedCodecsResult } from '@thaumic-cast/protocol';
import { getCachedCodecSupport, setCachedCodecSupport } from '../lib/codec-cache';
import { offscreenBroker } from './offscreen-broker';

const log = createLogger('Background');

/**
 * Detects supported audio codecs via offscreen document and caches the result.
 * AudioEncoder is only available in window contexts, not service workers,
 * so we must delegate detection to the offscreen document.
 * @returns The codec support result, or null if detection failed
 */
export async function detectAndCacheCodecSupport(): Promise<SupportedCodecsResult | null> {
  try {
    // Check if already cached
    const cached = await getCachedCodecSupport();
    if (cached) {
      log.debug('Codec support already cached');
      return cached;
    }

    // Request detection from offscreen document (AudioEncoder available there)
    log.info('Requesting codec detection from offscreen...');
    const response = await offscreenBroker.detectCodecs();

    if (response?.success && response.result) {
      const result = response.result as SupportedCodecsResult;
      await setCachedCodecSupport(result);
      log.info(
        `Codec detection complete: ${result.availableCodecs.length} codecs available (default: ${result.defaultCodec})`,
      );
      return result;
    }

    log.warn('Codec detection failed:', response?.error);
    return null;
  } catch (err) {
    log.warn('Codec detection failed:', err);
    return null;
  }
}
