/**
 * Popup Notification Utility
 *
 * Simple utility for sending messages to the popup.
 * Ignores errors when the popup is closed.
 */

/**
 * Sends a message to the popup (ignores errors if popup is closed).
 * @param message - The message to send
 */
export function notifyPopup(message: object): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may not be open
  });
}
