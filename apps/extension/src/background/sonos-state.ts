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

import type {
  SonosStateSnapshot,
  ZoneGroup,
  TransportState,
  PlaybackSession,
} from '@thaumic-cast/protocol';
import { createEmptySonosState } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import { persistenceManager } from './persistence-manager';
import { SpeakerGroupCollection } from '../domain/speaker';

const log = createLogger('SonosState');

/** Current Sonos state */
let state: SonosStateSnapshot = createEmptySonosState();

/** Debounced storage for persistence, registered with manager */
const storage = persistenceManager.register<SonosStateSnapshot>(
  {
    storageKey: 'sonosState',
    debounceMs: 500,
    loggerName: 'SonosState',
    serialize: () => state,
  },
  (restored) => {
    if (restored) {
      state = restored;
      log.info('Restored Sonos state from session storage');
    }
  },
);

/**
 * Gets the current Sonos state (read-only).
 * @returns The current SonosStateSnapshot
 */
export function getSonosState(): SonosStateSnapshot {
  return state;
}

/**
 * Gets the speaker groups as a domain model collection.
 * Provides type-safe operations for speaker/group lookups.
 * @returns A SpeakerGroupCollection for the current groups
 */
export function getSpeakerGroups(): SpeakerGroupCollection {
  return SpeakerGroupCollection.fromZoneGroups(state.groups);
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
 * Updates fixed volume state for a specific speaker.
 * @param speakerIp - The speaker IP address
 * @param fixed - Whether volume is fixed (line-level output)
 * @returns The updated state
 */
export function updateVolumeFixed(speakerIp: string, fixed: boolean): SonosStateSnapshot {
  state = {
    ...state,
    groupVolumeFixed: { ...state.groupVolumeFixed, [speakerIp]: fixed },
  };
  storage.schedule();
  return state;
}

/**
 * Records that another client of the companion started playing on a speaker.
 *
 * The companion sends other clients' stream ids as opaque aliases, the same
 * ones the connect-time snapshot used, so the entry matches what a fresh
 * snapshot would contain. A speaker holds one session at a time, so any
 * earlier remote entry for the same speaker is replaced.
 * @param streamId - The aliased stream id the companion sent
 * @param speakerIp - The speaker now playing that stream
 * @returns The updated state
 */
export function addRemoteSession(streamId: string, speakerIp: string): SonosStateSnapshot {
  const others = (state.sessions ?? []).filter((session) => session.speakerIp !== speakerIp);
  state = {
    ...state,
    sessions: [...others, { streamId, speakerIp, streamUrl: '', redacted: true }],
  };
  storage.schedule();
  return state;
}

/**
 * Drops the remote sessions `keep` rejects. Sessions this client owns are never
 * touched; they are tracked by the session manager, not by this snapshot.
 * @param keep - Returns true for a remote session that should stay
 * @returns The updated state
 */
function retainRemoteSessions(keep: (session: PlaybackSession) => boolean): SonosStateSnapshot {
  const sessions = (state.sessions ?? []).filter(
    (session) => session.redacted !== true || keep(session),
  );
  if (sessions.length !== (state.sessions ?? []).length) {
    state = { ...state, sessions };
    storage.schedule();
  }
  return state;
}

/**
 * Forgets another client's session on a speaker that stopped playing it.
 * @param speakerIp - The speaker that stopped
 * @returns The updated state
 */
export function removeRemoteSessionForSpeaker(speakerIp: string): SonosStateSnapshot {
  return retainRemoteSessions((session) => session.speakerIp !== speakerIp);
}

/**
 * Forgets every session of another client's stream that has ended.
 * @param streamId - The aliased stream id the companion sent
 * @returns The updated state
 */
export function removeRemoteSessionsForStream(streamId: string): SonosStateSnapshot {
  return retainRemoteSessions((session) => session.streamId !== streamId);
}
