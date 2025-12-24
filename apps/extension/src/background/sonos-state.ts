/**
 * Sonos State Module
 *
 * Pure state management for Sonos speaker state.
 *
 * Responsibilities:
 * - Store current Sonos state
 * - Provide pure update functions
 * - Persist to session storage for service worker recovery
 *
 * Non-responsibilities:
 * - Side effects (stopping casts, message sending)
 * - Message passing
 */

import type { SonosStateSnapshot, ZoneGroup, TransportState } from '@thaumic-cast/protocol';
import { createEmptySonosState } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';

const log = createLogger('SonosState');

/** Storage key for session persistence */
const STORAGE_KEY = 'sonosState';

/** Current Sonos state */
let state: SonosStateSnapshot = createEmptySonosState();

/** Debounce timer for persistence */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Gets the current Sonos state (read-only).
 * @returns The current SonosStateSnapshot
 */
export function getSonosState(): SonosStateSnapshot {
  return state;
}

/**
 * Sets the entire Sonos state.
 * Used on initial WebSocket connect to set full state.
 * @param newState - The complete state snapshot
 */
export function setSonosState(newState: SonosStateSnapshot): void {
  state = newState;
  schedulePersist();
}

/**
 * Updates the zone groups.
 * @param groups - The updated zone groups array
 * @returns The updated state
 */
export function updateGroups(groups: ZoneGroup[]): SonosStateSnapshot {
  state = { ...state, groups };
  schedulePersist();
  return state;
}

/**
 * Updates volume for a specific speaker.
 * @param speakerIp - The speaker IP address
 * @param volume - The new volume (0-100)
 * @returns The updated state
 */
export function updateVolume(speakerIp: string, volume: number): SonosStateSnapshot {
  state = {
    ...state,
    groupVolumes: { ...state.groupVolumes, [speakerIp]: volume },
  };
  schedulePersist();
  return state;
}

/**
 * Updates mute state for a specific speaker.
 * @param speakerIp - The speaker IP address
 * @param muted - The new mute state
 * @returns The updated state
 */
export function updateMute(speakerIp: string, muted: boolean): SonosStateSnapshot {
  state = {
    ...state,
    groupMutes: { ...state.groupMutes, [speakerIp]: muted },
  };
  schedulePersist();
  return state;
}

/**
 * Updates transport state for a specific speaker.
 * @param speakerIp - The speaker IP address
 * @param transport - The new transport state
 * @returns The updated state
 */
export function updateTransportState(
  speakerIp: string,
  transport: TransportState,
): SonosStateSnapshot {
  state = {
    ...state,
    transportStates: { ...state.transportStates, [speakerIp]: transport },
  };
  schedulePersist();
  return state;
}

/**
 * Schedules a debounced persist to session storage.
 * Prevents excessive writes during rapid state changes.
 */
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 500);
}

/**
 * Persists current state to session storage.
 */
async function persist(): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
    log.debug('Persisted Sonos state');
  } catch (err) {
    log.error('Persist failed:', err);
  }
}

/**
 * Restores state from session storage.
 * Call on service worker startup.
 */
export async function restoreSonosState(): Promise<void> {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    if (result[STORAGE_KEY]) {
      state = result[STORAGE_KEY];
      log.info('Restored Sonos state from session storage');
    }
  } catch (err) {
    log.error('Restore failed:', err);
  }
}
