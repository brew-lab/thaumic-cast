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
  consumePendingUserRemoval,
} from './session-manager';
import { notifyPopup } from './notification-service';
import { offscreenBroker } from './offscreen-broker';
import { noop } from '../lib/noop';
import type { SpeakerRemovalReason } from '../lib/messages';

const log = createLogger('SonosEvents');

/** Per-speaker debounce timers for transport state changes */
const transportDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
const TRANSPORT_DEBOUNCE_MS = 500;

/** Tracks recently removed speakers to dedupe events from multiple sources */
const recentlyRemovedSpeakers = new Map<string, number>();
const REMOVAL_DEDUPE_MS = 2000;

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
        await handlePlaybackStopped(eventData.streamId as string, eventData.speakerIp as string);
        break;
    }
  } else if (event.category === 'latency') {
    await handleLatencyEvent(event as LatencyBroadcastEvent);
  }
}

/** Tracks the last media control action sent to each tab to avoid duplicates. */
const lastTabMediaAction = new Map<number, 'pause' | 'play'>();

/**
 * Clears the tracked media action state for a tab.
 * Should be called when a session ends.
 * @param tabId - The tab ID
 */
export function clearTabMediaActionState(tabId: number): void {
  lastTabMediaAction.delete(tabId);
}

/**
 * Handles transport state change events.
 * Debounces rapid changes per-speaker during transitions.
 * When casting, also controls the tab's media playback.
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
  const timer = setTimeout(async () => {
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

    // If Sonos stopped (e.g., stream killed due to underflow), remove speaker from session
    if (state === 'Stopped') {
      const session = getSessionBySpeakerIp(speakerIp);
      if (session) {
        log.warn(`Speaker ${speakerIp} stopped while casting - removing from session`);
        await handleSpeakerRemoval(speakerIp, 'speaker_stopped');
        return;
      }
    }

    // Control tab media when Sonos transport state changes
    await handleTransportMediaControl(speakerIp, state);
  }, TRANSPORT_DEBOUNCE_MS);

  transportDebounceTimers.set(speakerIp, timer);
}

/**
 * Determines if all speakers in a session are in the Playing state.
 * @param session - The session to check
 * @param session.speakerIps - Array of speaker IP addresses in the session
 * @returns True if all speakers are playing
 */
function areAllSessionSpeakersPlaying(session: { speakerIps: string[] }): boolean {
  const sonosState = getSonosState();
  return session.speakerIps.every((ip) => sonosState.transportStates[ip] === 'Playing');
}

/**
 * Controls the tab's media playback based on Sonos transport state.
 * - Pause: Sent when ANY speaker in the session pauses
 * - Play: Sent only when ALL speakers in the session are playing
 * @param speakerIp - The speaker IP address that changed
 * @param state - The new transport state
 */
async function handleTransportMediaControl(
  speakerIp: string,
  state: TransportState,
): Promise<void> {
  // Only act on Playing or PAUSED_PLAYBACK states
  if (state !== 'Playing' && state !== 'PAUSED_PLAYBACK') {
    return;
  }

  // Find if we have an active cast to this speaker
  const session = getSessionBySpeakerIp(speakerIp);
  if (!session) {
    return;
  }

  const tabId = session.tabId;
  const lastAction = lastTabMediaAction.get(tabId);

  if (state === 'PAUSED_PLAYBACK') {
    // Pause immediately when any speaker pauses
    if (lastAction === 'pause') {
      return; // Already paused
    }
    await sendMediaControlToTab(tabId, 'pause', speakerIp);
  } else {
    // Only play when ALL speakers in the session are playing
    if (lastAction === 'play') {
      return; // Already playing
    }
    if (areAllSessionSpeakersPlaying(session)) {
      await sendMediaControlToTab(tabId, 'play', speakerIp);
    }
  }
}

/**
 * Sends a media control command to a tab's content script.
 * @param tabId - The tab ID to send to
 * @param action - The action to perform ('pause' or 'play')
 * @param speakerIp - The speaker IP (for logging)
 */
async function sendMediaControlToTab(
  tabId: number,
  action: 'pause' | 'play',
  speakerIp: string,
): Promise<void> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'CONTROL_MEDIA', action });
    lastTabMediaAction.set(tabId, action);
    log.info(`Sent ${action} command to tab ${tabId} (triggered by ${speakerIp})`);
  } catch {
    // Content script may not be available (tab closed, navigated, etc.)
    log.debug(`Failed to send ${action} to tab ${tabId} - content script unavailable`);
  }
}

/**
 * Syncs current Sonos state to offscreen document for service worker recovery.
 */
function syncStateToOffscreen(): void {
  const state = getSonosState();
  offscreenBroker.syncSonosState(state);
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
  await handleSpeakerRemoval(speakerIp, 'source_changed');
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
 * Stops a cast for a specific tab.
 * Centralizes the stop-cast cleanup sequence to avoid duplication.
 * @param tabId - The tab ID to stop
 */
export async function stopCastForTab(tabId: number): Promise<void> {
  // Clear tracked media action state for this tab
  clearTabMediaActionState(tabId);

  // Re-enable auto-discardable now that cast is stopping
  // (was disabled during cast to prevent Memory Saver from discarding the tab)
  chrome.tabs.update(tabId, { autoDiscardable: true }).catch(noop);

  // Disable video sync before stopping capture
  chrome.tabs
    .sendMessage(tabId, {
      type: 'SET_VIDEO_SYNC_ENABLED',
      payload: { tabId, enabled: false },
    })
    .catch(noop);

  // Send stop message to offscreen
  await offscreenBroker.stopCapture(tabId).catch(noop);

  // Remove session from manager
  removeSession(tabId);
}

/**
 * Handles removal of a speaker from an active cast session.
 * Consolidates the common pattern of:
 * 1. Deduping rapid removals from multiple event sources
 * 2. Finding session (by speaker IP or pre-resolved)
 * 3. Removing speaker from session
 * 4. Stopping cast if last speaker, or notifying popup of partial removal
 *
 * Deduplication is needed because a single speaker stop can trigger both
 * a GENA transportState:Stopped event and a stream playbackStopped event.
 *
 * @param speakerIp - The speaker IP address being removed
 * @param reason - Why the speaker is being removed
 * @param preResolvedSession - Optional pre-resolved session (avoids lookup by speaker IP)
 * @param preResolvedSession.tabId
 * @param preResolvedSession.speakerIps
 * @returns Resolves when the speaker has been removed and notifications sent
 */
async function handleSpeakerRemoval(
  speakerIp: string,
  reason: SpeakerRemovalReason,
  preResolvedSession?: { tabId: number; speakerIps: string[] },
): Promise<void> {
  // Dedupe rapid removals from multiple event sources (GENA + stream events)
  const lastRemoval = recentlyRemovedSpeakers.get(speakerIp);
  if (lastRemoval && Date.now() - lastRemoval < REMOVAL_DEDUPE_MS) {
    log.debug(`Ignoring duplicate removal for ${speakerIp} (reason: ${reason})`);
    return;
  }

  const session = preResolvedSession ?? getSessionBySpeakerIp(speakerIp);
  if (!session) return;

  recentlyRemovedSpeakers.set(speakerIp, Date.now());

  const tabId = session.tabId;

  // Remove this speaker from the session
  removeSpeakerFromSession(tabId, speakerIp);

  // Check if session still has other speakers
  if (hasSession(tabId)) {
    log.info(`Removed speaker ${speakerIp} from cast for tab ${tabId} due to ${reason}`);

    notifyPopup({
      type: 'SPEAKER_REMOVED',
      tabId,
      speakerIp,
      reason,
    });
  } else {
    log.info(`Stopping cast for tab ${tabId} due to ${reason} (last speaker)`);

    await stopCastForTab(tabId);

    notifyPopup({
      type: 'CAST_AUTO_STOPPED',
      tabId,
      speakerIp,
      reason,
    });
  }
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
    });
  }
}

/**
 * Handles playback stopped events.
 * Removes speaker from session when playback stops on it.
 * If no speakers remain, stops the entire cast.
 *
 * Uses streamId to find the correct session, ensuring we don't accidentally
 * remove a speaker from a newly started session during recast scenarios.
 *
 * @param streamId - The stream ID that was stopped
 * @param speakerIp - The speaker IP where playback stopped
 */
async function handlePlaybackStopped(streamId: string, speakerIp: string): Promise<void> {
  // Use streamId to find the correct session (avoids race conditions during recast)
  const session = getSessionByStreamId(streamId);
  if (!session || !session.speakerIps.includes(speakerIp)) {
    // Clear any pending marker to prevent misclassification in future sessions
    // (e.g., user clicked Remove then Stop Cast before event arrived)
    consumePendingUserRemoval(speakerIp);
    log.debug(`PlaybackStopped: stream ${streamId} / speaker ${speakerIp} not found, ignoring`);
    return;
  }

  // Check if this was a user-initiated removal (vs system/network issue)
  const reason: SpeakerRemovalReason = consumePendingUserRemoval(speakerIp)
    ? 'user_removed'
    : 'playback_stopped';

  // Delegate to shared removal logic with pre-resolved session
  await handleSpeakerRemoval(speakerIp, reason, session);
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
