import { useState, useEffect, useCallback } from 'preact/hooks';
import type { ActiveCast } from '@thaumic-cast/protocol';
import type { ActiveCastsResponse } from '../../lib/messages';
import { noop } from '../../lib/noop';
import { useChromeMessage } from './useChromeMessage';

/**
 * Result of the useActiveCasts hook.
 */
interface ActiveCastsResult {
  /** Array of active cast sessions */
  casts: ActiveCast[];
  /** Whether the initial data is still loading */
  loading: boolean;
  /** Stops a cast by tab ID; resolves false when the background says it could not */
  stopCast: (tabId: number) => Promise<boolean>;
  /** Function to remove a speaker from a cast */
  removeSpeaker: (tabId: number, speakerIp: string) => Promise<void>;
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
    chrome.runtime
      .sendMessage({ type: 'GET_ACTIVE_CASTS' })
      .then((response: ActiveCastsResponse) => {
        setCasts(response.casts);
      })
      .catch(noop)
      .finally(() => setLoading(false));
  }, []);

  useChromeMessage((message) => {
    const msg = message as { type: string; casts?: ActiveCast[] };
    if (msg.type === 'ACTIVE_CASTS_CHANGED' && msg.casts) {
      setCasts(msg.casts);
    }
  });

  /**
   * Stops a cast session for the specified tab.
   * @param tabId - The tab ID to stop casting
   * @returns False when the background could not stop it
   * @throws When the background cannot be reached
   */
  const stopCast = useCallback(async (tabId: number): Promise<boolean> => {
    const response: { success?: boolean } | undefined = await chrome.runtime.sendMessage({
      type: 'STOP_CAST',
      payload: { tabId },
    });
    return response?.success !== false;
  }, []);

  /**
   * Removes a single speaker from a cast session.
   * @param tabId - The tab ID of the cast
   * @param speakerIp - The speaker IP to remove
   */
  const removeSpeaker = useCallback(async (tabId: number, speakerIp: string) => {
    await chrome.runtime.sendMessage({ type: 'REMOVE_SPEAKER', payload: { tabId, speakerIp } });
  }, []);

  return { casts, loading, stopCast, removeSpeaker };
}
