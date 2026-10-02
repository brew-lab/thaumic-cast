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
