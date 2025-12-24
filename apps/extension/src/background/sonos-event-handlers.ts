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
import type { BroadcastEvent, SonosStateSnapshot, TransportState } from '@thaumic-cast/protocol';
import { updateGroups, updateVolume, updateMute, updateTransportState } from './sonos-state';
import { getSessionBySpeakerIp, removeSession } from './session-manager';

const log = createLogger('SonosEvents');

/** Debounce timer for transport state changes */
let transportDebounceTimer: ReturnType<typeof setTimeout> | null = null;
const TRANSPORT_DEBOUNCE_MS = 500;

/**
 * Handles a broadcast event from the desktop app.
 * Routes to appropriate handler based on event category and type.
 * @param event - The broadcast event from WebSocket
 */
export async function handleSonosEvent(event: BroadcastEvent): Promise<void> {
  log.debug('Received event:', event.type);

  if (event.category === 'sonos') {
    const eventData = event as unknown as Record<string, unknown>;

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
  }
}

/**
 * Handles transport state change events.
 * Debounces rapid changes during transitions.
 * @param speakerIp - The speaker IP address
 * @param state - The new transport state
 */
function handleTransportState(speakerIp: string, state: TransportState): void {
  // Debounce to prevent rapid state flapping during transitions
  if (transportDebounceTimer) {
    clearTimeout(transportDebounceTimer);
  }

  transportDebounceTimer = setTimeout(() => {
    updateTransportState(speakerIp, state);

    notifyPopup({
      type: 'TRANSPORT_STATE_UPDATE',
      speakerIp,
      state,
    });

    log.info(`Transport state: ${speakerIp} → ${state}`);
  }, TRANSPORT_DEBOUNCE_MS);
}

/**
 * Handles source changed events.
 * Auto-stops cast when user switches to another source (Spotify, AirPlay, etc.).
 * @param speakerIp - The speaker IP address
 * @param currentUri - The current playback URI
 */
async function handleSourceChanged(speakerIp: string, currentUri: string): Promise<void> {
  log.warn(`Source changed on ${speakerIp}: ${currentUri}`);

  // Find if we have an active cast to this speaker
  const session = getSessionBySpeakerIp(speakerIp);

  if (session) {
    log.info(`Auto-stopping cast for tab ${session.tabId} due to source change`);

    // Stop the capture in offscreen
    await stopCastForTab(session.tabId);

    // Notify popup with reason for auto-stop
    notifyPopup({
      type: 'CAST_AUTO_STOPPED',
      tabId: session.tabId,
      speakerIp,
      reason: 'source_changed',
      message: 'Sonos switched to another source',
    });
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
  // Send stop message to offscreen
  await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', payload: { tabId } }).catch(() => {
    // Offscreen might not be available
  });

  // Remove session from manager
  removeSession(tabId);
}
