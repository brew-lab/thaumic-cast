import { useState, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import { createLogger } from '@thaumic-cast/shared';
import { detectSupportedCodecs, type SupportedCodecsResult } from '@thaumic-cast/protocol';
import { getCachedCodecSupport, setCachedCodecSupport } from '../../lib/codec-cache';

const log = createLogger('CodecSupport');

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
  const { t } = useTranslation();
  const [codecSupport, setCodecSupport] = useState<SupportedCodecsResult>(EMPTY_SUPPORT);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  /**
   * Detects supported codecs and caches the result.
   * @returns The codec support result
   */
  async function detectAndCache(): Promise<SupportedCodecsResult> {
    const result = await detectSupportedCodecs();
    await setCachedCodecSupport(result);
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
      const cached = await getCachedCodecSupport();
      if (cached) {
        setCodecSupport(cached);
        setLoading(false);
        return;
      }

      // Not cached, detect now
      const result = await detectAndCache();
      setCodecSupport(result);
      setLoading(false);
    } catch (err) {
      log.error('Codec detection failed:', err);
      setError(t('error_codec_detection'));
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
      log.error('Codec detection failed:', err);
      setError(t('error_codec_detection'));
      setLoading(false);
    }
  }

  useEffect(() => {
    loadCodecSupport();
  }, []);

  return { codecSupport, loading, error, refresh };
}
