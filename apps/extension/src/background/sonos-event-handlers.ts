/**
 * Sonos Event Handlers Module
 *
 * Routes and handles Sonos events from the desktop app.
 *
 * Responsibilities:
 * - Process each event type
 * - Trigger side effects (stopping casts on source change)
 * - Update state via sonos-state module
 * - Notify popup of changes
 *
 * Dependencies:
 * - sonos-state: for state updates
 * - session-manager: for session lookups
 */

import { createLogger } from '@thaumic-cast/shared';
import type {
  BroadcastEvent,
  SonosStateSnapshot,
  TransportState,
  LatencyBroadcastEvent,
} from '@thaumic-cast/protocol';
import {
  updateGroups,
  updateVolume,
  updateMute,
  updateTransportState,
  getSonosState,
} from './sonos-state';
import {
  getSessionBySpeakerIp,
  getSessionByStreamId,
  removeSession,
  removeSpeakerFromSession,
  hasSession,
} from './session-manager';
import i18n from '../lib/i18n';

const log = createLogger('SonosEvents');

/** Per-speaker debounce timers for transport state changes */
const transportDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const TRANSPORT_DEBOUNCE_MS = 500;

/**
 * Handles a broadcast event from the desktop app.
 * Routes to appropriate handler based on event category and type.
 * @param event - The broadcast event from WebSocket
 */
export async function handleSonosEvent(event: BroadcastEvent): Promise<void> {
  log.debug('Received event:', event.type);

  const eventData = event as unknown as Record<string, unknown>;

  if (event.category === 'sonos') {
    switch (event.type) {
      case 'transportState':
        handleTransportState(eventData.speakerIp as string, eventData.state as TransportState);
        break;

      case 'sourceChanged':
        await handleSourceChanged(eventData.speakerIp as string, eventData.currentUri as string);
        break;

      case 'groupVolume':
        handleGroupVolume(eventData.speakerIp as string, eventData.volume as number);
        break;

      case 'groupMute':
        handleGroupMute(eventData.speakerIp as string, eventData.muted as boolean);
        break;

      case 'zoneGroupsUpdated':
        handleZoneGroupsUpdated(eventData.groups as SonosStateSnapshot['groups']);
        break;
    }
  } else if (event.category === 'stream') {
    switch (event.type) {
      case 'ended':
        await handleStreamEnded(eventData.streamId as string);
        break;

      case 'playbackStopped':
        await handlePlaybackStopped(eventData.speakerIp as string);
        break;
    }
  } else if (event.category === 'latency') {
    await handleLatencyEvent(event as LatencyBroadcastEvent);
  }
}

/**
 * Handles transport state change events.
 * Debounces rapid changes per-speaker during transitions.
 * @param speakerIp - The speaker IP address
 * @param state - The new transport state
 */
function handleTransportState(speakerIp: string, state: TransportState): void {
  // Clear existing timer for this specific speaker
  const existingTimer = transportDebounceTimers.get(speakerIp);
  if (existingTimer) {
    clearTimeout(existingTimer);
  }

  // Set new timer for this speaker (debounce per-speaker, not globally)
  const timer = setTimeout(() => {
    transportDebounceTimers.delete(speakerIp);
    updateTransportState(speakerIp, state);

    // Sync updated state to offscreen for service worker recovery
    syncStateToOffscreen();

    notifyPopup({
      type: 'TRANSPORT_STATE_UPDATE',
      speakerIp,
      state,
    });

    log.info(`Transport state: ${speakerIp} → ${state}`);
  }, TRANSPORT_DEBOUNCE_MS);

  transportDebounceTimers.set(speakerIp, timer);
}

/**
 * Syncs current Sonos state to offscreen document for service worker recovery.
 */
function syncStateToOffscreen(): void {
  const state = getSonosState();
  chrome.runtime.sendMessage({ type: 'SYNC_SONOS_STATE', state }).catch(() => {
    // Offscreen may not be available
  });
}

/**
 * Handles source changed events.
 * Auto-removes speaker from cast when user switches to another source (Spotify, AirPlay, etc.).
 * If no speakers remain, stops the entire cast.
 * @param speakerIp - The speaker IP address
 * @param currentUri - The current playback URI
 */
async function handleSourceChanged(speakerIp: string, currentUri: string): Promise<void> {
  log.warn(`Source changed on ${speakerIp}: ${currentUri}`);

  // Find if we have an active cast to this speaker
  const session = getSessionBySpeakerIp(speakerIp);

  if (session) {
    const tabId = session.tabId;

    // Remove just this speaker from the session
    removeSpeakerFromSession(tabId, speakerIp);

    // Check if session still has other speakers
    if (hasSession(tabId)) {
      log.info(`Removed speaker ${speakerIp} from cast for tab ${tabId} due to source change`);

      // Notify popup that one speaker was removed
      notifyPopup({
        type: 'SPEAKER_REMOVED',
        tabId,
        speakerIp,
        reason: 'source_changed',
      });
    } else {
      log.info(`Auto-stopping cast for tab ${tabId} due to source change (last speaker)`);

      // Last speaker removed - stop the capture
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', payload: { tabId } }).catch(() => {
        // Offscreen might not be available
      });

      // Notify popup that cast ended
      notifyPopup({
        type: 'CAST_AUTO_STOPPED',
        tabId,
        speakerIp,
        reason: 'source_changed',
        message: i18n.t('auto_stop_source_changed'),
      });
    }
  }
}

/**
 * Handles volume change events.
 * @param speakerIp - The speaker IP address
 * @param volume - The new volume (0-100)
 */
function handleGroupVolume(speakerIp: string, volume: number): void {
  updateVolume(speakerIp, volume);

  notifyPopup({
    type: 'VOLUME_UPDATE',
    speakerIp,
    volume,
  });
}

/**
 * Handles mute state change events.
 * @param speakerIp - The speaker IP address
 * @param muted - The new mute state
 */
function handleGroupMute(speakerIp: string, muted: boolean): void {
  updateMute(speakerIp, muted);

  notifyPopup({
    type: 'MUTE_UPDATE',
    speakerIp,
    muted,
  });
}

/**
 * Handles zone groups updated events.
 * @param groups - The updated zone groups array
 */
function handleZoneGroupsUpdated(groups: SonosStateSnapshot['groups']): void {
  const newState = updateGroups(groups);

  notifyPopup({
    type: 'WS_STATE_CHANGED',
    state: newState,
  });

  log.info(`Zone groups updated: ${groups.length} groups`);
}

/**
 * Sends a message to the popup.
 * Silently ignores errors if popup is not open.
 * @param message - The message to send
 */
function notifyPopup(message: object): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may not be open - this is expected
  });
}

/**
 * Stops a cast for a specific tab.
 * Sends stop message to offscreen and removes session.
 * @param tabId - The tab ID to stop
 */
async function stopCastForTab(tabId: number): Promise<void> {
  // Disable video sync before stopping capture
  chrome.tabs
    .sendMessage(tabId, {
      type: 'SET_VIDEO_SYNC_ENABLED',
      payload: { tabId, enabled: false },
    })
    .catch(() => {
      // Content script may not be available
    });

  // Send stop message to offscreen
  await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', payload: { tabId } }).catch(() => {
    // Offscreen might not be available
  });

  // Remove session from manager
  removeSession(tabId);
}

/**
 * Handles stream ended events.
 * Cleans up the session when the desktop app ends the stream.
 * @param streamId - The stream ID that ended
 */
async function handleStreamEnded(streamId: string): Promise<void> {
  const session = getSessionByStreamId(streamId);

  if (session) {
    log.info(`Stream ${streamId} ended, cleaning up session for tab ${session.tabId}`);

    // Stop the capture in offscreen
    await stopCastForTab(session.tabId);

    // Notify popup that the cast was stopped (use first speaker for backward compat)
    notifyPopup({
      type: 'CAST_AUTO_STOPPED',
      tabId: session.tabId,
      speakerIp: session.speakerIps[0],
      reason: 'stream_ended',
      message: i18n.t('auto_stop_stream_ended'),
    });
  }
}

/**
 * Handles playback stopped events.
 * Removes speaker from session when playback stops on it.
 * If no speakers remain, stops the entire cast.
 * @param speakerIp - The speaker IP where playback stopped
 */
async function handlePlaybackStopped(speakerIp: string): Promise<void> {
  const session = getSessionBySpeakerIp(speakerIp);

  if (session) {
    const tabId = session.tabId;

    // Remove just this speaker from the session
    removeSpeakerFromSession(tabId, speakerIp);

    // Check if session still has other speakers
    if (hasSession(tabId)) {
      log.info(`Removed speaker ${speakerIp} from cast for tab ${tabId} due to playback stopped`);

      // Notify popup that one speaker was removed
      notifyPopup({
        type: 'SPEAKER_REMOVED',
        tabId,
        speakerIp,
        reason: 'playback_stopped',
      });
    } else {
      log.info(`Playback stopped on ${speakerIp}, stopping cast for tab ${tabId} (last speaker)`);

      // Last speaker removed - stop the capture
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', payload: { tabId } }).catch(() => {
        // Offscreen might not be available
      });

      // Notify popup that cast ended
      notifyPopup({
        type: 'CAST_AUTO_STOPPED',
        tabId,
        speakerIp,
        reason: 'playback_stopped',
        message: i18n.t('auto_stop_playback_stopped'),
      });
    }
  }
}

/**
 * Handles latency measurement events.
 * Routes to:
 * 1. Content script of the casting tab (for video sync)
 * 2. Popup (for latency display)
 * @param event - The latency event (updated or stale)
 */
async function handleLatencyEvent(event: LatencyBroadcastEvent): Promise<void> {
  const { streamId, speakerIp, type } = event;

  // Find session to get tab ID
  const session = getSessionByStreamId(streamId);

  if (!session) {
    log.debug(`Latency event for unknown stream ${streamId}`);
    return;
  }

  const tabId = session.tabId;

  // Forward to content script for video sync
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'LATENCY_EVENT',
      payload: event,
    });
  } catch {
    // Content script may not be injected yet
    log.debug(`Failed to send latency event to tab ${tabId}`);
  }

  // Notify popup for UI display
  if (type === 'updated') {
    notifyPopup({
      type: 'LATENCY_UPDATE',
      streamId,
      speakerIp,
      epochId: event.epochId,
      latencyMs: event.latencyMs,
      jitterMs: event.jitterMs,
      confidence: event.confidence,
    });
  } else if (type === 'stale') {
    notifyPopup({
      type: 'LATENCY_STALE',
      streamId,
      speakerIp,
      epochId: event.epochId,
    });
  }
}
