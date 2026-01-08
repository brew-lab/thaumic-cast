/**
 * Codec Support Cache Module
 *
 * Centralizes codec detection result caching to prevent duplication
 * and ensure consistency across background, options, and offscreen contexts.
 *
 * Note: Actual codec detection (detectSupportedCodecs) must be called from
 * a window context (options page or offscreen document) since AudioEncoder
 * is not available in service workers.
 */

import type { SupportedCodecsResult } from '@thaumic-cast/protocol';

/** Storage key for caching codec detection results in session storage. */
const CODEC_CACHE_KEY = 'codecSupportCache';

/**
 * Retrieves cached codec support from session storage.
 * @returns The cached codec support, or null if not cached
 */
export async function getCachedCodecSupport(): Promise<SupportedCodecsResult | null> {
  const cached = await chrome.storage.session.get(CODEC_CACHE_KEY);
  return (cached[CODEC_CACHE_KEY] as SupportedCodecsResult) ?? null;
}

/**
 * Caches codec support in session storage.
 * @param result - The codec support result to cache
 */
export async function setCachedCodecSupport(result: SupportedCodecsResult): Promise<void> {
  await chrome.storage.session.set({ [CODEC_CACHE_KEY]: result });
}
