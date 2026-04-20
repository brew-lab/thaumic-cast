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

import { type AppType } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import { persistenceManager } from './persistence-manager';

const log = createLogger('ConnectionState');

/** Network health status from desktop app */
export type NetworkHealthStatus = 'ok' | 'degraded';

/**
 * Connection state snapshot.
 *
 * Includes companion version metadata (`appType`, `appVersion`,
 * `protocolVersion`) so the popup and About surface can describe the
 * connection without a separate storage key. `appType` is populated at
 * discovery time from `/health`; `appVersion`/`protocolVersion` arrive on
 * the WebSocket via `INITIAL_STATE`. All three are nullable: pre-0.4.0
 * companions don't advertise them.
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
  /** Which companion is connected (desktop/server). Null on pre-0.4.0 builds. */
  appType: AppType | null;
  /** Companion app semver. Null on pre-0.4.0 builds. */
  appVersion: string | null;
  /** Wire-protocol semver advertised by the companion. Null on pre-0.4.0 builds. */
  protocolVersion: string | null;
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
  appType: null,
  appVersion: null,
  protocolVersion: null,
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
        appType: s.appType ?? null,
        appVersion: s.appVersion ?? null,
        protocolVersion: s.protocolVersion ?? null,
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
 *
 * `appType` is supplied when `/health` reports it (≥0.4.0 companions). Older
 * companions return undefined here; the extension treats that as "unknown"
 * until `INITIAL_STATE` arrives (it'll likely be unknown there too for
 * pre-0.4.0 builds).
 *
 * @param url - The desktop app base URL
 * @param maxStreams - Maximum concurrent streams allowed
 * @param appType - Companion type from `/health`, or undefined if not reported
 */
export function setDesktopApp(url: string, maxStreams: number, appType?: AppType): void {
  state = {
    ...state,
    desktopAppUrl: url,
    maxStreams,
    lastDiscoveredAt: Date.now(),
    lastError: null,
    appType: appType ?? state.appType,
  };
  storage.schedule();
}

/**
 * Records companion version metadata captured from `INITIAL_STATE`.
 *
 * Called whenever the WebSocket (re)connects. `appType` is allowed to be
 * `undefined`/`null` here; we keep any value previously set by `/health` in
 * that case so we don't regress to "unknown" on a transient disconnect.
 *
 * @param metadata - Version fields reported by the companion
 * @param metadata.appType - Companion type (`desktop` | `server`), or null/undefined when absent
 * @param metadata.appVersion - Companion app semver, or null when absent (pre-0.4.0)
 * @param metadata.protocolVersion - Wire-protocol semver, or null when absent (pre-0.4.0)
 */
export function setConnectionMetadata(metadata: {
  appType: AppType | null | undefined;
  appVersion: string | null;
  protocolVersion: string | null;
}): void {
  state = {
    ...state,
    appType: metadata.appType ?? state.appType,
    appVersion: metadata.appVersion,
    protocolVersion: metadata.protocolVersion,
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
    appType: null,
    appVersion: null,
    protocolVersion: null,
  };
  storage.schedule();
}
