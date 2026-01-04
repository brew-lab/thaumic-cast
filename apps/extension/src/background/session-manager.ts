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
import { getCachedState } from './metadata-cache';
import { createLogger } from '@thaumic-cast/shared';

const log = createLogger('SessionManager');

/** Session storage key for persistence */
const STORAGE_KEY = 'activeSessions';

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
}

/** In-memory storage of active sessions by tab ID */
const sessions = new Map<number, ActiveCastSession>();

/**
 * Registers a new cast session.
 * @param tabId - The Chrome tab ID being captured
 * @param streamId - Unique stream ID from server
 * @param speakerIps - Target speaker IP addresses (multi-group support)
 * @param speakerNames - Speaker display names (parallel array)
 * @param encoderConfig - Encoder configuration used
 */
export function registerSession(
  tabId: number,
  streamId: string,
  speakerIps: string[],
  speakerNames: string[],
  encoderConfig: EncoderConfig,
): void {
  const wasEmpty = sessions.size === 0;

  sessions.set(tabId, {
    streamId,
    tabId,
    speakerIps,
    speakerNames,
    encoderConfig,
    startedAt: Date.now(),
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
  if (sessions.delete(tabId)) {
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
  chrome.runtime
    .sendMessage({
      type: 'ACTIVE_CASTS_CHANGED',
      casts: getActiveCasts(),
    })
    .catch(() => {
      // Popup may not be open
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
 * Persists sessions to session storage.
 */
async function persistSessions(): Promise<void> {
  try {
    await chrome.storage.session.set({
      [STORAGE_KEY]: Array.from(sessions.entries()),
    });
    log.debug(`Persisted ${sessions.size} sessions`);
  } catch (err) {
    log.error('Persist failed:', err);
  }
}

/**
 * Restores sessions from session storage.
 * Call on service worker startup.
 * Includes migration from old single-speaker format to multi-speaker arrays.
 */
export async function restoreSessions(): Promise<void> {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    const data = result[STORAGE_KEY];
    if (Array.isArray(data)) {
      sessions.clear();
      for (const [tabId, session] of data) {
        // Migrate old single-speaker format to multi-speaker arrays
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const legacySession = session as any;
        if (legacySession.speakerIp && !legacySession.speakerIps) {
          session.speakerIps = [legacySession.speakerIp];
          session.speakerNames = [legacySession.speakerName || legacySession.speakerIp];
          delete legacySession.speakerIp;
          delete legacySession.speakerName;
          log.info(`Migrated session for tab ${tabId} from single to multi-speaker format`);
        }
        sessions.set(tabId, session);
      }
      if (sessions.size > 0) {
        log.info(`Restored ${sessions.size} sessions`);
        // Re-request keep-awake for restored sessions
        requestKeepAwake();
      }
    }
  } catch (err) {
    log.error('Restore failed:', err);
  }
}
