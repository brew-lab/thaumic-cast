import { useState, useEffect, useCallback } from 'preact/hooks';
import type { CastAutoStoppedMessage } from '../../lib/messages';

/**
 * Information about an auto-stopped cast.
 */
interface AutoStopNotification {
  /** The tab ID that was stopped */
  tabId: number;
  /** The speaker IP that changed */
  speakerIp: string;
  /** The reason for auto-stop */
  reason: 'source_changed' | 'playback_stopped';
  /** Human-readable message */
  message: string;
}

/**
 * Result of the useAutoStopNotification hook.
 */
interface AutoStopNotificationResult {
  /** Current notification (or null) */
  notification: AutoStopNotification | null;
  /** Dismiss the notification */
  dismiss: () => void;
}

/** Auto-dismiss timeout in milliseconds */
const AUTO_DISMISS_MS = 5000;

/**
 * Hook to handle auto-stop notifications.
 * Shows when a cast was automatically stopped (e.g., user switched Sonos source).
 * @returns Notification state and dismiss function
 */
export function useAutoStopNotification(): AutoStopNotificationResult {
  const [notification, setNotification] = useState<AutoStopNotification | null>(null);

  useEffect(() => {
    const handler = (message: unknown) => {
      const msg = message as { type: string };
      if (msg.type === 'CAST_AUTO_STOPPED') {
        const stopMsg = message as CastAutoStoppedMessage;
        setNotification({
          tabId: stopMsg.tabId,
          speakerIp: stopMsg.speakerIp,
          reason: stopMsg.reason,
          message: stopMsg.message,
        });

        // Auto-dismiss after timeout
        setTimeout(() => setNotification(null), AUTO_DISMISS_MS);
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  const dismiss = useCallback(() => setNotification(null), []);

  return { notification, dismiss };
}
