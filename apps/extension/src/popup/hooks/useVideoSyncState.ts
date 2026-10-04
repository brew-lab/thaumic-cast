import { useState, useEffect, useCallback, useRef } from 'preact/hooks';
import { z } from 'zod';
import { VideoSyncStatusSchema, type VideoSyncStatus } from '@thaumic-cast/protocol';
import { VideoSyncStateChangedMessageSchema } from '../../lib/message-schemas';
import { noop } from '../../lib/noop';
import { useChromeMessage } from './useChromeMessage';

/** Debounce interval for the trim slider (ms). */
const TRIM_DEBOUNCE_MS = 300;

/**
 * What the card holds until the background answers, or when it answers that
 * the cast has no video sync running: the toggle as the cast started, and
 * no state to show.
 */
const UNKNOWN_STATUS: VideoSyncStatus = { enabled: true, state: 'off', trimMs: 0 };

/** The background's answer to a video sync control message. */
const StatusAnswerSchema = z.object({ status: VideoSyncStatusSchema.nullable() });

/**
 * Result of the useVideoSyncState hook.
 */
interface VideoSyncStateResult extends VideoSyncStatus {
  /** The background has a running video sync for this cast, so its state can be shown */
  known: boolean;
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
 * Reads the status the background answered with.
 * @param response - Whatever came back
 * @returns The status, null when the cast has no video sync running, or
 *   undefined when the answer is not one
 */
function readStatus(response: unknown): VideoSyncStatus | null | undefined {
  const parsed = StatusAnswerSchema.safeParse(response);
  return parsed.success ? parsed.data.status : undefined;
}

/**
 * Hook for a cast's video sync status, kept by the background's lead
 * controller, with real-time updates and the card's controls.
 * @param tabId - The cast's tab (undefined for a cast without video sync)
 * @returns Video sync status and control functions
 */
export function useVideoSyncState(tabId: number | undefined): VideoSyncStateResult {
  const [status, setStatus] = useState<VideoSyncStatus | null>(null);
  const trimDebounceRef = useRef<ReturnType<typeof setTimeout>>();
  /** A trim the user set that the background has not answered for yet. */
  const pendingTrimRef = useRef<number | null>(null);

  /**
   * Takes a status from the background, keeping a trim still on its way
   * there, so the slider does not jump back mid-drag.
   * @param next - The status, or null for no video sync running
   */
  const take = useCallback((next: VideoSyncStatus | null) => {
    const pending = pendingTrimRef.current;
    setStatus(next && pending !== null ? { ...next, trimMs: pending } : next);
  }, []);

  useEffect(() => {
    if (!tabId) return;
    chrome.runtime
      .sendMessage({ type: 'GET_VIDEO_SYNC_STATE', payload: { tabId } })
      .then((response: unknown) => {
        const next = readStatus(response);
        if (next !== undefined) take(next);
      })
      .catch(noop);
  }, [tabId, take]);

  useEffect(() => () => clearTimeout(trimDebounceRef.current), []);

  useChromeMessage(
    (message) => {
      if (!tabId) return;
      const parsed = VideoSyncStateChangedMessageSchema.safeParse(message);
      if (parsed.success && parsed.data.tabId === tabId) take(parsed.data.status);
    },
    [tabId, take],
  );

  /**
   * Sends a control message and takes the status it answers with.
   * @param message - The message
   */
  const send = useCallback(
    (message: object, onAnswer?: () => void) => {
      chrome.runtime
        .sendMessage(message)
        .then((response: unknown) => {
          onAnswer?.();
          const next = readStatus(response);
          if (next !== undefined) take(next);
        })
        .catch(onAnswer ?? noop);
    },
    [take],
  );

  const setEnabled = useCallback(
    (enabled: boolean) => {
      if (!tabId) return;
      setStatus((s) => (s ? { ...s, enabled, state: enabled ? 'locking' : 'off' } : s));
      send({ type: 'SET_VIDEO_SYNC_ENABLED', payload: { tabId, enabled } });
    },
    [tabId, send],
  );

  const setTrim = useCallback(
    (trimMs: number) => {
      if (!tabId) return;
      pendingTrimRef.current = trimMs;
      setStatus((s) => (s ? { ...s, trimMs } : s));
      clearTimeout(trimDebounceRef.current);
      trimDebounceRef.current = setTimeout(() => {
        send({ type: 'SET_VIDEO_SYNC_TRIM', payload: { tabId, trimMs } }, () => {
          // A later move of the slider has its own send on the way.
          if (pendingTrimRef.current === trimMs) pendingTrimRef.current = null;
        });
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

  return {
    ...(status ?? UNKNOWN_STATUS),
    known: status !== null,
    setEnabled,
    setTrim,
    tryAgain,
    reloadPage,
  };
}
