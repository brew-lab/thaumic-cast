import { useState, useEffect, useCallback } from 'preact/hooks';
import type { ActiveCast } from '@thaumic-cast/protocol';
import type { ActiveCastsResponse, ActiveCastsChangedMessage } from '../../lib/messages';

/**
 * Result of the useActiveCasts hook.
 */
interface ActiveCastsResult {
  /** Array of active cast sessions */
  casts: ActiveCast[];
  /** Whether the initial data is still loading */
  loading: boolean;
  /** Function to stop a specific cast by tab ID */
  stopCast: (tabId: number) => Promise<void>;
}

/**
 * Hook to manage active cast sessions.
 * Updates automatically when sessions change.
 *
 * @returns Active casts, loading state, and stop function
 */
export function useActiveCasts(): ActiveCastsResult {
  const [casts, setCasts] = useState<ActiveCast[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Initial fetch
    chrome.runtime
      .sendMessage({ type: 'GET_ACTIVE_CASTS' })
      .then((response: ActiveCastsResponse) => {
        setCasts(response.casts);
      })
      .catch(() => {
        // Background might not be ready
      })
      .finally(() => setLoading(false));

    // Listen for updates
    const handler = (message: { type: string; casts?: ActiveCast[] }) => {
      if (message.type === 'ACTIVE_CASTS_CHANGED' && message.casts) {
        setCasts((message as ActiveCastsChangedMessage).casts);
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  /**
   * Stops a cast session for the specified tab.
   * @param tabId - The tab ID to stop casting
   */
  const stopCast = useCallback(async (tabId: number) => {
    await chrome.runtime.sendMessage({ type: 'STOP_CAST', payload: { tabId } });
  }, []);

  return { casts, loading, stopCast };
}
