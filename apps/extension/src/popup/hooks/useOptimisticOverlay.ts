import { useState, useEffect, useCallback } from 'preact/hooks';

/**
 * Hook for optimistic UI updates that auto-clear when the real value changes.
 *
 * Useful when you want immediate UI feedback while waiting for server confirmation.
 * The optimistic value is automatically cleared when the real value updates,
 * indicating the server has responded.
 *
 * @param realValue - The authoritative value from the server/source
 * @returns Tuple of [displayValue, setOptimistic, clearOptimistic]
 *
 * @example
 * // Play/pause button with optimistic feedback
 * const [displayIsPlaying, setOptimisticPlaying] = useOptimisticOverlay(isPlaying);
 *
 * const handlePlayPause = () => {
 *   setOptimisticPlaying(!displayIsPlaying);
 *   sendPlayPauseCommand();
 * };
 */
export function useOptimisticOverlay<T>(
  realValue: T,
): [value: T, setOptimistic: (value: T) => void, clearOptimistic: () => void] {
  const [optimistic, setOptimistic] = useState<T | null>(null);

  // Clear optimistic state when real value changes (server confirmed)
  useEffect(() => {
    setOptimistic(null);
  }, [realValue]);

  const clear = useCallback(() => setOptimistic(null), []);

  // Return optimistic value if set, otherwise real value
  return [optimistic ?? realValue, setOptimistic, clear];
}
