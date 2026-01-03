/**
 * Desktop App Connection State Module
 *
 * Pure state management for desktop app connection.
 *
 * Responsibilities:
 * - Cache connection status for instant popup display
 * - Store discovered desktop app URL
 * - Persist to session storage for service worker recovery
 *
 * Non-responsibilities:
 * - WebSocket lifecycle management
 * - Message passing
 */

import { createLogger } from '@thaumic-cast/shared';
import i18n from '../lib/i18n';

const log = createLogger('ConnectionState');

/** Storage key for session persistence */
const STORAGE_KEY = 'connectionState';

/**
 * Connection state snapshot.
 */
export interface ConnectionState {
  /** Whether WebSocket is currently connected */
  connected: boolean;
  /** Desktop app base URL (null if never discovered) */
  desktopAppUrl: string | null;
  /** Maximum concurrent streams allowed by the server */
  maxStreams: number | null;
  /** Last successful discovery timestamp */
  lastDiscoveredAt: number | null;
  /** Last connection error (null if none) */
  lastError: string | null;
}

/** Current connection state */
let state: ConnectionState = {
  connected: false,
  desktopAppUrl: null,
  maxStreams: null,
  lastDiscoveredAt: null,
  lastError: null,
};

/** Debounce timer for persistence */
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Gets the current connection state (read-only copy).
 * @returns A copy of the current ConnectionState
 */
export function getConnectionState(): ConnectionState {
  return { ...state };
}

/**
 * Updates the connected status.
 * Clears error on successful connection.
 * @param connected - Whether WebSocket is connected
 */
export function setConnected(connected: boolean): void {
  state = {
    ...state,
    connected,
    lastError: connected ? null : state.lastError,
  };
  schedulePersist();
}

/**
 * Sets the discovered desktop app info.
 * @param url - The desktop app base URL
 * @param maxStreams - Maximum concurrent streams allowed
 */
export function setDesktopApp(url: string, maxStreams: number): void {
  state = {
    ...state,
    desktopAppUrl: url,
    maxStreams,
    lastDiscoveredAt: Date.now(),
    lastError: null,
  };
  schedulePersist();
}

/**
 * Sets a connection error.
 * @param error - The error message
 */
export function setConnectionError(error: string): void {
  state = {
    ...state,
    connected: false,
    lastError: error,
  };
  schedulePersist();
}

/**
 * Clears connection state when desktop app is not found.
 */
export function clearConnectionState(): void {
  state = {
    connected: false,
    desktopAppUrl: null,
    maxStreams: null,
    lastDiscoveredAt: null,
    lastError: i18n.t('error_desktop_not_found'),
  };
  schedulePersist();
}

/**
 * Schedules a debounced persist to session storage.
 * Prevents excessive writes during rapid state changes.
 */
function schedulePersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(persist, 300);
}

/**
 * Persists current state to session storage.
 */
async function persist(): Promise<void> {
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: state });
    log.debug('Persisted connection state');
  } catch (err) {
    log.error('Persist failed:', err);
  }
}

/**
 * Restores state from session storage.
 * Call on service worker startup.
 */
export async function restoreConnectionState(): Promise<void> {
  try {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    if (result[STORAGE_KEY]) {
      state = result[STORAGE_KEY];
      log.info(
        'Restored connection state:',
        state.connected ? 'connected' : 'disconnected',
        state.desktopAppUrl ? `(${state.desktopAppUrl})` : '',
      );
    }
  } catch (err) {
    log.error('Restore failed:', err);
  }
}
