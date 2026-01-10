import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { probeSpeakerIp, addManualSpeakerIp } from '../state/store';

interface UseAddManualSpeakerOptions {
  /** Callback when speaker is successfully added, receives the added IP */
  onSuccess?: (ip: string) => void;
}

interface UseAddManualSpeakerResult {
  /** Whether a probe/add operation is in progress */
  isTesting: boolean;
  /** Error message from last failed attempt, or null */
  error: string | null;
  /** Add a speaker by IP address */
  addSpeaker: (ip: string) => Promise<boolean>;
  /** Clear any existing error */
  clearError: () => void;
}

/**
 * Hook for adding manual Sonos speaker IPs.
 * Handles probing and adding speakers. Backend automatically triggers topology refresh.
 *
 * @param options - Hook configuration
 * @returns State and actions for adding speakers
 */
export function useAddManualSpeaker(
  options: UseAddManualSpeakerOptions = {},
): UseAddManualSpeakerResult {
  const { onSuccess } = options;
  const [isTesting, setIsTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track mounted state to prevent state updates after unmount
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Store onSuccess in a ref to avoid recreating addSpeaker on every render
  const onSuccessRef = useRef(onSuccess);
  onSuccessRef.current = onSuccess;

  const addSpeaker = useCallback(async (ip: string): Promise<boolean> => {
    const trimmedIp = ip.trim();
    if (!trimmedIp) return false;

    setIsTesting(true);
    setError(null);

    try {
      // Probe with minimum delay for better UX
      // probeSpeakerIp returns the Speaker with the cleaned IP address
      const [result] = await Promise.all([
        probeSpeakerIp(trimmedIp)
          .then((speaker) => ({ success: true as const, ip: speaker.ip }))
          .catch((e) => ({ success: false as const, ip: '', error: String(e) })),
        new Promise((resolve) => setTimeout(resolve, 400)),
      ]);

      if (!mountedRef.current) return false;

      if (result.success) {
        // Use the cleaned IP from the probe result, not the original user input
        await addManualSpeakerIp(result.ip);
        // Backend automatically triggers topology refresh; views update via event listener
        onSuccessRef.current?.(result.ip);
        return true;
      } else {
        setError(result.error);
        return false;
      }
    } finally {
      if (mountedRef.current) {
        setIsTesting(false);
      }
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  return {
    isTesting,
    error,
    addSpeaker,
    clearError,
  };
}

/**
 * Get a localized error message for speaker probe errors.
 *
 * @param error - The error string from probe attempt
 * @param t - Translation function from useTranslation
 * @returns Localized error message
 */
export function getSpeakerErrorMessage(error: string, t: (key: string) => string): string {
  if (error.includes('ip_unreachable')) {
    return t('onboarding.speakers.manual_error_unreachable');
  }
  if (error.includes('not_sonos_device')) {
    return t('onboarding.speakers.manual_error_not_sonos');
  }
  if (error.includes('invalid_ip')) {
    return t('onboarding.speakers.manual_error_invalid');
  }
  // Generic fallback for unexpected errors (timeout, network issues, etc.)
  return t('onboarding.speakers.manual_error_generic');
}
