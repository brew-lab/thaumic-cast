import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import type { VideoSyncStatus } from '@thaumic-cast/protocol';
import type { VideoSyncStateChangedMessage } from '../../lib/messages';

/** Debounce interval for trim slider (ms) */
const TRIM_DEBOUNCE_MS = 100;

/**
 * Result of the useVideoSyncState hook.
 */
interface VideoSyncStateResult extends VideoSyncStatus {
  /** Enable or disable video sync */
  setEnabled: (enabled: boolean) => void;
  /** Set the trim adjustment in milliseconds */
  setTrim: (trimMs: number) => void;
  /** Trigger a manual resync */
  resync: () => void;
}

/**
 * Hook for video sync state with real-time updates.
 * Communicates with content script via background.
 * @param tabId - The tab ID to sync (undefined if no active cast)
 * @returns Video sync state and control functions
 */
export function useVideoSyncState(tabId: number | undefined): VideoSyncStateResult {
  const [state, setState] = useState<VideoSyncStatus>({
    enabled: false,
    trimMs: 0,
    state: 'off',
  });

  const trimDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!tabId) return;

    // Query initial state from content script (via background)
    chrome.runtime
      .sendMessage({ type: 'GET_VIDEO_SYNC_STATE', payload: { tabId } })
      .then((response: VideoSyncStatus | undefined) => {
        if (response) setState(response);
      })
      .catch(() => {
        // Content script may not be ready
      });

    // Listen for state broadcasts from content script
    const handler = (message: unknown) => {
      const msg = message as { type: string };
      if (msg.type === 'VIDEO_SYNC_STATE_CHANGED') {
        const stateMsg = message as VideoSyncStateChangedMessage;
        setState({
          enabled: stateMsg.enabled,
          trimMs: stateMsg.trimMs,
          state: stateMsg.state,
          lockedLatencyMs: stateMsg.lockedLatencyMs,
        });
      }
    };

    chrome.runtime.onMessage.addListener(handler);
    return () => chrome.runtime.onMessage.removeListener(handler);
  }, [tabId]);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!tabId) return;
      // Optimistic update for immediate feedback
      setState((s) => ({ ...s, enabled, state: enabled ? 'off' : 'off' }));
      // Send to content script - it will broadcast the confirmed state back
      chrome.runtime
        .sendMessage({ type: 'SET_VIDEO_SYNC_ENABLED', payload: { tabId, enabled } })
        .catch(() => {
          // Revert on failure
          setState((s) => ({ ...s, enabled: !enabled }));
        });
    },
    [tabId],
  );

  const setTrim = useCallback(
    (trimMs: number) => {
      if (!tabId) return;
      // Optimistic update
      setState((s) => ({ ...s, trimMs }));
      // Debounce actual message (like VolumeControl)
      if (trimDebounceRef.current) clearTimeout(trimDebounceRef.current);
      trimDebounceRef.current = setTimeout(() => {
        chrome.runtime
          .sendMessage({ type: 'SET_VIDEO_SYNC_TRIM', payload: { tabId, trimMs } })
          .catch(() => {});
      }, TRIM_DEBOUNCE_MS);
    },
    [tabId],
  );

  const resync = useCallback(() => {
    if (!tabId) return;
    chrome.runtime.sendMessage({ type: 'TRIGGER_RESYNC', payload: { tabId } }).catch(() => {});
  }, [tabId]);

  return {
    ...state,
    setEnabled,
    setTrim,
    resync,
  };
}
