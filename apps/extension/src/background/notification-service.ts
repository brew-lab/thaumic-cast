/**
 * Notification Service
 *
 * Centralized service for sending notifications to the popup.
 * Provides explicit subscription support for auditable notification flow
 * and easier testing.
 *
 * Benefits:
 * - Auditable: All notifications flow through a single service
 * - Testable: Can mock or spy on the service in tests
 * - Explicit: Dependencies are clear when modules import the service
 */

import type { BackgroundToPopupMessage } from '../lib/messages';

/** Listener function type for popup notifications */
type NotificationListener = (msg: BackgroundToPopupMessage) => void;

/**
 * Service for managing notifications to the popup.
 * Singleton pattern ensures consistent notification flow.
 */
class NotificationService {
  private listeners = new Set<NotificationListener>();
  private callCount = 0;

  /**
   * Subscribes a listener to receive all popup notifications.
   * Useful for testing or logging.
   * @param listener - Function to call when notifications are sent
   * @returns Unsubscribe function
   */
  subscribe(listener: NotificationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Sends a notification to the popup.
   * Ignores errors when the popup is closed.
   * Also notifies any subscribed listeners.
   * @param msg - The message to send
   */
  notify(msg: BackgroundToPopupMessage): void {
    this.callCount++;

    // Notify subscribed listeners (for testing/logging)
    for (const listener of this.listeners) {
      try {
        listener(msg);
      } catch {
        // Listener errors shouldn't break notifications
      }
    }

    // Send to popup via Chrome runtime
    chrome.runtime.sendMessage(msg).catch(() => {
      // Popup may not be open - this is expected
    });
  }

  /**
   * Returns the count of active listeners.
   * Useful for debugging.
   */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /**
   * Returns the total number of notifications sent.
   * Useful for debugging.
   */
  get notificationCount(): number {
    return this.callCount;
  }
}

/** Singleton instance of the notification service */
export const notificationService = new NotificationService();

/**
 * Sends a notification to the popup.
 * Convenience function that delegates to the notification service.
 * @param msg - The message to send
 */
export function notifyPopup(msg: BackgroundToPopupMessage): void {
  notificationService.notify(msg);
}
