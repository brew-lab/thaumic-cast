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
import { persistenceManager } from './persistence-manager';

const log = createLogger('ConnectionState');

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

/**
 * Debounced storage for persistence, registered with manager.
 * Includes migration support for new fields added in updates.
 */
const storage = persistenceManager.register<ConnectionState>(
  {
    storageKey: 'connectionState',
    debounceMs: 300,
    loggerName: 'ConnectionState',
    serialize: () => state,
    restore: (stored): ConnectionState | undefined => {
      if (!stored || typeof stored !== 'object') return undefined;
      const s = stored as Partial<ConnectionState>;
      // Merge with defaults to handle new fields added in updates
      return {
        connected: s.connected ?? false,
        desktopAppUrl: s.desktopAppUrl ?? null,
        maxStreams: s.maxStreams ?? null,
        lastDiscoveredAt: s.lastDiscoveredAt ?? null,
        lastError: s.lastError ?? null,
        networkHealth: s.networkHealth ?? 'ok',
        networkHealthReason: s.networkHealthReason ?? null,
      };
    },
  },
  (restored) => {
    if (restored) {
      state = restored;
      log.info(
        'Restored connection state:',
        state.connected ? 'connected' : 'disconnected',
        state.desktopAppUrl ? `(${state.desktopAppUrl})` : '',
      );
    }
  },
);

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
  storage.schedule();
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
  storage.schedule();
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
  storage.schedule();
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
  storage.schedule();
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
  storage.schedule();
}

/**
 * Restores state from session storage.
 * @deprecated Use persistenceManager.restoreAll() instead
 */
export async function restoreConnectionState(): Promise<void> {
  const data = await storage.restore();
  // onRestore callback handles population
  if (data) {
    log.debug('restoreConnectionState called directly (prefer persistenceManager.restoreAll)');
  }
}
