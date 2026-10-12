import { useCallback, useEffect, useState } from 'preact/hooks';
import type { AwayEvent } from '../../lib/away-events';
import type { MarkAwaySeenMessage } from '../../lib/messages';
import { noop } from '../../lib/noop';
import { useMountedRef } from './useMountedRef';

/** What {@link useAwayEvents} returns. */
export interface AwayEvents {
  /** What happened while the popup was shut, newest first; empty once dismissed. */
  events: AwayEvent[];
  /** X: the line goes for this popup session. */
  dismiss: () => void;
}

/**
 * "While you were away" (P-away): the events the background stored while the
 * popup was shut, read once on open. They are marked seen as soon as the line
 * is drawn, so the next open never shows them again, and the line stays for
 * this popup session until X.
 * @returns The events and the dismiss
 */
export function useAwayEvents(): AwayEvents {
  const [events, setEvents] = useState<AwayEvent[]>([]);
  const mountedRef = useMountedRef();

  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'GET_AWAY_EVENTS' })
      .then((response: { events?: AwayEvent[] } | undefined) => {
        const unseen = response?.events ?? [];
        if (!mountedRef.current || unseen.length === 0) return;
        setEvents(unseen);
        const seen: MarkAwaySeenMessage = {
          type: 'MARK_AWAY_SEEN',
          payload: { ids: unseen.map((event) => event.id) },
        };
        chrome.runtime.sendMessage(seen).catch(noop);
      })
      .catch(noop);
  }, []);

  const dismiss = useCallback(() => setEvents([]), []);
  return { events, dismiss };
}
