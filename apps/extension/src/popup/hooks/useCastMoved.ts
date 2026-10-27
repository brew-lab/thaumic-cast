/**
 * Cast-moved hook.
 *
 * Reads the cached per-stream cast-moved snapshot from the background on
 * mount and replaces it on every `CAST_MOVED_CHANGED` broadcast. Exposes one
 * notice per active cast the companion moved in the last ten minutes: the
 * household's Sonos UPnP was switched off, so the cast was started again over
 * the speakers' local connection, with a short skip.
 *
 * Dismissal is keyed on the move's `receivedAt` per stream and persisted in
 * `chrome.storage.local`, so a later move shows again.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ActiveCast } from '@thaumic-cast/protocol';
import type { CastMovedEntry } from '../../lib/message-schemas';
import { useChromeMessage } from './useChromeMessage';
import { useMountedRef } from './useMountedRef';

/** How long a move is mentioned after it happened. */
export const CAST_MOVED_NOTICE_MS = 10 * 60 * 1000;

/** Where dismissed moves are remembered, by stream ID. */
export const CAST_MOVED_DISMISSED_KEY = 'dismissedCastMovedAt';

/** What {@link useCastMoved} returns. */
export interface UseCastMovedResult {
  /** The casts whose move should be mentioned now, by stream ID. */
  notices: { streamId: string }[];
  /** Dismisses the current move for a stream. */
  dismiss: (streamId: string) => void;
}

type CastMovedSnapshot = Record<string, CastMovedEntry>;

/**
 * Checks that a stored value is a map of stream ID to dismissed timestamp.
 * @param value - The value read from storage
 * @returns True if every entry is a number
 */
function isDismissedMap(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'number')
  );
}

/**
 * Tracks the companion's cast-moved reports and exposes dismissible notices
 * for the active casts.
 * @param casts - Active casts; only their streams can produce notices
 * @returns Notices to render and a per-stream dismiss callback
 */
export function useCastMoved(casts: ActiveCast[]): UseCastMovedResult {
  const [snapshot, setSnapshot] = useState<CastMovedSnapshot>({});
  const [dismissed, setDismissed] = useState<Record<string, number>>({});
  const [dismissedLoaded, setDismissedLoaded] = useState(false);
  const mountedRef = useMountedRef();
  const broadcastReceivedRef = useRef(false);

  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'GET_CAST_MOVED' })
      .then((result: CastMovedSnapshot | undefined) => {
        if (!mountedRef.current || !result) return;
        if (broadcastReceivedRef.current) return;
        setSnapshot(result);
      })
      .catch(() => {
        /* background not ready yet — broadcast will fill in when it arrives */
      });

    chrome.storage.local
      .get(CAST_MOVED_DISMISSED_KEY)
      .then((result) => {
        if (!mountedRef.current) return;
        const stored = result[CAST_MOVED_DISMISSED_KEY];
        setDismissed(isDismissedMap(stored) ? stored : {});
      })
      .catch(() => {
        /* storage unavailable — treat as no dismissal */
      })
      .finally(() => {
        if (mountedRef.current) setDismissedLoaded(true);
      });
  }, []);

  useChromeMessage((message) => {
    const msg = message as { type: string; streams?: CastMovedSnapshot };
    if (msg.type !== 'CAST_MOVED_CHANGED') return;
    broadcastReceivedRef.current = true;
    setSnapshot(msg.streams ?? {});
  });

  const dismiss = useCallback(
    (streamId: string) => {
      const entry = snapshot[streamId];
      if (!entry) return;
      // Only live streams are worth remembering; ended ones never move again.
      const next: Record<string, number> = { [streamId]: entry.receivedAt };
      for (const cast of casts) {
        const at = dismissed[cast.streamId];
        if (cast.streamId !== streamId && at !== undefined) next[cast.streamId] = at;
      }
      setDismissed(next);
      chrome.storage.local.set({ [CAST_MOVED_DISMISSED_KEY]: next }).catch(() => {
        /* best-effort; in-memory state still hides the notice this session */
      });
    },
    [snapshot, dismissed, casts],
  );

  const notices: { streamId: string }[] = [];
  if (dismissedLoaded) {
    const now = Date.now();
    for (const cast of casts) {
      const entry = snapshot[cast.streamId];
      if (!entry || now - entry.receivedAt >= CAST_MOVED_NOTICE_MS) continue;
      if (dismissed[cast.streamId] === entry.receivedAt) continue;
      notices.push({ streamId: cast.streamId });
    }
  }

  return { notices, dismiss };
}
