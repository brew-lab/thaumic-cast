/**
 * Background Script Entry Point
 *
 * This is the main entry point for the extension's background service worker.
 * It routes messages to specialized handlers and manages lifecycle events.
 *
 * All business logic is delegated to extracted modules:
 * - handlers/cast.ts: Cast session lifecycle
 * - handlers/connection.ts: Discovery and WebSocket
 * - handlers/metadata.ts: Tab metadata processing
 * - handlers/media-control.ts: Volume/mute/transport controls
 * - offscreen-manager.ts: Offscreen document lifecycle
 * - codec-support.ts: Codec detection
 */

import { createLogger } from '@thaumic-cast/shared';
import type {
  ExtensionMessage,
  TabMetadataUpdateMessage,
  WsConnectedMessage,
  SonosEventMessage,
  NetworkEventMessage,
  TopologyEventMessage,
  SetVolumeMessage,
  SetMuteMessage,
  ControlMediaMessage,
  SessionHealthMessage,
  ActiveCastsResponse,
} from '../lib/messages';
import { clearDiscoveryCache } from '../lib/discovery';
import { recordStableSession, recordBadSession } from '../lib/device-config';

// State management modules
import { restoreCache, removeFromCache } from './metadata-cache';
import { restoreSessions, getActiveCasts, hasSession } from './session-manager';
import { restoreSonosState, updateGroups } from './sonos-state';
import {
  getConnectionState,
  setConnected,
  setDesktopApp,
  clearConnectionState,
  restoreConnectionState,
  setNetworkHealth,
} from './connection-state';
import { handleSonosEvent, stopCastForTab } from './sonos-event-handlers';
import { notifyPopup } from './notify';

// Extracted handler modules
import { handleStartCast, handleStopCast, handleGetStatus } from './handlers/cast';
import {
  connectWebSocket,
  discoverAndCache,
  ensureConnection,
  handleWsConnected,
  handleWsDisconnected,
  getSonosState,
} from './handlers/connection';
import {
  handleTabMetadataUpdate,
  handleTabOgImage,
  handleGetCurrentTabState,
} from './handlers/metadata';
import {
  handleSetVolume,
  handleSetMute,
  handleControlMedia,
  handleVideoSyncMessage,
  handleGetVideoSyncState,
  handleVideoSyncStateChanged,
} from './handlers/media-control';

// Offscreen management
import {
  recoverOffscreenState,
  handleOffscreenReady,
  sendToOffscreen,
  checkAndReconnect,
} from './offscreen-manager';

const log = createLogger('Background');

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

/** Initialization promise to ensure storage is restored before processing messages. */
const initPromise = (async () => {
  await restoreCache();
  await restoreSessions();
  await restoreSonosState();
  await restoreConnectionState();
  await recoverOffscreenState();
  log.info('Background initialized');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Message Router
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Global message listener for the Extension Background Script.
 * Routes messages to appropriate handlers.
 */
chrome.runtime.onMessage.addListener((msg: ExtensionMessage, sender, sendResponse) => {
  // Ensure initialization is complete before handling any messages
  initPromise.then(async () => {
    try {
      switch (msg.type) {
        // ─────────────────────────────────────────────────────────────────
        // Cast Session Messages
        // ─────────────────────────────────────────────────────────────────
        case 'START_CAST':
          await handleStartCast(msg, sendResponse);
          break;

        case 'STOP_CAST':
          await handleStopCast(msg, sendResponse);
          break;

        case 'GET_CAST_STATUS':
          await handleGetStatus(sendResponse);
          break;

        case 'TAB_METADATA_UPDATE':
          await handleTabMetadataUpdate(msg as TabMetadataUpdateMessage, sender);
          sendResponse({ success: true });
          break;

        case 'TAB_OG_IMAGE':
          handleTabOgImage(msg.payload as { ogImage: string }, sender);
          sendResponse({ success: true });
          break;

        case 'GET_CURRENT_TAB_STATE': {
          const response = await handleGetCurrentTabState();
          sendResponse(response);
          break;
        }

        case 'GET_ACTIVE_CASTS': {
          const response: ActiveCastsResponse = { casts: getActiveCasts() };
          sendResponse(response);
          break;
        }

        // ─────────────────────────────────────────────────────────────────
        // Connection Status (from popup)
        // ─────────────────────────────────────────────────────────────────
        case 'GET_CONNECTION_STATUS':
          sendResponse(getConnectionState());
          break;

        case 'ENSURE_CONNECTION': {
          const response = await ensureConnection();
          sendResponse(response);
          break;
        }

        // ─────────────────────────────────────────────────────────────────
        // Sonos State Messages (from popup)
        // ─────────────────────────────────────────────────────────────────
        case 'GET_SONOS_STATE':
          sendResponse(getSonosState());
          break;

        case 'SET_VOLUME': {
          const result = await handleSetVolume(msg as SetVolumeMessage);
          sendResponse(result);
          break;
        }

        case 'SET_MUTE': {
          const result = await handleSetMute(msg as SetMuteMessage);
          sendResponse(result);
          break;
        }

        case 'CONTROL_MEDIA': {
          await handleControlMedia(msg as ControlMediaMessage);
          sendResponse({ success: true });
          break;
        }

        // ─────────────────────────────────────────────────────────────────
        // Video Sync Messages (popup → background → content)
        // ─────────────────────────────────────────────────────────────────
        case 'SET_VIDEO_SYNC_ENABLED':
        case 'SET_VIDEO_SYNC_TRIM':
        case 'TRIGGER_RESYNC': {
          const { tabId } = (msg as { payload: { tabId: number } }).payload;
          const response = await handleVideoSyncMessage(msg, tabId);
          sendResponse(response);
          break;
        }

        case 'GET_VIDEO_SYNC_STATE': {
          const { tabId } = (msg as { payload: { tabId: number } }).payload;
          const response = await handleGetVideoSyncState(tabId);
          sendResponse(response);
          break;
        }

        case 'VIDEO_SYNC_STATE_CHANGED':
          handleVideoSyncStateChanged(msg);
          sendResponse({ success: true });
          break;

        // ─────────────────────────────────────────────────────────────────
        // WebSocket Status Messages (from offscreen)
        // ─────────────────────────────────────────────────────────────────
        case 'WS_CONNECTED': {
          const { state } = msg as WsConnectedMessage;
          handleWsConnected(state);
          sendResponse({ success: true });
          break;
        }

        case 'WS_DISCONNECTED':
          // Temporary disconnect - will attempt reconnect
          setConnected(false);
          log.warn('WebSocket disconnected, reconnecting...');
          notifyPopup({ type: 'WS_CONNECTION_LOST', reason: 'reconnecting' });
          sendResponse({ success: true });
          break;

        case 'WS_PERMANENTLY_DISCONNECTED':
          handleWsDisconnected();
          sendResponse({ success: true });
          break;

        case 'SONOS_EVENT': {
          const { payload } = msg as SonosEventMessage;
          await handleSonosEvent(payload);
          sendResponse({ success: true });
          break;
        }

        case 'NETWORK_EVENT': {
          const { payload } = msg as NetworkEventMessage;
          if (payload.type === 'healthChanged') {
            const health = payload.health;
            const reason = payload.reason ?? null;
            setNetworkHealth(health, reason);
            notifyPopup({
              type: 'NETWORK_HEALTH_CHANGED',
              health,
              reason,
            });
          }
          sendResponse({ success: true });
          break;
        }

        case 'TOPOLOGY_EVENT': {
          const { payload } = msg as TopologyEventMessage;
          if (payload.type === 'groupsDiscovered') {
            const newState = updateGroups(payload.groups);
            notifyPopup({
              type: 'WS_STATE_CHANGED',
              state: newState,
            });
            log.info(`Groups discovered: ${payload.groups.length} groups`);
          }
          sendResponse({ success: true });
          break;
        }

        case 'OFFSCREEN_READY':
          handleOffscreenReady();
          sendResponse({ success: true });
          break;

        case 'SESSION_HEALTH': {
          const { payload } = msg as SessionHealthMessage;
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

          sendResponse({ success: true });
          break;
        }

        // ─────────────────────────────────────────────────────────────────
        // WebSocket Control (from popup)
        // ─────────────────────────────────────────────────────────────────
        case 'WS_CONNECT': {
          const { url, maxStreams } = msg as {
            type: 'WS_CONNECT';
            url: string;
            maxStreams?: number;
          };
          // Convert HTTP URL to WebSocket URL if needed
          const baseUrl = url.replace(/\/ws$/, '').replace(/^ws/, 'http');
          // Cache the URL for instant popup display
          if (maxStreams !== undefined) {
            setDesktopApp(baseUrl, maxStreams);
          }
          await connectWebSocket(baseUrl);
          sendResponse({ success: true });
          break;
        }

        case 'WS_DISCONNECT':
        case 'WS_RECONNECT':
          // Forward to offscreen
          await sendToOffscreen(msg);
          sendResponse({ success: true });
          break;

        default:
          // Unknown message type - ignore
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(`Message handling error: ${message}`);
      sendResponse({ success: false, error: message });
    }
  });
  return true; // Keep channel open for async response
});

// ─────────────────────────────────────────────────────────────────────────────
// Tab Lifecycle Events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handle tab closure to prevent memory leaks and dangling stream sessions.
 */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  await initPromise;

  // Clean up metadata cache
  removeFromCache(tabId);

  // Clean up active session if exists
  if (hasSession(tabId)) {
    log.info(`Tab ${tabId} closed, cleaning up session`);
    await stopCastForTab(tabId);
  }
});

/**
 * Request fresh metadata when tab becomes audible.
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.audible === true) {
    chrome.tabs.sendMessage(tabId, { type: 'REQUEST_METADATA' }).catch(() => {
      // Content script may not be ready
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Proactive Connection Maintenance
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Attempts to reconnect WebSocket on extension startup.
 * Uses cached connection state to avoid discovery on every startup.
 */
chrome.runtime.onStartup?.addListener(async () => {
  await initPromise;

  const connState = getConnectionState();
  if (connState.desktopAppUrl && !connState.connected) {
    log.info('Attempting to reconnect on startup...');
    try {
      await connectWebSocket(connState.desktopAppUrl);
    } catch {
      // Will retry when popup opens
    }
  }
});

/**
 * Attempts to reconnect on service worker wake.
 * Service workers can be suspended and resumed - this ensures
 * we maintain connection when woken.
 */
initPromise.then(() => {
  checkAndReconnect(connectWebSocket);
});

/**
 * Listen for server settings changes and reconnect when they change.
 * This handles the case where user changes server URL or auto-discover mode
 * after the extension has already connected.
 */
chrome.storage.sync.onChanged.addListener(async (changes) => {
  if (!changes['extensionSettings']) return;

  const oldSettings = changes['extensionSettings'].oldValue;
  const newSettings = changes['extensionSettings'].newValue;

  // Check if server-related settings changed
  const serverUrlChanged = oldSettings?.serverUrl !== newSettings?.serverUrl;
  const autoDiscoverChanged = oldSettings?.useAutoDiscover !== newSettings?.useAutoDiscover;

  if (serverUrlChanged || autoDiscoverChanged) {
    log.info('Server settings changed, reconnecting...');

    // Disconnect existing WebSocket before clearing state
    if (getConnectionState().connected) {
      await sendToOffscreen({ type: 'WS_DISCONNECT' }).catch(() => {});
    }

    // Clear caches to force fresh discovery
    clearDiscoveryCache();
    clearConnectionState();

    // Trigger fresh discovery and connection
    const app = await discoverAndCache(true);
    if (app) {
      await connectWebSocket(app.url);
    }

    // Notify popup of connection state change
    notifyPopup({ type: 'WS_CONNECTION_LOST', reason: 'settings_changed' });
  }
});
