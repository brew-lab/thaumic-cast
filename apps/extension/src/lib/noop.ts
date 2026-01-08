/**
 * No-operation function for intentionally swallowed errors.
 *
 * Use this instead of `.catch(() => {})` to make silent error handling explicit.
 * Particularly useful for fire-and-forget operations where errors are expected
 * or unrecoverable (e.g., messaging a background script that may not be ready).
 *
 * @example
 * // Fire-and-forget message
 * chrome.runtime.sendMessage({ type: 'PING' }).catch(noop);
 *
 * // Cleanup that shouldn't throw
 * audioContext.close().catch(noop);
 */
export function noop(): void {
  // Intentionally empty
}
