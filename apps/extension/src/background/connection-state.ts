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

const log = createLogger('ConnectionState');

/** Storage key for session persistence */
const STORAGE_KEY = 'connectionState';

/** Network health status from desktop app */
export type NetworkHealthStatus = 'ok' | 'degraded';

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
  /** Network health status from desktop (speakers responding, etc.) */
  networkHealth: NetworkHealthStatus;
  /** Reason for degraded network health (null if healthy) */
  networkHealthReason: string | null;
}

/** Current connection state */
let state: ConnectionState = {
  connected: false,
  desktopAppUrl: null,
  maxStreams: null,
  lastDiscoveredAt: null,
  lastError: null,
  networkHealth: 'ok',
  networkHealthReason: null,
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
 * Updates network health status from the desktop app.
 * @param health - The network health status ('ok' or 'degraded')
 * @param reason - The reason for degraded health (null if healthy)
 */
export function setNetworkHealth(health: NetworkHealthStatus, reason: string | null): void {
  state = {
    ...state,
    networkHealth: health,
    networkHealthReason: reason,
  };
  schedulePersist();
}

/**
 * Clears connection state when desktop app is not found.
 * Sets lastError to the i18n key for the popup to translate.
 */
export function clearConnectionState(): void {
  state = {
    connected: false,
    desktopAppUrl: null,
    maxStreams: null,
    lastDiscoveredAt: null,
    lastError: 'error_desktop_not_found',
    networkHealth: 'ok',
    networkHealthReason: null,
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
      const stored = result[STORAGE_KEY];
      // Merge with defaults to handle new fields added in updates
      state = {
        connected: stored.connected ?? false,
        desktopAppUrl: stored.desktopAppUrl ?? null,
        maxStreams: stored.maxStreams ?? null,
        lastDiscoveredAt: stored.lastDiscoveredAt ?? null,
        lastError: stored.lastError ?? null,
        networkHealth: stored.networkHealth ?? 'ok',
        networkHealthReason: stored.networkHealthReason ?? null,
      };
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
