/**
 * Connection Handlers
 *
 * Manages desktop app discovery and WebSocket connection lifecycle.
 *
 * Responsibilities:
 * - Desktop app discovery
 * - WebSocket connection via offscreen
 * - Connection state management
 * - Handle connection events
 *
 * Non-responsibilities:
 * - Offscreen document lifecycle (handled by offscreen-manager.ts)
 * - Sonos state management (handled by sonos-state.ts)
 */

import { createLogger } from '@thaumic-cast/shared';
import type { SonosStateSnapshot } from '@thaumic-cast/protocol';
import type {
  EnsureConnectionResponse,
  NetworkEventMessage,
  TopologyEventMessage,
} from '../../lib/messages';
import { discoverDesktopApp } from '../discovery';
import {
  getConnectionState,
  setConnected,
  setConnectionError,
  clearConnectionState,
  setNetworkHealth,
} from '../connection-state';
import { setSonosState, getSonosState as getStoredSonosState, updateGroups } from '../sonos-state';
import { ensureOffscreen, sendToOffscreen } from '../offscreen-manager';
import { notifyPopup } from '../notify';

const log = createLogger('Background');

/** Result of discovering and caching desktop app info. */
export interface DiscoverResult {
  /** The discovered app URL */
  url: string;
  /** Maximum concurrent streams allowed */
  maxStreams: number;
}

/**
 * Connects to the desktop app WebSocket via offscreen document.
 * @param serverUrl - The desktop app HTTP URL
 */
export async function connectWebSocket(serverUrl: string): Promise<void> {
  await ensureOffscreen();
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
  log.info(`Connecting WebSocket to: ${wsUrl}`);
  await sendToOffscreen({ type: 'WS_CONNECT', url: wsUrl });
}

/**
 * Discovers the desktop app and returns the result.
 * Discovery now updates connection-state internally via setDesktopApp().
 * @param force - Whether to force fresh discovery (ignore cache)
 * @returns The discovered app info, or null if not found
 */
export async function discoverAndCache(force = false): Promise<DiscoverResult | null> {
  const app = await discoverDesktopApp(force);
  if (!app) return null;
  // Note: setDesktopApp is now called inside discoverDesktopApp
  return { url: app.url, maxStreams: app.maxStreams };
}

/**
 * Handles WebSocket connected event from offscreen.
 * @param state - The initial Sonos state from desktop (may include network health)
 */
export function handleWsConnected(state: SonosStateSnapshot): void {
  setConnected(true);
  updateSonosState(state);
  log.info('WebSocket connected');

  // Extract network health from initial state if present
  const stateWithHealth = state as SonosStateSnapshot & {
    networkHealth?: 'ok' | 'degraded';
    networkHealthReason?: string;
  };
  if (stateWithHealth.networkHealth) {
    log.info(
      `Initial network health: ${stateWithHealth.networkHealth}` +
        (stateWithHealth.networkHealthReason ? ` (${stateWithHealth.networkHealthReason})` : ''),
    );
    setNetworkHealth(stateWithHealth.networkHealth, stateWithHealth.networkHealthReason ?? null);
  }

  // Notify popup of state
  notifyPopup({ type: 'WS_STATE_CHANGED', state });
}

/**
 * Handles temporary WebSocket disconnect (will attempt reconnect).
 */
export function handleWsTemporarilyDisconnected(): void {
  setConnected(false);
  log.warn('WebSocket disconnected, reconnecting...');
  notifyPopup({ type: 'WS_CONNECTION_LOST', reason: 'reconnecting' });
}

/**
 * Handles WebSocket permanently disconnected event.
 */
export function handleWsPermanentlyDisconnected(): void {
  setConnectionError('error_connection_lost');
  log.warn('WebSocket permanently disconnected');
  notifyPopup({ type: 'WS_CONNECTION_LOST', reason: 'max_retries_exceeded' });
}

/**
 * Ensures connection to the desktop app.
 * Discovers and connects if needed, returns current connection state.
 * This centralizes all discovery/connection logic in the background.
 * @returns The connection result
 */
export async function ensureConnection(): Promise<EnsureConnectionResponse> {
  const connState = getConnectionState();

  // Already connected - notify popup and return current state
  if (connState.connected) {
    // Send state update in case popup missed the original WS_STATE_CHANGED
    notifyPopup({ type: 'WS_STATE_CHANGED', state: getStoredSonosState() });
    return {
      connected: true,
      desktopAppUrl: connState.desktopAppUrl,
      maxStreams: connState.maxStreams,
      error: null,
    };
  }

  // Have a cached URL - try to reconnect
  if (connState.desktopAppUrl) {
    try {
      await connectWebSocket(connState.desktopAppUrl);
      // Connection is async - return optimistically, WS_STATE_CHANGED will confirm
      return {
        connected: false, // Not yet confirmed, but connecting
        desktopAppUrl: connState.desktopAppUrl,
        maxStreams: connState.maxStreams,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Reconnection failed, will try discovery:', message);
      // Fall through to discovery
    }
  }

  // No cached URL or reconnection failed - discover desktop app
  try {
    const app = await discoverAndCache();
    if (!app) {
      clearConnectionState();
      return {
        connected: false,
        desktopAppUrl: null,
        maxStreams: null,
        error: 'error_desktop_not_found',
      };
    }

    // Connect WebSocket
    await connectWebSocket(app.url);

    // Connection is async - return optimistically
    return {
      connected: false, // Not yet confirmed, but connecting
      desktopAppUrl: app.url,
      maxStreams: app.maxStreams,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Discovery/connection failed:', message);
    return {
      connected: false,
      desktopAppUrl: null,
      maxStreams: null,
      error: message,
    };
  }
}

/**
 * Updates the cached Sonos state and syncs to offscreen for recovery.
 * @param state - The new Sonos state snapshot
 */
function updateSonosState(state: SonosStateSnapshot): void {
  setSonosState(state);
  // Sync to offscreen for service worker recovery
  sendToOffscreen({ type: 'SYNC_SONOS_STATE', state }).catch(() => {});
}

/**
 * Returns the current Sonos state.
 * @returns Object with state (null if no groups discovered)
 */
export function getSonosState(): { state: SonosStateSnapshot | null } {
  const state = getStoredSonosState();
  // Return null if state is empty (no groups)
  const hasState = state.groups.length > 0;
  return { state: hasState ? state : null };
}

/**
 * Handles NETWORK_EVENT from offscreen (network health changes).
 * @param payload - The network event payload
 */
export function handleNetworkEvent(payload: NetworkEventMessage['payload']): void {
  if (payload.type === 'healthChanged') {
    const reason = payload.reason ?? null;
    setNetworkHealth(payload.health, reason);
    notifyPopup({
      type: 'NETWORK_HEALTH_CHANGED',
      health: payload.health,
      reason,
    });
  }
}

/**
 * Handles TOPOLOGY_EVENT from offscreen (group discovery results).
 * @param payload - The topology event payload
 */
export function handleTopologyEvent(payload: TopologyEventMessage['payload']): void {
  if (payload.type === 'groupsDiscovered') {
    const newState = updateGroups(payload.groups);
    notifyPopup({
      type: 'WS_STATE_CHANGED',
      state: newState,
    });
    log.info(`Groups discovered: ${payload.groups.length} groups`);
  }
}
