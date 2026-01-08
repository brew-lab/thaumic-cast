import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type { CastAutoStoppedMessage } from '../../lib/messages';
import { useChromeMessage } from './useChromeMessage';

/**
 * Information about an auto-stopped cast.
 */
interface AutoStopNotification {
  /** The tab ID that was stopped */
  tabId: number;
  /** The speaker IP that changed */
  speakerIp: string;
  /** The reason for auto-stop */
  reason: 'source_changed' | 'playback_stopped' | 'stream_ended';
}

/**
 * Result of the useAutoStopNotification hook.
 */
interface AutoStopNotificationResult {
  /** Current notification (or null) */
  notification: AutoStopNotification | null;
  /** Localized message for the notification (or null if no notification) */
  message: string | null;
  /** Dismiss the notification */
  dismiss: () => void;
}

/** Auto-dismiss timeout in milliseconds */
const AUTO_DISMISS_MS = 5000;

/**
 * Hook to handle auto-stop notifications.
 * Shows when a cast was automatically stopped (e.g., user switched Sonos source).
 * @returns Notification state, localized message, and dismiss function
 */
export function useAutoStopNotification(): AutoStopNotificationResult {
  const { t } = useTranslation();
  const [notification, setNotification] = useState<AutoStopNotification | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  useChromeMessage((message) => {
    const msg = message as { type: string };
    if (msg.type === 'CAST_AUTO_STOPPED') {
      const stopMsg = message as CastAutoStoppedMessage;

      // Cancel previous timer before setting new notification
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      setNotification({
        tabId: stopMsg.tabId,
        speakerIp: stopMsg.speakerIp,
        reason: stopMsg.reason,
      });

      timerRef.current = setTimeout(() => {
        setNotification(null);
        timerRef.current = null;
      }, AUTO_DISMISS_MS);
    }
  });

  const dismiss = useCallback(() => {
    // Clear timer when manually dismissing
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setNotification(null);
  }, []);

  const message = notification ? t(`auto_stop_${notification.reason}`) : null;

  return { notification, message, dismiss };
}
