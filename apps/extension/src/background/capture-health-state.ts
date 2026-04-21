/**
 * Capture Health State Module
 *
 * Tracks whether the active tab-capture session is experiencing frame-drop
 * degradation (Chrome's LoopbackStream drops whole AudioData frames on
 * low-core Windows devices — ~9188µs per drop at 48kHz, bursty on affected
 * hardware, near-zero on healthy). `StreamSession` fires an edge-triggered
 * event on each rising/falling transition; this module caches the latest
 * snapshot so a freshly opened popup can render the alert without waiting
 * for the next transition.
 *
 * State is ephemeral (not persisted) — it clears when the session ends.
 */

import { createLogger } from '@thaumic-cast/shared';
import type { CaptureHealthChangedMessage } from '../lib/message-schemas';

const log = createLogger('CaptureHealthState');

export interface CaptureHealthState {
  /** Whether the active session is currently degraded. */
  degraded: boolean;
  /** Tab ID of the session reporting degradation, or null when healthy/idle. */
  tabId: number | null;
  /**
   * `Date.now()` stamp when the latest rising edge was observed. Used by the
   * popup as an event identity for dismissal — a new `detectedAt` means a
   * fresh detection event, even if the user already dismissed a prior one.
   */
  detectedAt: number | null;
}

let state: CaptureHealthState = {
  degraded: false,
  tabId: null,
  detectedAt: null,
};

/**
 * Returns the current capture-health snapshot (read-only copy).
 * @returns The current capture-health snapshot
 */
export function getCaptureHealthState(): CaptureHealthState {
  return { ...state };
}

/**
 * Applies a capture-health edge event from a session. Rising edges set the
 * tracked tab and timestamp. Falling edges only clear when they come from
 * the currently tracked tab — otherwise a recovery event from Tab B would
 * wipe Tab A's still-valid degradation.
 * @param tabId - The tab ID that reported the transition
 * @param degraded - Whether the session is now degraded
 * @param detectedAt - Timestamp of the edge (Date.now from session)
 * @returns True if state actually changed (caller should broadcast)
 */
export function applyCaptureHealthEvent(
  tabId: number,
  degraded: boolean,
  detectedAt: number,
): boolean {
  if (degraded) {
    state = { degraded: true, tabId, detectedAt };
    log.info(`Capture degraded on tab ${tabId} at ${detectedAt}`);
    return true;
  }

  if (state.tabId !== tabId) return false;

  state = { degraded: false, tabId: null, detectedAt: null };
  log.info(`Capture recovered on tab ${tabId}`);
  return true;
}

/**
 * Clears the capture-health state. Called when the associated session ends
 * so the next session starts with a clean slate.
 * @param tabId - Tab whose session is ending; no-op if it isn't the tracked tab
 * @returns True if state actually changed (caller should broadcast)
 */
export function clearCaptureHealthForTab(tabId: number): boolean {
  if (state.tabId !== tabId) return false;
  state = { degraded: false, tabId: null, detectedAt: null };
  return true;
}

/**
 * Builds the popup broadcast payload from the current state. Single source
 * of truth for the `CAPTURE_HEALTH_CHANGED` shape — callers that mutate
 * state via {@link applyCaptureHealthEvent} or {@link clearCaptureHealthForTab}
 * should broadcast by passing this result to `notifyPopup`.
 * @returns The broadcast message reflecting the current state
 */
export function captureHealthBroadcast(): CaptureHealthChangedMessage {
  return { type: 'CAPTURE_HEALTH_CHANGED', ...state };
}
