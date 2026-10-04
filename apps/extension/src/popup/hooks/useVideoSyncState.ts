import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { VideoSyncStatusSchema, type VideoSyncStatus } from '@thaumic-cast/protocol';
import { VideoSyncStateChangedMessageSchema } from '../../lib/message-schemas';
import { noop } from '../../lib/noop';
import { useChromeMessage } from './useChromeMessage';

/** Debounce interval for the trim slider (ms). */
const TRIM_DEBOUNCE_MS = 300;

/** What the card shows until the background answers. */
const INITIAL_STATUS: VideoSyncStatus = { enabled: true, state: 'locking', trimMs: 0 };

/**
 * Result of the useVideoSyncState hook.
 */
interface VideoSyncStateResult extends VideoSyncStatus {
  /** Switch video sync on or off for this cast */
  setEnabled: (enabled: boolean) => void;
  /** Set the trim for the followed speaker, in ms */
  setTrim: (trimMs: number) => void;
  /** Ask the page's player to try the early sound again after it turned it off */
  tryAgain: () => void;
  /** Reload the cast's tab, so the page gets the video sync scripts */
  reloadPage: () => void;
}

/**
 * Reads a status the background answered with.
 * @param response - Whatever came back
 * @returns The status, or null when it is not one
 */
function readStatus(response: unknown): VideoSyncStatus | null {
  const parsed = VideoSyncStatusSchema.safeParse(response);
  return parsed.success ? parsed.data : null;
}

/**
 * Hook for a cast's video sync status, kept by the background's lead
 * controller, with real-time updates and the card's controls.
 * @param tabId - The cast's tab (undefined for a cast without video sync)
 * @returns Video sync status and control functions
 */
export function useVideoSyncState(tabId: number | undefined): VideoSyncStateResult {
  const [status, setStatus] = useState<VideoSyncStatus>(INITIAL_STATUS);
  const trimDebounceRef = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!tabId) return;
    chrome.runtime
      .sendMessage({ type: 'GET_VIDEO_SYNC_STATE', payload: { tabId } })
      .then((response: unknown) => {
        const next = readStatus(response);
        if (next) setStatus(next);
      })
      .catch(noop);
  }, [tabId]);

  useEffect(() => () => clearTimeout(trimDebounceRef.current), []);

  useChromeMessage(
    (message) => {
      if (!tabId) return;
      const parsed = VideoSyncStateChangedMessageSchema.safeParse(message);
      if (parsed.success && parsed.data.tabId === tabId) setStatus(parsed.data.status);
    },
    [tabId],
  );

  /**
   * Sends a control message and takes the status it answers with.
   * @param message - The message
   */
  const send = useCallback((message: object) => {
    chrome.runtime
      .sendMessage(message)
      .then((response: unknown) => {
        const next = readStatus(response);
        if (next) setStatus(next);
      })
      .catch(noop);
  }, []);

  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!tabId) return;
      setStatus((s) => ({ ...s, enabled, state: enabled ? 'locking' : 'off' }));
      send({ type: 'SET_VIDEO_SYNC_ENABLED', payload: { tabId, enabled } });
    },
    [tabId, send],
  );

  const setTrim = useCallback(
    (trimMs: number) => {
      if (!tabId) return;
      setStatus((s) => ({ ...s, trimMs }));
      clearTimeout(trimDebounceRef.current);
      trimDebounceRef.current = setTimeout(() => {
        send({ type: 'SET_VIDEO_SYNC_TRIM', payload: { tabId, trimMs } });
      }, TRIM_DEBOUNCE_MS);
    },
    [tabId, send],
  );

  const tryAgain = useCallback(() => {
    if (!tabId) return;
    send({ type: 'VIDEO_SYNC_REARM', payload: { tabId } });
  }, [tabId, send]);

  const reloadPage = useCallback(() => {
    if (!tabId) return;
    chrome.tabs.reload(tabId).catch(noop);
  }, [tabId]);

  return { ...status, setEnabled, setTrim, tryAgain, reloadPage };
}
