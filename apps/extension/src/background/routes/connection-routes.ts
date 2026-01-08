/**
 * Connection Routes
 *
 * Handles message routing for WebSocket and connection management:
 * - GET_CONNECTION_STATUS, ENSURE_CONNECTION, WS_CONNECT, WS_DISCONNECT, WS_RECONNECT
 */

import { registerRoute, registerValidatedRoute } from '../router';
import { getConnectionState } from '../connection-state';
import { ensureConnection, handleWsConnectRequest } from '../handlers/connection';
import { offscreenBroker } from '../offscreen-broker';
import { WsConnectMessageSchema, WsReconnectMessageSchema } from '../../lib/message-schemas';

/**
 * Registers all connection routes.
 */
export function registerConnectionRoutes(): void {
  registerRoute('GET_CONNECTION_STATUS', () => {
    return getConnectionState();
  });

  registerRoute('ENSURE_CONNECTION', async () => {
    return ensureConnection();
  });

  registerValidatedRoute('WS_CONNECT', WsConnectMessageSchema, async (msg) => {
    await handleWsConnectRequest(msg.url, msg.maxStreams);
    return { success: true };
  });

  registerRoute('WS_DISCONNECT', async () => {
    await offscreenBroker.disconnectWebSocket();
    return { success: true };
  });

  registerValidatedRoute('WS_RECONNECT', WsReconnectMessageSchema, async (msg) => {
    await offscreenBroker.reconnectWebSocket(msg.url);
    return { success: true };
  });
}
