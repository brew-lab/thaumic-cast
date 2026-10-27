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

import type { ActiveCast, EncoderConfig, TabMediaState } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import { getCachedState } from './metadata-cache';
import { notifyPopup } from './notification-service';
import { persistenceManager } from './persistence-manager';
import { captureHealthBroadcast, clearCaptureHealthForTab } from './capture-health-state';
import { clearAllIngestGaps, clearIngestGaps, ingestGapsBroadcast } from './ingest-gaps-state';
import { castMovedBroadcast, clearAllCastMoved, clearCastMoved } from './cast-moved-state';
import {
  clearAllSpeakerHealth,
  clearSpeakerHealth,
  speakerHealthBroadcast,
} from './speaker-health-state';

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
  /** The rooms the user chose (player UUIDs), in order. */
  roomIds: string[];
  /** The target (a speakerIps entry) each chosen room plays through, keyed by room id. */
  roomTargets: Record<string, string>;
  /** Encoder configuration used */
  encoderConfig: EncoderConfig;
  /** Timestamp when cast started */
  startedAt: number;
  /**
   * Whether the cast plays as one Sonos group: regrouped by a companion that regroups (or
   * joined by an older extension's "Play speakers as one group").
   */
  syncSpeakers: boolean;
  /** Capture mode used for this session */
  captureMode: 'tab' | 'browser';
  /**
   * Whether the cast was started with video sync on. The companion latches
   * its measuring for video sync at the start of playback, so this, not the
   * setting as it stands now, says whether the cast's controls can work.
   */
  videoSync: boolean;
  /**
   * Whether video sync is switched on for this cast from its card. Starts on
   * for a cast started with video sync (the setting is the opt-in), and
   * means nothing without {@link videoSync}.
   */
  videoSyncOn: boolean;
}

/** In-memory storage of active sessions by tab ID */
/** The rooms a session was started for. */
export interface SessionRooms {
  /** The chosen rooms (player UUIDs), in order. */
  ids: string[];
  /** The target each plays through, keyed by room id. */
  targets: Record<string, string>;
}

const sessions = new Map<number, ActiveCastSession>();

/**
 * Debounced storage for session persistence, registered with manager.
 * Uses immediate persist() calls (not schedule()) since session data is critical
 * and changes are infrequent.
 */
const storage = persistenceManager.register<[number, ActiveCastSession][]>(
  {
    storageKey: 'activeSessions',
    debounceMs: 0, // Not used - we call persist() directly for immediate writes
    loggerName: 'SessionManager',
    serialize: () => Array.from(sessions.entries()),
    restore: (stored) => {
      if (!Array.isArray(stored)) return undefined;

      // Migrate old session formats
      const migrated = (stored as [number, ActiveCastSession][]).map(([tabId, session]) => {
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
        // Default captureMode to 'tab' for sessions created before this field existed
        if (!session.captureMode) {
          session.captureMode = 'tab';
        }
        // A session stored before this field existed says nothing about how it
        // started, so it gets no video sync controls
        if (session.videoSync === undefined) {
          session.videoSync = false;
        }
        if (session.videoSyncOn === undefined) {
          session.videoSyncOn = session.videoSync;
        }
        // A session stored before rooms names none
        if (!Array.isArray(session.roomIds)) session.roomIds = [];
        if (!session.roomTargets) session.roomTargets = {};
        return [tabId, session] as [number, ActiveCastSession];
      });

      return migrated;
    },
  },
  (data) => {
    if (data && data.length > 0) {
      sessions.clear();
      for (const [tabId, session] of data) {
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
 * @param syncSpeakers - Whether the cast plays as one Sonos group
 * @param captureMode - Whether this session uses tab or browser-wide capture
 * @param videoSync - Whether the cast was started with video sync on
 * @param rooms - The rooms the user chose, and the target each plays through
 */
export function registerSession(
  tabId: number,
  streamId: string,
  speakerIps: string[],
  speakerNames: string[],
  encoderConfig: EncoderConfig,
  syncSpeakers: boolean,
  captureMode: 'tab' | 'browser' = 'tab',
  videoSync = false,
  rooms: SessionRooms = { ids: [], targets: {} },
): void {
  const wasEmpty = sessions.size === 0;

  // Own copies: removeSpeakerFromSession splices these in place, so sharing
  // the caller's arrays would let a later removal reach into whatever else
  // still holds them (a request payload, a popup snapshot).
  sessions.set(tabId, {
    streamId,
    tabId,
    speakerIps: [...speakerIps],
    speakerNames: [...speakerNames],
    roomIds: [...rooms.ids],
    roomTargets: { ...rooms.targets },
    encoderConfig,
    startedAt: Date.now(),
    syncSpeakers,
    captureMode,
    videoSync,
    videoSyncOn: videoSync,
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

    // Drop any capture-health state tied to this session so the popup's
    // alert clears as soon as the cast stops.
    if (clearCaptureHealthForTab(tabId)) {
      notifyPopup(captureHealthBroadcast());
    }
    dropReadingsForSpeakers(session.speakerIps);
    if (clearIngestGaps(session.streamId)) {
      notifyPopup(ingestGapsBroadcast());
    }
    if (clearCastMoved(session.streamId)) {
      notifyPopup(castMovedBroadcast());
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
  if (clearAllSpeakerHealth()) {
    notifyPopup(speakerHealthBroadcast());
  }
  if (clearAllIngestGaps()) {
    notifyPopup(ingestGapsBroadcast());
  }
  if (clearAllCastMoved()) {
    notifyPopup(castMovedBroadcast());
  }
  persistSessions();
  notifySessionsChanged();
}

/**
 * Drops speaker-health readings for speakers that no longer belong to any
 * active cast. The companion only reports on speakers playing a stream, so a
 * reading outlives its usefulness the moment the speaker leaves the cast.
 * @param speakerIps - Speakers that just left a session
 */
function dropReadingsForSpeakers(speakerIps: readonly string[]): void {
  let changed = false;
  for (const speakerIp of speakerIps) {
    if (getSessionBySpeakerIp(speakerIp)) continue;
    if (clearSpeakerHealth(speakerIp)) changed = true;
  }
  if (changed) {
    notifyPopup(speakerHealthBroadcast());
  }
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
 * Adds speakers and rooms to a running session (ADD_ROOMS). Speakers and
 * rooms it already has are skipped.
 * @param tabId - The tab ID of the session
 * @param speakerIps - The new targets that began playing
 * @param speakerNames - Their display names (parallel array)
 * @param rooms - The rooms added, and the target each plays through
 * @returns True if the session exists
 */
export function addToSession(
  tabId: number,
  speakerIps: string[],
  speakerNames: string[],
  rooms: SessionRooms,
): boolean {
  const session = sessions.get(tabId);
  if (!session) return false;

  speakerIps.forEach((ip, index) => {
    if (session.speakerIps.includes(ip)) return;
    session.speakerIps.push(ip);
    session.speakerNames.push(speakerNames[index] ?? ip);
  });
  for (const id of rooms.ids) {
    if (!session.roomIds.includes(id)) session.roomIds.push(id);
    const target = rooms.targets[id];
    if (target) session.roomTargets[id] = target;
  }

  persistSessions();
  notifySessionsChanged();
  log.info(`Added ${rooms.ids.length} room(s) to the session for tab ${tabId}`);
  return true;
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

  // Remove the speaker, its name and the rooms it played for
  session.speakerIps.splice(index, 1);
  session.speakerNames.splice(index, 1);
  session.roomIds = session.roomIds.filter((id) => session.roomTargets[id] !== speakerIp);
  for (const [id, target] of Object.entries(session.roomTargets)) {
    if (target === speakerIp) delete session.roomTargets[id];
  }

  // If no speakers left, remove the entire session
  if (session.speakerIps.length === 0) {
    removeSession(tabId);
    log.info(`Removed last speaker from session, session ended for tab ${tabId}`);
    return true;
  }

  dropReadingsForSpeakers([speakerIp]);
  persistSessions();
  notifySessionsChanged();
  log.info(
    `Removed speaker ${speakerIp} from session for tab ${tabId}, ${session.speakerIps.length} speaker(s) remaining`,
  );
  return true;
}

/**
 * Switches video sync on or off for a cast, from its card.
 * @param tabId - The tab ID of the session
 * @param on - On or off
 * @returns True when the session exists
 */
export function setVideoSyncOn(tabId: number, on: boolean): boolean {
  const session = sessions.get(tabId);
  if (!session) return false;
  if (session.videoSyncOn !== on) {
    session.videoSyncOn = on;
    persistSessions();
  }
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
 * Checks if any active session uses tab capture mode.
 * @returns True if at least one tab capture session exists
 */
export function hasTabCaptureSessions(): boolean {
  for (const session of sessions.values()) {
    if (session.captureMode === 'tab') return true;
  }
  return false;
}

/**
 * Checks if any active session uses browser-wide capture mode.
 * @returns True if at least one browser capture session exists
 */
export function hasBrowserCaptureSessions(): boolean {
  for (const session of sessions.values()) {
    if (session.captureMode === 'browser') return true;
  }
  return false;
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
    roomIds: session.roomIds,
    encoderConfig: session.encoderConfig,
    startedAt: session.startedAt,
    syncSpeakers: session.syncSpeakers,
    videoSync: session.videoSync,
    captureMode: session.captureMode,
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
