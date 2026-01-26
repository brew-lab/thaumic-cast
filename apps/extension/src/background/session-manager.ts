/**
 * Session Manager Module
 *
 * Manages active cast sessions and their lifecycle.
 *
 * Responsibilities:
 * - Track active cast sessions
 * - Coordinate start/stop lifecycle
 * - Combine session data with cached metadata
 * - Notify popup of changes
 *
 * Dependencies:
 * - metadata-cache: for media states
 */

import type {
  ActiveCast,
  EncoderConfig,
  OriginalGroup,
  TabMediaState,
} from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import { getCachedState } from './metadata-cache';
import { notifyPopup } from './notification-service';
import { persistenceManager } from './persistence-manager';

const log = createLogger('SessionManager');

// ─────────────────────────────────────────────────────────────────────────────
// Power Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Requests system keep-awake to prevent throttling during casting.
 * Only requests if not already held.
 */
function requestKeepAwake(): void {
  try {
    chrome.power.requestKeepAwake('system');
    log.info('Requested system keep-awake');
  } catch (err) {
    log.warn('Failed to request keep-awake:', err);
  }
}

/**
 * Releases keep-awake when no active sessions remain.
 */
function releaseKeepAwake(): void {
  try {
    chrome.power.releaseKeepAwake();
    log.info('Released system keep-awake');
  } catch (err) {
    log.warn('Failed to release keep-awake:', err);
  }
}

/**
 * Internal representation of an active cast session.
 * Supports multi-group casting (one stream to multiple speaker groups).
 */
interface ActiveCastSession {
  /** Unique stream ID from server */
  streamId: string;
  /** Tab ID being captured */
  tabId: number;
  /** Target speaker IP addresses (multi-group support) */
  speakerIps: string[];
  /** Speaker/group display names (parallel array with speakerIps) */
  speakerNames: string[];
  /** Encoder configuration used */
  encoderConfig: EncoderConfig;
  /** Timestamp when cast started */
  startedAt: number;
  /** Whether synchronized multi-speaker playback is enabled */
  syncSpeakers: boolean;
  /** Original speaker groups when syncSpeakers is enabled */
  originalGroups?: OriginalGroup[];
  /** Cached IP → coordinatorUuid lookup for O(1) mapping */
  ipToOriginalGroup?: Map<string, string>;
}

/** In-memory storage of active sessions by tab ID */
const sessions = new Map<number, ActiveCastSession>();

/**
 * Builds a lookup table mapping speaker IPs to their original group coordinator UUID.
 * Enables O(1) lookup when setting volume on a speaker during sync playback.
 * @param groups - The original groups from PLAYBACK_RESULTS
 * @returns A Map of speakerIp → coordinatorUuid
 */
function buildIpToGroupLookup(groups: OriginalGroup[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const group of groups) {
    for (const ip of group.speakerIps) {
      map.set(ip, group.coordinatorUuid);
    }
  }
  return map;
}

/**
 * Debounced storage for session persistence, registered with manager.
 * Uses immediate persist() calls (not schedule()) since session data is critical
 * and changes are infrequent.
 */
/** Session data as stored (excludes non-serializable Map cache) */
type StoredSession = Omit<ActiveCastSession, 'ipToOriginalGroup'>;

const storage = persistenceManager.register<[number, StoredSession][]>(
  {
    storageKey: 'activeSessions',
    debounceMs: 0, // Not used - we call persist() directly for immediate writes
    loggerName: 'SessionManager',
    serialize: () =>
      // Note: ipToOriginalGroup (Map) serializes to {} but is rebuilt from
      // originalGroups on restore, so we don't need to explicitly exclude it
      Array.from(sessions.entries()) as [number, StoredSession][],
    restore: (stored) => {
      if (!Array.isArray(stored)) return undefined;

      // Migrate old session formats
      const migrated = (stored as [number, StoredSession][]).map(([tabId, session]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const legacy = session as any;
        // Migrate single-speaker format to multi-speaker arrays
        if (legacy.speakerIp && !legacy.speakerIps) {
          session.speakerIps = [legacy.speakerIp];
          session.speakerNames = [legacy.speakerName || legacy.speakerIp];
          delete legacy.speakerIp;
          delete legacy.speakerName;
          log.info(`Migrated session for tab ${tabId} from single to multi-speaker format`);
        }
        // Default syncSpeakers to false for sessions created before this field existed
        if (session.syncSpeakers === undefined) {
          session.syncSpeakers = false;
        }
        return [tabId, session] as [number, StoredSession];
      });

      return migrated;
    },
  },
  (data) => {
    if (data && data.length > 0) {
      sessions.clear();
      for (const [tabId, storedSession] of data) {
        // Rebuild ipToOriginalGroup cache from originalGroups
        // (Maps don't survive JSON serialization)
        const session: ActiveCastSession = {
          ...storedSession,
          ipToOriginalGroup:
            storedSession.originalGroups && storedSession.originalGroups.length > 0
              ? buildIpToGroupLookup(storedSession.originalGroups)
              : undefined,
        };
        sessions.set(tabId, session);
      }
      log.info(`Restored ${sessions.size} sessions`);
      // Re-request keep-awake for restored sessions
      requestKeepAwake();
    }
  },
);

/**
 * Registers a new cast session.
 * @param tabId - The Chrome tab ID being captured
 * @param streamId - Unique stream ID from server
 * @param speakerIps - Target speaker IP addresses (multi-group support)
 * @param speakerNames - Speaker display names (parallel array)
 * @param encoderConfig - Encoder configuration used
 * @param syncSpeakers - Whether synchronized multi-speaker playback is enabled
 */
export function registerSession(
  tabId: number,
  streamId: string,
  speakerIps: string[],
  speakerNames: string[],
  encoderConfig: EncoderConfig,
  syncSpeakers: boolean,
): void {
  const wasEmpty = sessions.size === 0;

  sessions.set(tabId, {
    streamId,
    tabId,
    speakerIps,
    speakerNames,
    encoderConfig,
    startedAt: Date.now(),
    syncSpeakers,
  });

  // Request keep-awake on first session to prevent system throttling
  if (wasEmpty) {
    requestKeepAwake();
  }

  persistSessions();
  notifySessionsChanged();
  log.info(
    `Registered session for tab ${tabId}, stream ${streamId}, ${speakerIps.length} speaker(s)`,
  );
}

/**
 * Removes a cast session.
 * @param tabId - The Chrome tab ID to remove
 */
export function removeSession(tabId: number): void {
  const session = sessions.get(tabId);
  if (session) {
    sessions.delete(tabId);

    // Release keep-awake when no sessions remain
    if (sessions.size === 0) {
      releaseKeepAwake();
    }

    persistSessions();
    notifySessionsChanged();
    log.info(`Removed session for tab ${tabId}`);
  }
}

/**
 * Clears all sessions.
 * Called when the desktop app becomes permanently unreachable.
 */
export function clearAllSessions(): void {
  if (sessions.size === 0) return;

  log.info(`Clearing all ${sessions.size} session(s) - desktop unreachable`);
  sessions.clear();
  releaseKeepAwake();
  persistSessions();
  notifySessionsChanged();
}

/**
 * Checks if a tab has an active session.
 * @param tabId - The Chrome tab ID
 * @returns True if the tab has an active session
 */
export function hasSession(tabId: number): boolean {
  return sessions.has(tabId);
}

/**
 * Gets the session for a specific tab.
 * @param tabId - The Chrome tab ID
 * @returns The session or undefined if not found
 */
export function getSession(tabId: number): ActiveCastSession | undefined {
  return sessions.get(tabId);
}

/**
 * Finds a session by speaker IP address.
 * Used when Sonos reports a source change to find the affected cast.
 * Searches within the speakerIps array for multi-group support.
 * @param speakerIp - The speaker IP address
 * @returns The session or undefined if not found
 */
export function getSessionBySpeakerIp(speakerIp: string): ActiveCastSession | undefined {
  for (const session of sessions.values()) {
    if (session.speakerIps.includes(speakerIp)) {
      return session;
    }
  }
  return undefined;
}

/**
 * Removes a specific speaker from a session.
 * Used for partial speaker removal when one speaker changes source externally.
 * If no speakers remain, the entire session is removed.
 * @param tabId - The tab ID of the session
 * @param speakerIp - The speaker IP address to remove
 * @returns True if the speaker was removed, false if not found
 */
export function removeSpeakerFromSession(tabId: number, speakerIp: string): boolean {
  const session = sessions.get(tabId);
  if (!session) return false;

  const index = session.speakerIps.indexOf(speakerIp);
  if (index === -1) return false;

  // Remove the speaker and its name
  session.speakerIps.splice(index, 1);
  session.speakerNames.splice(index, 1);

  // Clean up originalGroups and ipToOriginalGroup cache
  if (session.originalGroups) {
    for (const group of session.originalGroups) {
      const ipIndex = group.speakerIps.indexOf(speakerIp);
      if (ipIndex !== -1) {
        group.speakerIps.splice(ipIndex, 1);
      }
    }
    // Remove empty groups
    session.originalGroups = session.originalGroups.filter((g) => g.speakerIps.length > 0);
    if (session.originalGroups.length === 0) {
      session.originalGroups = undefined;
    }
  }
  if (session.ipToOriginalGroup) {
    session.ipToOriginalGroup.delete(speakerIp);
    if (session.ipToOriginalGroup.size === 0) {
      session.ipToOriginalGroup = undefined;
    }
  }

  // If no speakers left, remove the entire session
  if (session.speakerIps.length === 0) {
    removeSession(tabId);
    log.info(`Removed last speaker from session, session ended for tab ${tabId}`);
    return true;
  }

  persistSessions();
  notifySessionsChanged();
  log.info(
    `Removed speaker ${speakerIp} from session for tab ${tabId}, ${session.speakerIps.length} speaker(s) remaining`,
  );
  return true;
}

/**
 * Finds a session by stream ID.
 * Used when the desktop app reports a stream ended to find the affected cast.
 * @param streamId - The stream ID from the server
 * @returns The session or undefined if not found
 */
export function getSessionByStreamId(streamId: string): ActiveCastSession | undefined {
  for (const session of sessions.values()) {
    if (session.streamId === streamId) {
      return session;
    }
  }
  return undefined;
}

/**
 * Updates a session with original groups data.
 * Called after receiving PLAYBACK_RESULTS with originalGroups when syncSpeakers is enabled.
 * Builds the IP → coordinatorUuid lookup table for efficient volume routing.
 * @param tabId - The tab ID of the session
 * @param originalGroups - The original groups from PLAYBACK_RESULTS
 */
export function setSessionOriginalGroups(tabId: number, originalGroups: OriginalGroup[]): void {
  const session = sessions.get(tabId);
  if (!session) return;

  session.originalGroups = originalGroups;
  session.ipToOriginalGroup = buildIpToGroupLookup(originalGroups);
  persistSessions();
  log.info(
    `Set original groups for tab ${tabId}: ${originalGroups.length} group(s), ${session.ipToOriginalGroup.size} IP(s) mapped`,
  );
}

/**
 * Gets the original group coordinator UUID for a speaker IP within a session.
 * Returns undefined if not in a sync session or speaker not found.
 * @param tabId - The tab ID of the session
 * @param speakerIp - The speaker IP to look up
 * @returns The coordinator UUID or undefined
 */
export function getOriginalGroupForSpeaker(tabId: number, speakerIp: string): string | undefined {
  const session = sessions.get(tabId);
  return session?.ipToOriginalGroup?.get(speakerIp);
}

/**
 * Gets all active sessions.
 * @returns Array of all active sessions
 */
export function getAllSessions(): ActiveCastSession[] {
  return Array.from(sessions.values());
}

/**
 * Gets the number of active sessions.
 * @returns The session count
 */
export function getSessionCount(): number {
  return sessions.size;
}

/**
 * Gets all tab IDs with active sessions.
 * @returns Array of tab IDs
 */
export function getActiveTabIds(): number[] {
  return Array.from(sessions.keys());
}

/**
 * Creates an ActiveCast object by combining session data with cached media state.
 * @param session - The active cast session
 * @returns The complete ActiveCast object for display
 */
function toActiveCast(session: ActiveCastSession): ActiveCast {
  // Get cached media state or create a minimal fallback
  const mediaState: TabMediaState = getCachedState(session.tabId) ?? {
    tabId: session.tabId,
    tabTitle: 'Unknown Tab',
    tabFavicon: undefined,
    tabOgImage: undefined,
    metadata: null,
    supportedActions: [],
    playbackState: 'none',
    updatedAt: Date.now(),
  };

  return {
    streamId: session.streamId,
    tabId: session.tabId,
    mediaState,
    speakerIps: session.speakerIps,
    speakerNames: session.speakerNames,
    encoderConfig: session.encoderConfig,
    startedAt: session.startedAt,
  };
}

/**
 * Converts all sessions to ActiveCast array for popup display.
 * Combines session data with cached media state.
 * @returns Array of ActiveCast objects
 */
export function getActiveCasts(): ActiveCast[] {
  return Array.from(sessions.values()).map(toActiveCast);
}

/**
 * Notifies popup that sessions have changed.
 * Called after session registration or removal.
 */
function notifySessionsChanged(): void {
  notifyPopup({
    type: 'ACTIVE_CASTS_CHANGED',
    casts: getActiveCasts(),
  });
}

/**
 * Called when metadata updates for a casting tab.
 * Notifies popup so it can update the display.
 * @param tabId - The tab ID that had metadata updated
 */
export function onMetadataUpdate(tabId: number): void {
  if (sessions.has(tabId)) {
    notifySessionsChanged();
  }
}

/**
 * Persists sessions to session storage immediately.
 * Uses storage.persist() directly (not schedule()) for critical data.
 */
function persistSessions(): void {
  storage.persist();
}
