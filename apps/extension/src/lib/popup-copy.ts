/**
 * Choices of wording the popup makes from its state.
 *
 * Pure functions, so the rules are testable without Chrome or a render.
 */

/**
 * Picks the label for the button that retries a failed connection: a
 * connection that was up and dropped is reconnected, anything else (nothing
 * found, permission missing) is simply tried again.
 * @param connectionError - The i18n key of the connection error on show
 * @returns The i18n key of the button's label
 */
export function retryLabelKey(connectionError: string): string {
  return connectionError === 'error_connection_lost'
    ? 'retry_connection'
    : 'retry_connection_not_found';
}

/** How the popup words the alert for a tab capture that is dropping frames. */
export interface CaptureHealthAlert {
  /** The i18n key of the message. */
  key: string;
  /** Whether to offer the button that opens settings. */
  hasAction: boolean;
}

/**
 * Words the frame-drop alert. The remedy is browser-wide capture, which only
 * exists on Windows; elsewhere the setting is not shown, so the alert neither
 * recommends it nor sends the user to look for it.
 * @param isWindows - Whether the extension is running on Windows
 * @returns The message key and whether to offer the settings button
 */
export function captureHealthAlert(isWindows: boolean): CaptureHealthAlert {
  return isWindows
    ? { key: 'capture_health_frame_drops_message', hasAction: true }
    : { key: 'capture_health_frame_drops_message_no_remedy', hasAction: false };
}
