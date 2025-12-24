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

/**
 * Internal representation of an active cast session.
 */
interface ActiveCastSession {
  /** Unique stream ID from server */
  streamId: string;
  /** Tab ID being captured */
  tabId: number;
  /** Target speaker IP address */
  speakerIp: string;
  /** Speaker/group display name */
  speakerName?: string;
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
 * @param speakerIp - Target speaker IP address
 * @param speakerName - Optional speaker display name
 * @param encoderConfig - Encoder configuration used
 */
export function registerSession(
  tabId: number,
  streamId: string,
  speakerIp: string,
  speakerName: string | undefined,
  encoderConfig: EncoderConfig,
): void {
  sessions.set(tabId, {
    streamId,
    tabId,
    speakerIp,
    speakerName,
    encoderConfig,
    startedAt: Date.now(),
  });
  persistSessions();
  notifySessionsChanged();
  log.info(`Registered session for tab ${tabId}, stream ${streamId}`);
}

/**
 * Removes a cast session.
 * @param tabId - The Chrome tab ID to remove
 */
export function removeSession(tabId: number): void {
  if (sessions.delete(tabId)) {
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
 * @param speakerIp - The speaker IP address
 * @returns The session or undefined if not found
 */
export function getSessionBySpeakerIp(speakerIp: string): ActiveCastSession | undefined {
  for (const session of sessions.values()) {
    if (session.speakerIp === speakerIp) {
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
    metadata: null,
    updatedAt: Date.now(),
  };

  return {
    streamId: session.streamId,
    tabId: session.tabId,
    mediaState,
    speakerIp: session.speakerIp,
    speakerName: session.speakerName,
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
 */
export async function restoreSessions(): Promise<void> {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    const data = result[STORAGE_KEY];
    if (Array.isArray(data)) {
      sessions.clear();
      for (const [tabId, session] of data) {
        sessions.set(tabId, session);
      }
      if (sessions.size > 0) {
        log.info(`Restored ${sessions.size} sessions`);
      }
    }
  } catch (err) {
    log.error('Restore failed:', err);
  }
}
