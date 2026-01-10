/**
 * Computes an exponential backoff delay.
 *
 * The delay doubles with each attempt, starting from `initial` and capping at `max`.
 * Formula: min(initial * 2^(attempt - 1), max)
 *
 * @param attempt - The attempt number (1-indexed)
 * @param initial - Initial delay in milliseconds
 * @param max - Maximum delay in milliseconds
 * @returns The computed delay in milliseconds
 *
 * @example
 * // Reconnection backoff: 500ms → 1000ms → 2000ms → 4000ms → 5000ms (capped)
 * const delay = exponentialBackoff(reconnectAttempts, 500, 5000);
 *
 * @example
 * // Backpressure backoff: 5ms → 10ms → 20ms → 40ms (capped)
 * const delay = exponentialBackoff(consecutiveCycles, 5, 40);
 */
export function exponentialBackoff(attempt: number, initial: number, max: number): number {
  return Math.min(initial * 2 ** (attempt - 1), max);
}
