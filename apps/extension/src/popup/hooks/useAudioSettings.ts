import { useState, useEffect, useCallback } from 'preact/hooks';
import {
  type AudioCodec,
  type Bitrate,
  type SupportedCodecsResult,
  getDefaultBitrate,
  getSupportedBitrates,
  detectSupportedCodecs,
} from '@thaumic-cast/protocol';
import {
  loadAudioSettings,
  saveAudioSettings,
  getDefaultSettings,
  type AudioSettings,
} from '../../lib/settings';

const CODEC_CACHE_KEY = 'codecSupportCache';

interface UseAudioSettingsResult {
  auto: boolean;
  codec: AudioCodec;
  bitrate: Bitrate;
  loading: boolean;
  /** Available codecs from runtime detection */
  availableCodecs: AudioCodec[];
  /** Available bitrates for current codec */
  availableBitrates: Bitrate[];
  /** Whether codec detection is complete */
  detectionComplete: boolean;
  setAuto: (auto: boolean) => void;
  setCodec: (codec: AudioCodec) => void;
  setBitrate: (bitrate: Bitrate) => void;
}

/**
 * Loads cached codec support from session storage.
 * @returns Cached result or null if not cached
 */
async function loadCachedCodecSupport(): Promise<SupportedCodecsResult | null> {
  try {
    const result = await chrome.storage.session.get(CODEC_CACHE_KEY);
    return result[CODEC_CACHE_KEY] ?? null;
  } catch {
    return null;
  }
}

/**
 * Saves codec support to session storage.
 * @param support - The detection results to cache
 */
async function cacheCodecSupport(support: SupportedCodecsResult): Promise<void> {
  try {
    await chrome.storage.session.set({ [CODEC_CACHE_KEY]: support });
  } catch {
    // Ignore cache errors
  }
}

/**
 * Hook for managing audio settings with persistence and runtime codec detection.
 * Detects which codecs are supported by the browser's WebCodecs API.
 * Results are cached in session storage to avoid re-detection on every popup open.
 * @returns Audio settings state, available codecs, and setters
 */
export function useAudioSettings(): UseAudioSettingsResult {
  const defaults = getDefaultSettings();
  const [settings, setSettings] = useState<AudioSettings>(defaults);
  const [loading, setLoading] = useState(true);
  const [codecSupport, setCodecSupport] = useState<SupportedCodecsResult | null>(null);
  const [detectionComplete, setDetectionComplete] = useState(false);

  // Load saved settings
  useEffect(() => {
    loadAudioSettings()
      .then(setSettings)
      .finally(() => setLoading(false));
  }, []);

  // Detect supported codecs (with caching)
  useEffect(() => {
    /**
     *
     */
    async function detectWithCache() {
      // Try to load from cache first
      const cached = await loadCachedCodecSupport();
      if (cached) {
        return cached;
      }

      // Run detection and cache results
      const support = await detectSupportedCodecs();
      await cacheCodecSupport(support);
      return support;
    }

    detectWithCache()
      .then((support) => {
        setCodecSupport(support);

        // If current codec is not supported, switch to first available
        if (support.availableCodecs.length > 0) {
          setSettings((prev) => {
            const codecSupported = support.availableCodecs.includes(prev.codec);
            if (!codecSupported && support.defaultCodec) {
              return {
                ...prev,
                codec: support.defaultCodec,
                bitrate: support.defaultBitrate ?? getDefaultBitrate(support.defaultCodec),
              };
            }

            // Check if current bitrate is supported for current codec
            const supportedBitrates = getSupportedBitrates(prev.codec, support);
            if (!supportedBitrates.includes(prev.bitrate) && supportedBitrates.length > 0) {
              return { ...prev, bitrate: supportedBitrates[0] };
            }

            return prev;
          });
        }
      })
      .finally(() => setDetectionComplete(true));
  }, []);

  // Save settings when they change
  useEffect(() => {
    if (!loading && detectionComplete) {
      saveAudioSettings(settings).catch(console.error);
    }
  }, [settings, loading, detectionComplete]);

  const availableCodecs = codecSupport?.availableCodecs ?? [];
  const availableBitrates = codecSupport ? getSupportedBitrates(settings.codec, codecSupport) : [];

  const setCodec = useCallback(
    (codec: AudioCodec) => {
      setSettings((prev: AudioSettings) => {
        // Get supported bitrates for new codec
        const newBitrates = codecSupport ? getSupportedBitrates(codec, codecSupport) : [];
        const newBitrate =
          newBitrates.length > 0
            ? newBitrates.includes(prev.bitrate)
              ? prev.bitrate
              : newBitrates[0]
            : getDefaultBitrate(codec);

        return { ...prev, codec, bitrate: newBitrate };
      });
    },
    [codecSupport],
  );

  const setBitrate = useCallback((bitrate: Bitrate) => {
    setSettings((prev: AudioSettings) => ({ ...prev, bitrate }));
  }, []);

  const setAuto = useCallback((auto: boolean) => {
    setSettings((prev: AudioSettings) => ({ ...prev, auto }));
  }, []);

  return {
    auto: settings.auto,
    codec: settings.codec,
    bitrate: settings.bitrate,
    loading: loading || !detectionComplete,
    availableCodecs,
    availableBitrates,
    detectionComplete,
    setAuto,
    setCodec,
    setBitrate,
  };
}
