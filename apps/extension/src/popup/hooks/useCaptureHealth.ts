/**
 * Capture-health hook.
 *
 * Mirrors the `useConnectionStatus` → `NETWORK_HEALTH_CHANGED` wiring. Reads
 * the cached snapshot from the background on mount and updates on every
 * `CAPTURE_HEALTH_CHANGED` broadcast.
 *
 * Alerts are sticky: once shown, they only clear on user dismissal or when
 * the cast session ends (background broadcasts a cleared state). Recoveries
 * within a session don't auto-hide.
 *
 * Dismissal is keyed on `detectedAt` and persisted in `chrome.storage.local`,
 * so popup close/reopen during an un-dismissed alert keeps the alert visible.
 * Each rising edge carries a new `detectedAt`, so a fresh detection after
 * dismissal naturally re-arms.
 */

import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { CaptureHealthState } from '../../background/capture-health-state';
import { useChromeMessage } from './useChromeMessage';
import { useMountedRef } from './useMountedRef';

export interface UseCaptureHealthResult {
  /** Whether the popup should currently render the Alert. */
  showAlert: boolean;
  /** Dismisses the current detection event — cleared automatically on a fresh edge. */
  dismiss: () => void;
}

const DISMISSED_AT_STORAGE_KEY = 'dismissedCaptureHealthAt';

/**
 * Tracks capture-health state and exposes a dismissible alert signal.
 * @returns Alert visibility flag and dismiss callback
 */
export function useCaptureHealth(): UseCaptureHealthResult {
  const [health, setHealth] = useState<CaptureHealthState>({
    degraded: false,
    tabId: null,
    detectedAt: null,
  });
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [dismissedLoaded, setDismissedLoaded] = useState(false);
  const mountedRef = useMountedRef();
  // If a broadcast lands before the initial GET resolves, the stale GET
  // response must not overwrite the newer broadcast state.
  const broadcastReceivedRef = useRef(false);

  useEffect(() => {
    chrome.runtime
      .sendMessage({ type: 'GET_CAPTURE_HEALTH' })
      .then((snapshot: CaptureHealthState | undefined) => {
        if (!mountedRef.current || !snapshot) return;
        if (broadcastReceivedRef.current) return;
        setHealth(snapshot);
      })
      .catch(() => {
        /* background not ready yet — broadcast will fill in when it arrives */
      });

    chrome.storage.local
      .get(DISMISSED_AT_STORAGE_KEY)
      .then((result) => {
        if (!mountedRef.current) return;
        const stored = result[DISMISSED_AT_STORAGE_KEY];
        setDismissedAt(typeof stored === 'number' ? stored : null);
      })
      .catch(() => {
        /* storage unavailable — treat as no dismissal */
      })
      .finally(() => {
        if (mountedRef.current) setDismissedLoaded(true);
      });
  }, []);

  useChromeMessage((message) => {
    const msg = message as { type: string; [key: string]: unknown };
    if (msg.type !== 'CAPTURE_HEALTH_CHANGED') return;
    broadcastReceivedRef.current = true;
    setHealth({
      degraded: msg.degraded as boolean,
      tabId: (msg.tabId as number | null) ?? null,
      detectedAt: (msg.detectedAt as number | null) ?? null,
    });
  });

  const dismiss = useCallback(() => {
    const at = health.detectedAt;
    if (at === null) return;
    setDismissedAt(at);
    chrome.storage.local.set({ [DISMISSED_AT_STORAGE_KEY]: at }).catch(() => {
      /* best-effort; in-memory state still hides the alert this session */
    });
  }, [health.detectedAt]);

  // Suppress until dismissedAt has loaded, otherwise a previously-dismissed
  // event would flash the alert on every popup open. Alert is decoupled from
  // `health.degraded` — sticky behavior means we show whenever there's an
  // un-dismissed detection event, regardless of current degraded status.
  const showAlert =
    dismissedLoaded && health.detectedAt !== null && health.detectedAt !== dismissedAt;

  return { showAlert, dismiss };
}
