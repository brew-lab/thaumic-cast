/**
 * Ingest-gaps hook.
 *
 * Reads the cached per-stream ingest-gaps snapshot from the background on
 * mount and replaces it on every `INGEST_GAPS_CHANGED` broadcast. Exposes one
 * notice per active cast whose audio the companion reported arriving late in
 * the last ten minutes: every speaker on it had gaps, and more smoothing is
 * the remedy (or, when the companion suggests none, nothing smoothing can do).
 *
 * Dismissal is keyed on the report's `receivedAt` per stream and persisted in
 * `chrome.storage.local`; the companion sends at most one report every ten
 * minutes, so the next one naturally re-arms.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { ActiveCast, AppType } from '@thaumic-cast/protocol';
import type { IngestGapsEntry } from '../../lib/message-schemas';
import { INGEST_GAPS_NOTICE_MS, ingestGapsLine, type NoticeLine } from '../../lib/speaker-notices';
import { useChromeMessage } from './useChromeMessage';
import { useMountedRef } from './useMountedRef';

/** One ingest-gaps notice the popup should show. */
export interface IngestGapsNoticeView {
  /** The stream whose audio arrived late, used as the notice's identity. */
  streamId: string;
  /** Whether a smoothing step would help, so the settings button is worth showing. */
  hasRemedy: boolean;
  /** The sentence to translate. */
  line: NoticeLine;
}

/** What {@link useIngestGaps} returns. */
export interface UseIngestGapsResult {
  /** Notices the popup should currently render, one per affected cast. */
  notices: IngestGapsNoticeView[];
  /** Dismisses the current report for a stream. */
  dismiss: (streamId: string) => void;
}

type IngestGapsSnapshot = Record<string, IngestGapsEntry>;

const DISMISSED_STORAGE_KEY = 'dismissedIngestGapsAt';

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
 * Tracks the companion's ingest-gaps reports and exposes dismissible notices
 * for the active casts.
 * @param casts - Active casts; only their streams can produce notices
 * @param appType - Which companion is connected, for the wording; null when unknown
 * @returns Notices to render and a per-stream dismiss callback
 */
export function useIngestGaps(casts: ActiveCast[], appType: AppType | null): UseIngestGapsResult {
  const [snapshot, setSnapshot] = useState<IngestGapsSnapshot>({});
  const [dismissed, setDismissed] = useState<Record<string, number>>({});
  const [dismissedLoaded, setDismissedLoaded] = useState(false);
  const mountedRef = useMountedRef();
  const broadcastReceivedRef = useRef(false);

  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'GET_INGEST_GAPS' })
      .then((result: IngestGapsSnapshot | undefined) => {
        if (!mountedRef.current || !result) return;
        if (broadcastReceivedRef.current) return;
        setSnapshot(result);
      })
      .catch(() => {
        /* background not ready yet — broadcast will fill in when it arrives */
      });

    chrome.storage.local
      .get(DISMISSED_STORAGE_KEY)
      .then((result) => {
        if (!mountedRef.current) return;
        const stored = result[DISMISSED_STORAGE_KEY];
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
    const msg = message as { type: string; streams?: IngestGapsSnapshot };
    if (msg.type !== 'INGEST_GAPS_CHANGED') return;
    broadcastReceivedRef.current = true;
    setSnapshot(msg.streams ?? {});
  });

  const dismiss = useCallback(
    (streamId: string) => {
      const report = snapshot[streamId];
      if (!report) return;
      // Only live streams are worth remembering; ended ones never report again.
      const next: Record<string, number> = { [streamId]: report.receivedAt };
      for (const cast of casts) {
        const at = dismissed[cast.streamId];
        if (cast.streamId !== streamId && at !== undefined) next[cast.streamId] = at;
      }
      setDismissed(next);
      chrome.storage.local.set({ [DISMISSED_STORAGE_KEY]: next }).catch(() => {
        /* best-effort; in-memory state still hides the notice this session */
      });
    },
    [snapshot, dismissed, casts],
  );

  const notices: IngestGapsNoticeView[] = [];
  if (dismissedLoaded) {
    const now = Date.now();
    for (const cast of casts) {
      const report = snapshot[cast.streamId];
      if (!report || now - report.receivedAt >= INGEST_GAPS_NOTICE_MS) continue;
      if (dismissed[cast.streamId] === report.receivedAt) continue;
      notices.push({
        streamId: cast.streamId,
        hasRemedy: report.suggestedSmoothingMs !== undefined,
        line: ingestGapsLine(report, appType),
      });
    }
  }

  return { notices, dismiss };
}
