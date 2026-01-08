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
import { registerRoute, registerValidatedRoute } from '../router';
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
  registerValidatedRoute('WS_CONNECTED', WsConnectedMessageSchema, (msg) => {
    handleWsConnected(msg.state);
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

  // Uses registerRoute because BroadcastEventSchema uses passthrough(),
  // which produces a type incompatible with registerValidatedRoute's constraints
  registerRoute('SONOS_EVENT', async (msg) => {
    const validated = SonosEventMessageSchema.parse(msg);
    await handleSonosEvent(validated.payload as BroadcastEvent);
    return { success: true };
  });

  registerValidatedRoute('NETWORK_EVENT', NetworkEventMessageSchema, (msg) => {
    handleNetworkEvent(msg.payload);
    return { success: true };
  });

  registerValidatedRoute('TOPOLOGY_EVENT', TopologyEventMessageSchema, (msg) => {
    handleTopologyEvent(msg.payload);
    return { success: true };
  });

  registerRoute('OFFSCREEN_READY', () => {
    handleOffscreenReady();
    return { success: true };
  });

  registerValidatedRoute('SESSION_DISCONNECTED', SessionDisconnectedMessageSchema, (validated) => {
    const { tabId } = validated;

    if (hasSession(tabId)) {
      log.warn(`Session for tab ${tabId} disconnected unexpectedly`);
      removeSession(tabId);
    }

    return { success: true };
  });
}
