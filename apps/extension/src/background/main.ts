/**
 * Background Script Entry Point
 *
 * This is the main entry point for the extension's background service worker.
 * It initializes the message router and manages lifecycle events.
 *
 * Message routing is delegated to domain-specific route modules:
 * - routes/cast-routes.ts: Cast session lifecycle
 * - routes/metadata-routes.ts: Tab metadata processing
 * - routes/connection-routes.ts: Discovery and WebSocket
 * - routes/sonos-routes.ts: Volume/mute controls
 * - routes/video-sync-routes.ts: Video synchronization
 * - routes/offscreen-routes.ts: Offscreen document messages
 */

import { createLogger } from '@thaumic-cast/shared';
import type { BackgroundInboundMessage } from '../lib/messages';
import { ExtensionSettingsSchema } from '../lib/settings';

// State management modules (these register themselves with persistenceManager on import)
import { removeFromCache } from './metadata-cache';
import { hasSession } from './session-manager';
import './sonos-state'; // Side-effect import to register storage
import { getConnectionState, clearConnectionState } from './connection-state';
import { persistenceManager } from './persistence-manager';
import { stopCastForTab } from './sonos-event-handlers';
import { notifyPopup } from './notification-service';

// Router and routes
import { dispatch } from './router';
import { registerCastRoutes } from './routes/cast-routes';
import { registerMetadataRoutes } from './routes/metadata-routes';
import { registerConnectionRoutes } from './routes/connection-routes';
import { registerSonosRoutes } from './routes/sonos-routes';
import { registerVideoSyncRoutes } from './routes/video-sync-routes';
import { registerOffscreenRoutes } from './routes/offscreen-routes';

// Offscreen management
import { recoverOffscreenState, checkAndReconnect } from './offscreen-manager';
import { offscreenBroker } from './offscreen-broker';

// Connection handlers needed for lifecycle events
import { connectWebSocket, discoverAndCache } from './handlers/connection';
import { noop } from '../lib/noop';

const log = createLogger('Background');

// ─────────────────────────────────────────────────────────────────────────────
// Route Registration
// ─────────────────────────────────────────────────────────────────────────────

registerCastRoutes();
registerMetadataRoutes();
registerConnectionRoutes();
registerSonosRoutes();
registerVideoSyncRoutes();
registerOffscreenRoutes();

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

/** Initialization promise to ensure storage is restored before processing messages. */
const initPromise = (async () => {
  // Restore all persisted state in registration order
  await persistenceManager.restoreAll();
  await recoverOffscreenState();
  log.info('Background initialized');
})();

// ─────────────────────────────────────────────────────────────────────────────
// Message Router
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Global message listener for the Extension Background Script.
 * Dispatches messages to registered route handlers.
 */
chrome.runtime.onMessage.addListener((msg: BackgroundInboundMessage, sender, sendResponse) => {
  initPromise.then(async () => {
    try {
      const result = await dispatch(msg, sender);
      sendResponse(result ?? { success: true });
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
    chrome.tabs.sendMessage(tabId, { type: 'REQUEST_METADATA' }).catch(noop);
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
chrome.storage.local.onChanged.addListener(async (changes) => {
  if (!changes['extensionSettings']) return;

  const oldParsed = ExtensionSettingsSchema.safeParse(changes['extensionSettings'].oldValue);
  const newParsed = ExtensionSettingsSchema.safeParse(changes['extensionSettings'].newValue);

  const oldSettings = oldParsed.success ? oldParsed.data : undefined;
  const newSettings = newParsed.success ? newParsed.data : undefined;

  // Check if server-related settings changed
  const serverUrlChanged = oldSettings?.serverUrl !== newSettings?.serverUrl;
  const autoDiscoverChanged = oldSettings?.useAutoDiscover !== newSettings?.useAutoDiscover;

  if (serverUrlChanged || autoDiscoverChanged) {
    log.info('Server settings changed, reconnecting...');

    // Disconnect existing WebSocket before clearing state
    if (getConnectionState().connected) {
      await offscreenBroker.disconnectWebSocket().catch(noop);
    }

    // Clear connection state to force fresh discovery
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
