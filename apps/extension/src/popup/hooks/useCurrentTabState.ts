import { useState, useEffect } from 'preact/hooks';
import type { TabMediaState } from '@thaumic-cast/protocol';
import type { CurrentTabStateResponse, TabStateChangedMessage } from '../../lib/messages';
import { getActiveTab } from '../../lib/tab-utils';

/**
 * Result of the useCurrentTabState hook.
 */
interface CurrentTabResult {
  /** Current tab's media state, or null if not available */
  state: TabMediaState | null;
  /** Whether the current tab is actively casting */
  isCasting: boolean;
  /** Whether the initial state is still loading */
  loading: boolean;
}

/**
 * Hook to get the current tab's media state.
 * Updates automatically when metadata changes.
 *
 * @returns Current tab state, cast status, and loading state
 */
export function useCurrentTabState(): CurrentTabResult {
  const [state, setState] = useState<TabMediaState | null>(null);
  const [isCasting, setIsCasting] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Initial fetch
    chrome.runtime
      .sendMessage({ type: 'GET_CURRENT_TAB_STATE' })
      .then((response: CurrentTabStateResponse) => {
        setState(response.state);
        setIsCasting(response.isCasting);
      })
      .catch(() => {
        // Background might not be ready
      })
      .finally(() => setLoading(false));

    // Listen for updates
    const handler = (message: { type: string; tabId?: number; state?: TabMediaState }) => {
      if (message.type === 'TAB_STATE_CHANGED' && message.state) {
        // Only update if it's about the current tab
        getActiveTab().then((tab) => {
          if (tab?.id === message.tabId) {
            setState((message as TabStateChangedMessage).state);
          }
        });
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, []);

  return { state, isCasting, loading };
}
