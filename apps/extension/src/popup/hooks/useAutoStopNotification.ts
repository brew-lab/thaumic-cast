import { useState, useCallback, useRef, useEffect } from 'preact/hooks';
import { useTranslation } from 'react-i18next';
import type {
  CastAutoStoppedMessage,
  CastAutoStopReason,
  SpeakerRemovedMessage,
} from '../../lib/messages';
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
  reason: CastAutoStopReason;
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
 * Hook to handle speaker removal notifications.
 * Shows notifications when:
 * - A cast was automatically stopped (last speaker removed)
 * - A speaker was removed from a multi-speaker cast (partial removal)
 *
 * Does NOT show notifications for user-initiated removals.
 *
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

  /**
   * Shows a notification and starts the auto-dismiss timer.
   */
  const showNotification = useCallback(
    (tabId: number, speakerIp: string, reason: CastAutoStopReason) => {
      // Cancel previous timer before setting new notification
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }

      setNotification({ tabId, speakerIp, reason });

      timerRef.current = setTimeout(() => {
        setNotification(null);
        timerRef.current = null;
      }, AUTO_DISMISS_MS);
    },
    [],
  );

  useChromeMessage((message) => {
    const msg = message as { type: string };

    // Handle full cast auto-stop (last speaker removed)
    // Only show notification for system-initiated removals, not user-initiated
    if (msg.type === 'CAST_AUTO_STOPPED') {
      const stopMsg = message as CastAutoStoppedMessage;
      if (stopMsg.reason !== 'user_removed') {
        showNotification(stopMsg.tabId, stopMsg.speakerIp, stopMsg.reason);
      }
      return;
    }

    // Handle partial speaker removal (other speakers remain)
    // Only show notification for system-initiated removals, not user-initiated
    if (msg.type === 'SPEAKER_REMOVED') {
      const removedMsg = message as SpeakerRemovedMessage;
      if (removedMsg.reason !== 'user_removed') {
        showNotification(removedMsg.tabId, removedMsg.speakerIp, removedMsg.reason);
      }
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
