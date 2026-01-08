/**
 * Control WebSocket Connection Module
 *
 * Manages the WebSocket connection to the desktop app for:
 * - State monitoring (INITIAL_STATE, events)
 * - Control commands (volume, mute)
 * - Heartbeat to keep connection alive
 *
 * Responsibilities:
 * - WebSocket lifecycle (connect, reconnect, disconnect)
 * - Heartbeat management
 * - Command sending
 * - State caching for service worker recovery
 *
 * Non-responsibilities:
 * - Audio streaming (handled by StreamSession)
 * - Message routing (handled by handlers.ts)
 */

import { createLogger } from '@thaumic-cast/shared';
import type { SonosStateSnapshot, WsControlCommand } from '@thaumic-cast/protocol';
import type { WsStatusResponse } from '../lib/messages';

const log = createLogger('Offscreen');

const MAX_RECONNECT_ATTEMPTS = 10;
/** Heartbeat interval (5 seconds - server timeout is 10s) */
const CONTROL_HEARTBEAT_INTERVAL = 5000;

interface ControlConnection {
  ws: WebSocket | null;
  url: string;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

/** Control WebSocket connection state. */
let controlConnection: ControlConnection | null = null;

/** Cached Sonos state for service worker recovery. */
let cachedSonosState: SonosStateSnapshot | null = null;

/**
 * Connects the control WebSocket to the desktop app.
 * @param url - The WebSocket URL to connect to
 */
export function connectControlWebSocket(url: string): void {
  if (controlConnection?.ws?.readyState === WebSocket.OPEN) {
    log.info('Control WS already connected');
    return;
  }

  log.info(`Connecting control WebSocket to: ${url}`);

  const ws = new WebSocket(url);

  controlConnection = {
    ws,
    url,
    reconnectAttempts: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
  };

  ws.onopen = () => {
    log.info('Control WebSocket connected');
    if (controlConnection) {
      controlConnection.reconnectAttempts = 0;
      // Start heartbeat to keep connection alive
      startControlHeartbeat();
    }
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return;

    try {
      const message = JSON.parse(event.data);
      log.debug('Control WS received:', message.type || message.category);

      // INITIAL_STATE on connect
      if (message.type === 'INITIAL_STATE') {
        cachedSonosState = message.payload as SonosStateSnapshot;
        chrome.runtime
          .sendMessage({
            type: 'WS_CONNECTED',
            state: cachedSonosState,
          })
          .catch(() => {
            // Background may be suspended
          });
      }
      // Network broadcast events (separate category)
      else if (message.category === 'network') {
        chrome.runtime
          .sendMessage({
            type: 'NETWORK_EVENT',
            payload: message,
          })
          .catch(() => {
            // Background may be suspended
          });
      }
      // Topology broadcast events (discovery results)
      else if (message.category === 'topology') {
        chrome.runtime
          .sendMessage({
            type: 'TOPOLOGY_EVENT',
            payload: message,
          })
          .catch(() => {
            // Background may be suspended
          });
      }
      // Broadcast events (sonos/stream)
      else if (message.category) {
        chrome.runtime
          .sendMessage({
            type: 'SONOS_EVENT',
            payload: message,
          })
          .catch(() => {
            // Background may be suspended
          });
      }
    } catch (err) {
      log.warn('Failed to parse control WS message:', err);
    }
  };

  ws.onclose = () => {
    log.warn('Control WebSocket closed');
    // Stop heartbeat
    stopControlHeartbeat();
    // Notify background immediately so UI updates
    chrome.runtime.sendMessage({ type: 'WS_DISCONNECTED' }).catch(() => {});
    attemptControlReconnect();
  };

  ws.onerror = (error) => {
    log.error('Control WebSocket error:', error);
  };
}

/**
 * Attempts to reconnect the control WebSocket with exponential backoff.
 */
function attemptControlReconnect(): void {
  if (!controlConnection) return;

  controlConnection.reconnectAttempts++;

  if (controlConnection.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    log.error('Control WS max reconnect attempts exceeded');
    chrome.runtime.sendMessage({ type: 'WS_PERMANENTLY_DISCONNECTED' }).catch(() => {});
    controlConnection = null;
    return;
  }

  const delay = Math.min(500 * Math.pow(2, controlConnection.reconnectAttempts - 1), 5000);
  log.info(
    `Reconnecting control WS in ${delay}ms (attempt ${controlConnection.reconnectAttempts})...`,
  );

  controlConnection.reconnectTimer = setTimeout(() => {
    if (controlConnection) {
      connectControlWebSocket(controlConnection.url);
    }
  }, delay);
}

/**
 * Starts the control WebSocket heartbeat timer.
 */
function startControlHeartbeat(): void {
  stopControlHeartbeat(); // Clear any existing timer
  if (!controlConnection) return;

  controlConnection.heartbeatTimer = setInterval(() => {
    if (controlConnection?.ws?.readyState === WebSocket.OPEN) {
      controlConnection.ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }
  }, CONTROL_HEARTBEAT_INTERVAL);
}

/**
 * Stops the control WebSocket heartbeat timer.
 */
function stopControlHeartbeat(): void {
  if (controlConnection?.heartbeatTimer) {
    clearInterval(controlConnection.heartbeatTimer);
    controlConnection.heartbeatTimer = null;
  }
}

/**
 * Disconnects the control WebSocket.
 */
export function disconnectControlWebSocket(): void {
  if (!controlConnection) return;

  log.info('Disconnecting control WebSocket');

  stopControlHeartbeat();

  if (controlConnection.reconnectTimer) {
    clearTimeout(controlConnection.reconnectTimer);
  }

  controlConnection.ws?.close();
  controlConnection = null;
}

/**
 * Sends a control command via WebSocket.
 * @param command - The typed command to send (from @thaumic-cast/protocol)
 * @returns True if the command was sent successfully
 */
export function sendControlCommand(command: WsControlCommand): boolean {
  if (!controlConnection?.ws || controlConnection.ws.readyState !== WebSocket.OPEN) {
    log.warn('Control WS not connected, cannot send command');
    return false;
  }

  controlConnection.ws.send(JSON.stringify(command));
  return true;
}

/**
 * Returns current WebSocket status for background queries.
 * @returns The current WebSocket status
 */
export function getWsStatus(): WsStatusResponse {
  return {
    connected: controlConnection?.ws?.readyState === WebSocket.OPEN,
    url: controlConnection?.url,
    reconnectAttempts: controlConnection?.reconnectAttempts ?? 0,
    state: cachedSonosState ?? undefined,
  };
}

/**
 * Gets the current control connection for reconnect handling.
 * @returns The control connection or null
 */
export function getControlConnection(): ControlConnection | null {
  return controlConnection;
}

/**
 * Updates the cached Sonos state (for sync from background).
 * @param state - The Sonos state to cache
 */
export function setCachedSonosState(state: SonosStateSnapshot): void {
  cachedSonosState = state;
}
