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

/** WS_CONNECT message with optional maxStreams (not in base type) */
interface WsConnectMessageWithMaxStreams {
  type: 'WS_CONNECT';
  url: string;
  maxStreams?: number;
}

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
    const { url, maxStreams } = msg as WsConnectMessageWithMaxStreams;
    await handleWsConnectRequest(url, maxStreams);
    return { success: true };
  });

  registerRoute('WS_DISCONNECT', async (msg) => {
    await sendToOffscreen(msg);
    return { success: true };
  });

  registerRoute('WS_RECONNECT', async (msg) => {
    await sendToOffscreen(msg);
    return { success: true };
  });
}
