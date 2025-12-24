import { useState, useEffect, useCallback } from 'preact/hooks';
import {
  type AudioCodec,
  type Bitrate,
  getDefaultBitrate,
  isValidBitrateForCodec,
} from '@thaumic-cast/protocol';
import {
  loadAudioSettings,
  saveAudioSettings,
  getDefaultSettings,
  type AudioSettings,
} from '../../lib/settings';

interface UseAudioSettingsResult {
  codec: AudioCodec;
  bitrate: Bitrate;
  loading: boolean;
  setCodec: (codec: AudioCodec) => void;
  setBitrate: (bitrate: Bitrate) => void;
}

/**
 * Hook for managing audio settings with persistence.
 * @returns Audio settings state and setters
 */
export function useAudioSettings(): UseAudioSettingsResult {
  const defaults = getDefaultSettings();
  const [settings, setSettings] = useState<AudioSettings>(defaults);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAudioSettings()
      .then(setSettings)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!loading) {
      saveAudioSettings(settings).catch(console.error);
    }
  }, [settings, loading]);

  const setCodec = useCallback((codec: AudioCodec) => {
    setSettings((prev: AudioSettings) => {
      const newBitrate = isValidBitrateForCodec(codec, prev.bitrate)
        ? prev.bitrate
        : getDefaultBitrate(codec);

      return { codec, bitrate: newBitrate };
    });
  }, []);

  const setBitrate = useCallback((bitrate: Bitrate) => {
    setSettings((prev: AudioSettings) => ({ ...prev, bitrate }));
  }, []);

  return {
    codec: settings.codec,
    bitrate: settings.bitrate,
    loading,
    setCodec,
    setBitrate,
  };
}
