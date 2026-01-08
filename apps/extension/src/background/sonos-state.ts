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
import { createDebouncedStorage } from '../lib/debounced-storage';

const log = createLogger('SonosState');

/** Current Sonos state */
let state: SonosStateSnapshot = createEmptySonosState();

/** Debounced storage for persistence */
const storage = createDebouncedStorage<SonosStateSnapshot>({
  storageKey: 'sonosState',
  debounceMs: 500,
  loggerName: 'SonosState',
  serialize: () => state,
});

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
  storage.schedule();
}

/**
 * Updates the zone groups.
 * @param groups - The updated zone groups array
 * @returns The updated state
 */
export function updateGroups(groups: ZoneGroup[]): SonosStateSnapshot {
  state = { ...state, groups };
  storage.schedule();
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
  storage.schedule();
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
  storage.schedule();
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
  storage.schedule();
  return state;
}

/**
 * Restores state from session storage.
 * Call on service worker startup.
 */
export async function restoreSonosState(): Promise<void> {
  const restored = await storage.restore();
  if (restored) {
    state = restored;
    log.info('Restored Sonos state from session storage');
  }
}
