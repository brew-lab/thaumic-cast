import { useEffect, useState } from 'preact/hooks';
import { getActiveTabId } from '../../lib/tab-utils';
import { noop } from '../../lib/noop';

/**
 * The id of the tab the popup was opened over: the active tab in its window. Read once,
 * since Chrome closes the popup whenever that window's active tab changes.
 * @returns The tab's id, or null until it is known (or when there is none)
 */
export function useActiveTabId(): number | null {
  const [tabId, setTabId] = useState<number | null>(null);
  useEffect(() => {
    getActiveTabId().then(setTabId).catch(noop);
  }, []);
  return tabId;
}
