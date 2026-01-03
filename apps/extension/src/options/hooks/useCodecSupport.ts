import { useState, useEffect } from 'preact/hooks';
import { detectSupportedCodecs, type SupportedCodecsResult } from '@thaumic-cast/protocol';

/** Storage key for caching codec detection results */
const CODEC_CACHE_KEY = 'codecSupportCache';

/**
 * Default empty codec support result.
 */
const EMPTY_SUPPORT: SupportedCodecsResult = {
  supported: [],
  sampleRateSupport: [],
  availableCodecs: [],
  defaultCodec: null,
  defaultBitrate: null,
};

/**
 * Hook for detecting and caching supported audio codecs.
 * Uses session storage to cache results for the browser session.
 * @returns Codec support info and loading state
 */
export function useCodecSupport(): {
  codecSupport: SupportedCodecsResult;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [codecSupport, setCodecSupport] = useState<SupportedCodecsResult>(EMPTY_SUPPORT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Detects supported codecs and caches the result.
   * @returns The codec support result
   */
  async function detectAndCache(): Promise<SupportedCodecsResult> {
    const result = await detectSupportedCodecs();
    await chrome.storage.session.set({ [CODEC_CACHE_KEY]: result });
    return result;
  }

  /**
   * Loads cached codec support or detects if not cached.
   */
  async function loadCodecSupport(): Promise<void> {
    try {
      setLoading(true);
      setError(null);

      // Try to load from cache first
      const cached = await chrome.storage.session.get(CODEC_CACHE_KEY);
      if (cached[CODEC_CACHE_KEY]) {
        setCodecSupport(cached[CODEC_CACHE_KEY]);
        setLoading(false);
        return;
      }

      // Not cached, detect now
      const result = await detectAndCache();
      setCodecSupport(result);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect codec support');
      setLoading(false);
    }
  }

  /**
   * Force refresh codec detection (bypasses cache).
   */
  async function refresh(): Promise<void> {
    try {
      setLoading(true);
      setError(null);
      const result = await detectAndCache();
      setCodecSupport(result);
      setLoading(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to detect codec support');
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCodecSupport();
  }, []);

  return { codecSupport, loading, error, refresh };
}
