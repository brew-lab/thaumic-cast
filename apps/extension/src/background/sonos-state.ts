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

/**
 * The speakers whose volume, and whose mute, entry is the room's own (the companion marked it
 * `own`: followed for a room in a cast played as one Sonos group), not a group's. Such an entry
 * stays when the speaker stops leading a group: a room that joins a cast has its own level read
 * as it joins, often before the topology shows it no longer leading its old group.
 */
const ownVolumes = new Set<string>();
const ownMutes = new Set<string>();

/**
 * Records whether a speaker's entry is its own level or a group's.
 * @param owned - The speakers with an entry of their own
 * @param speakerIp - The speaker
 * @param own - Whether the new entry is the speaker's own
 */
function markOwn(owned: Set<string>, speakerIp: string, own: boolean): void {
  if (own) owned.add(speakerIp);
  else owned.delete(speakerIp);
}

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
  // A snapshot does not say whose entries are their own; the next readings will.
  ownVolumes.clear();
  ownMutes.clear();
  storage.schedule();
}

/**
 * Drops the level entries of every speaker that led a Sonos group and no longer does: such an
 * entry was its group's volume, and kept, a room that joined another group would read its old
 * group's level as its own ("at 80 now"). An entry that is the room's own (`own`: a room that
 * joined a cast, read as it joined) is kept, as the companion keeps it.
 * @param levels - Levels, mutes or fixed flags by speaker IP
 * @param before - The groups until now
 * @param after - The new groups
 * @param own - The speakers whose entry is their own level, kept
 * @returns The entries without the stale group levels
 */
export function dropStaleGroupLevels<T>(
  levels: Record<string, T>,
  before: readonly ZoneGroup[],
  after: readonly ZoneGroup[],
  own: ReadonlySet<string> = new Set(),
): Record<string, T> {
  const leading = new Set(after.map((group) => group.coordinatorIp));
  const stale = before
    .map((group) => group.coordinatorIp)
    .filter((ip) => !leading.has(ip) && !own.has(ip) && ip in levels);
  if (stale.length === 0) return levels;
  const kept = { ...levels };
  for (const ip of stale) delete kept[ip];
  return kept;
}

/**
 * Updates the zone groups.
 * @param groups - The updated zone groups array
 * @returns The updated state
 */
export function updateGroups(groups: ZoneGroup[]): SonosStateSnapshot {
  const before = state.groups;
  state = {
    ...state,
    groups,
    groupVolumes: dropStaleGroupLevels(state.groupVolumes, before, groups, ownVolumes),
    groupMutes: dropStaleGroupLevels(state.groupMutes, before, groups, ownMutes),
    groupVolumeFixed: dropStaleGroupLevels(state.groupVolumeFixed, before, groups),
  };
  storage.schedule();
  return state;
}

/**
 * Updates volume for a specific speaker.
 * @param speakerIp - The speaker IP address
 * @param volume - The new volume (0-100)
 * @param own - The level is the room's own, not its group's (kept when it stops leading a group)
 * @returns The updated state
 */
export function updateVolume(speakerIp: string, volume: number, own = false): SonosStateSnapshot {
  markOwn(ownVolumes, speakerIp, own);
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
 * @param own - The mute is the room's own, not its group's (kept when it stops leading a group)
 * @returns The updated state
 */
export function updateMute(speakerIp: string, muted: boolean, own = false): SonosStateSnapshot {
  markOwn(ownMutes, speakerIp, own);
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
