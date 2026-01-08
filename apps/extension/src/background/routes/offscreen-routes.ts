/**
 * Offscreen Routes
 *
 * Handles message routing for offscreen document communication:
 * - WS_CONNECTED, WS_DISCONNECTED, WS_PERMANENTLY_DISCONNECTED
 * - SONOS_EVENT, NETWORK_EVENT, TOPOLOGY_EVENT
 * - OFFSCREEN_READY, SESSION_DISCONNECTED
 */

import { createLogger } from '@thaumic-cast/shared';
import type { BroadcastEvent } from '@thaumic-cast/protocol';
import { registerRoute } from '../router';
import {
  handleWsConnected,
  handleWsTemporarilyDisconnected,
  handleWsPermanentlyDisconnected,
  handleNetworkEvent,
  handleTopologyEvent,
} from '../handlers/connection';
import { handleSonosEvent } from '../sonos-event-handlers';
import { handleOffscreenReady } from '../offscreen-manager';
import { removeSession, hasSession } from '../session-manager';
import {
  WsConnectedMessageSchema,
  SonosEventMessageSchema,
  NetworkEventMessageSchema,
  TopologyEventMessageSchema,
  SessionDisconnectedMessageSchema,
} from '../../lib/message-schemas';

const log = createLogger('OffscreenRoutes');

/**
 * Registers all offscreen communication routes.
 */
export function registerOffscreenRoutes(): void {
  registerRoute('WS_CONNECTED', (msg) => {
    const validated = WsConnectedMessageSchema.parse(msg);
    handleWsConnected(validated.state);
    return { success: true };
  });

  registerRoute('WS_DISCONNECTED', () => {
    handleWsTemporarilyDisconnected();
    return { success: true };
  });

  registerRoute('WS_PERMANENTLY_DISCONNECTED', () => {
    handleWsPermanentlyDisconnected();
    return { success: true };
  });

  registerRoute('SONOS_EVENT', async (msg) => {
    const validated = SonosEventMessageSchema.parse(msg);
    // Cast needed because BroadcastEventSchema uses passthrough()
    await handleSonosEvent(validated.payload as BroadcastEvent);
    return { success: true };
  });

  registerRoute('NETWORK_EVENT', (msg) => {
    const validated = NetworkEventMessageSchema.parse(msg);
    handleNetworkEvent(validated.payload);
    return { success: true };
  });

  registerRoute('TOPOLOGY_EVENT', (msg) => {
    const validated = TopologyEventMessageSchema.parse(msg);
    handleTopologyEvent(validated.payload);
    return { success: true };
  });

  registerRoute('OFFSCREEN_READY', () => {
    handleOffscreenReady();
    return { success: true };
  });

  registerRoute('SESSION_DISCONNECTED', (msg) => {
    const validated = SessionDisconnectedMessageSchema.parse(msg);
    const { tabId } = validated;

    if (hasSession(tabId)) {
      log.warn(`Session for tab ${tabId} disconnected unexpectedly`);
      removeSession(tabId);
    }

    return { success: true };
  });
}
