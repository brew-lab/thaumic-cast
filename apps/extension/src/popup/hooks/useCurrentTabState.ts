import { useState, useEffect } from 'preact/hooks';
import type { TabMediaState } from '@thaumic-cast/protocol';
import type { CurrentTabStateResponse } from '../../lib/messages';
import { getActiveTab } from '../../lib/tab-utils';
import { noop } from '../../lib/noop';
import { useChromeMessage } from './useChromeMessage';

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
    chrome.runtime
      .sendMessage({ type: 'GET_CURRENT_TAB_STATE' })
      .then((response: CurrentTabStateResponse) => {
        setState(response.state);
        setIsCasting(response.isCasting);
      })
      .catch(noop)
      .finally(() => setLoading(false));
  }, []);

  useChromeMessage((message) => {
    const msg = message as { type: string; tabId?: number; state?: TabMediaState };
    if (msg.type === 'TAB_STATE_CHANGED' && msg.state) {
      getActiveTab().then((tab) => {
        if (tab?.id === msg.tabId && msg.state) {
          setState(msg.state);
        }
      });
    }
  });

  return { state, isCasting, loading };
}
