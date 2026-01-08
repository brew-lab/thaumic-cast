/**
 * Offscreen Routes
 *
 * Handles message routing for offscreen document communication:
 * - WS_CONNECTED, WS_DISCONNECTED, WS_PERMANENTLY_DISCONNECTED
 * - SONOS_EVENT, NETWORK_EVENT, TOPOLOGY_EVENT
 * - OFFSCREEN_READY, SESSION_HEALTH
 */

import { createLogger } from '@thaumic-cast/shared';
import type {
  WsConnectedMessage,
  SonosEventMessage,
  NetworkEventMessage,
  TopologyEventMessage,
  SessionHealthMessage,
} from '../../lib/messages';
import { recordStableSession, recordBadSession } from '../../lib/device-config';
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

const log = createLogger('OffscreenRoutes');

/**
 * Registers all offscreen communication routes.
 */
export function registerOffscreenRoutes(): void {
  registerRoute<WsConnectedMessage>('WS_CONNECTED', (msg) => {
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

  registerRoute<SonosEventMessage>('SONOS_EVENT', async (msg) => {
    await handleSonosEvent(msg.payload);
    return { success: true };
  });

  registerRoute<NetworkEventMessage>('NETWORK_EVENT', (msg) => {
    handleNetworkEvent(msg.payload);
    return { success: true };
  });

  registerRoute<TopologyEventMessage>('TOPOLOGY_EVENT', (msg) => {
    handleTopologyEvent(msg.payload);
    return { success: true };
  });

  registerRoute('OFFSCREEN_READY', () => {
    handleOffscreenReady();
    return { success: true };
  });

  registerRoute<SessionHealthMessage>('SESSION_HEALTH', async (msg) => {
    const { payload } = msg;
    log.info(
      `Session health for tab ${payload.tabId}: ` +
        `hadDrops=${payload.hadDrops}, ` +
        `producer=${payload.totalProducerDrops}, ` +
        `catchUp=${payload.totalCatchUpDrops}, ` +
        `consumer=${payload.totalConsumerDrops}, ` +
        `underflows=${payload.totalUnderflows}`,
    );

    // Record session outcome for config learning
    if (payload.hadDrops) {
      await recordBadSession(payload.encoderConfig);
    } else {
      await recordStableSession(payload.encoderConfig);
    }

    return { success: true };
  });
}
