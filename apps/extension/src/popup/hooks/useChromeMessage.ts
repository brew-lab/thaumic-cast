import { useEffect, useRef } from 'preact/hooks';

/**
 * Hook to subscribe to Chrome runtime messages.
 * Handles listener lifecycle (add on mount, remove on unmount/deps change).
 *
 * Uses a ref internally so the handler always has access to the latest
 * closure values without needing useCallback.
 *
 * @param handler - Message handler function
 * @param deps - Dependencies array for re-subscribing (defaults to empty)
 *
 * @example
 * // Single message type
 * useChromeMessage((msg) => {
 *   if (msg.type === 'SOME_EVENT') {
 *     setState(msg.payload);
 *   }
 * });
 *
 * @example
 * // Multiple message types
 * useChromeMessage((msg) => {
 *   switch (msg.type) {
 *     case 'EVENT_A': handleA(msg); break;
 *     case 'EVENT_B': handleB(msg); break;
 *   }
 * });
 *
 * @example
 * // With dependencies (re-subscribes when tabId changes)
 * useChromeMessage((msg) => {
 *   if (msg.tabId === tabId) handleMessage(msg);
 * }, [tabId]);
 */
export function useChromeMessage(
  handler: (message: unknown, sender: chrome.runtime.MessageSender) => void,
  deps: unknown[] = [],
): void {
  const handlerRef = useRef(handler);

  // Keep ref updated with latest handler (no deps - runs every render)
  useEffect(() => {
    handlerRef.current = handler;
  });

  useEffect(() => {
    const listener = (message: unknown, sender: chrome.runtime.MessageSender) => {
      handlerRef.current(message, sender);
    };

    chrome.runtime.onMessage.addListener(listener);
    return () => chrome.runtime.onMessage.removeListener(listener);
  }, deps);
}
