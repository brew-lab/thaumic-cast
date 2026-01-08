/**
 * Connection Routes
 *
 * Handles message routing for WebSocket and connection management:
 * - GET_CONNECTION_STATUS, ENSURE_CONNECTION, WS_CONNECT, WS_DISCONNECT, WS_RECONNECT
 */

import { registerRoute } from '../router';
import { getConnectionState } from '../connection-state';
import { ensureConnection, handleWsConnectRequest } from '../handlers/connection';
import { sendToOffscreen } from '../offscreen-manager';
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

  registerRoute('WS_CONNECT', async (msg) => {
    const validated = WsConnectMessageSchema.parse(msg);
    await handleWsConnectRequest(validated.url, validated.maxStreams);
    return { success: true };
  });

  registerRoute('WS_DISCONNECT', async () => {
    await sendToOffscreen({ type: 'WS_DISCONNECT' });
    return { success: true };
  });

  registerRoute('WS_RECONNECT', async (msg) => {
    const validated = WsReconnectMessageSchema.parse(msg);
    await sendToOffscreen(validated);
    return { success: true };
  });
}
