import { createLogger } from '@thaumic-cast/shared';
import { SonosStateSnapshot, parseMediaMetadata } from '@thaumic-cast/protocol';
import { discoverDesktopApp } from '../lib/discovery';
import {
  ExtensionMessage,
  StartCastMessage,
  StopCastMessage,
  TabMetadataUpdateMessage,
  OffscreenMetadataMessage,
  ExtensionResponse,
  WsConnectedMessage,
  SonosEventMessage,
  WsStatusResponse,
  SetVolumeMessage,
  SetMuteMessage,
  CurrentTabStateResponse,
  ActiveCastsResponse,
  StartPlaybackResponse,
  SessionHealthMessage,
} from '../lib/messages';
import { getCachedState, updateCache, removeFromCache, restoreCache } from './metadata-cache';
import {
  registerSession,
  removeSession,
  hasSession,
  getActiveCasts,
  onMetadataUpdate,
  restoreSessions,
  getSessionCount,
} from './session-manager';
import {
  getSonosState as getStoredSonosState,
  setSonosState,
  restoreSonosState,
} from './sonos-state';
import {
  getConnectionState,
  setConnected,
  setDesktopApp,
  setConnectionError,
  clearConnectionState,
  restoreConnectionState,
} from './connection-state';
import { handleSonosEvent } from './sonos-event-handlers';
import {
  selectEncoderConfigWithContext,
  recordStableSession,
  recordBadSession,
  describeConfig,
} from '../lib/device-config';

const log = createLogger('Background');

// ─────────────────────────────────────────────────────────────────────────────
// Sonos State Management
// ─────────────────────────────────────────────────────────────────────────────

/** Whether the control WebSocket is connected. */
let wsConnected = false;

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
 * Returns the current Sonos state and connection status.
 * @returns Object with state and connected flag
 */
function getSonosState(): { state: SonosStateSnapshot | null; connected: boolean } {
  const state = getStoredSonosState();
  // Return null if state is empty (no groups)
  const hasState = state.groups.length > 0;
  return { state: hasState ? state : null, connected: wsConnected };
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket Connection Management
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Connects to the desktop app WebSocket via offscreen document.
 * @param serverUrl - The desktop app HTTP URL
 */
async function connectWebSocket(serverUrl: string): Promise<void> {
  await ensureOffscreen();
  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
  log.info(`Connecting WebSocket to: ${wsUrl}`);
  await sendToOffscreen({ type: 'WS_CONNECT', url: wsUrl });
}

/**
 * Handles WebSocket connected event from offscreen.
 * @param state - The initial Sonos state from desktop
 */
function handleWsConnected(state: SonosStateSnapshot): void {
  wsConnected = true;
  setConnected(true);
  updateSonosState(state);
  log.info('WebSocket connected, received initial state');
  // Notify popup of state
  notifyPopup({ type: 'WS_STATE_CHANGED', state });
}

/**
 * Handles WebSocket permanently disconnected event.
 */
function handleWsDisconnected(): void {
  wsConnected = false;
  setConnectionError('Connection lost after max retries');
  log.warn('WebSocket permanently disconnected');
  notifyPopup({ type: 'WS_CONNECTION_LOST', reason: 'max_retries_exceeded' });
}

/**
 * Sends a message to the popup (ignores errors if popup is closed).
 * @param message - The message to send
 */
function notifyPopup(message: object): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may not be open
  });
}

/**
 * Sends a message to the offscreen document with error handling.
 * @param message - The message to send
 * @returns The response from the offscreen document
 */
async function sendToOffscreen<T = unknown>(message: object): Promise<T | undefined> {
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    if (
      errorMessage.includes('context invalidated') ||
      errorMessage.includes('Receiving end does not exist')
    ) {
      log.warn('Offscreen not available, may need recreation');
    }
    throw err;
  }
}

/** Initialization promise to ensure storage is restored before processing messages. */
const initPromise = (async () => {
  await restoreCache();
  await restoreSessions();
  await restoreSonosState();
  await restoreConnectionState();
  await recoverOffscreenState();
  log.info('Background initialized');
})();

/** Promise to track ongoing offscreen creation to avoid duplicates. */
let offscreenCreationPromise: Promise<void> | null = null;

/**
 * Recovers WebSocket state from offscreen on service worker startup.
 */
async function recoverOffscreenState(): Promise<void> {
  try {
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });

    if (existing.length > 0) {
      log.info('Recovering state from existing offscreen document');

      const status = await sendToOffscreen<WsStatusResponse>({ type: 'GET_WS_STATUS' });
      if (status) {
        wsConnected = status.connected;
        if (status.state) {
          setSonosState(status.state);
          log.info('Recovered Sonos state from offscreen cache');
        }

        // If not connected but has URL, trigger reconnection
        if (!status.connected && status.url) {
          log.info('Triggering WebSocket reconnection...');
          sendToOffscreen({ type: 'WS_RECONNECT' }).catch(() => {});
        }
      }
    }
  } catch (err) {
    log.warn('Failed to recover offscreen state:', err);
  }
}

/**
 * Ensures the offscreen document is created exactly once.
 *
 * Manifest V3 requires an offscreen document to access DOM APIs like AudioContext.
 *
 * @returns A promise that resolves when the offscreen document is confirmed to exist.
 */
async function ensureOffscreen(): Promise<void> {
  if (offscreenCreationPromise) return offscreenCreationPromise;

  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (existing.length > 0) return;

  offscreenCreationPromise = chrome.offscreen
    .createDocument({
      url: 'src/offscreen/offscreen.html',
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: 'Capture and encode tab audio for streaming to Sonos',
    })
    .then(() => {
      offscreenCreationPromise = null;
    })
    .catch((err) => {
      offscreenCreationPromise = null;
      throw err;
    });

  return offscreenCreationPromise;
}

/**
 * Global message listener for the Extension Background Script.
 */
chrome.runtime.onMessage.addListener((msg: ExtensionMessage, _sender, sendResponse) => {
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
          await handleTabMetadataUpdate(msg as TabMetadataUpdateMessage, _sender);
          sendResponse({ success: true });
          break;

        // Legacy METADATA_UPDATE from old content scripts - redirect to new handler
        case 'METADATA_UPDATE':
          if ('payload' in msg && typeof (msg as { payload: unknown }).payload === 'object') {
            await handleTabMetadataUpdate(
              {
                type: 'TAB_METADATA_UPDATE',
                payload: (msg as { payload: unknown }).payload,
              } as TabMetadataUpdateMessage,
              _sender,
            );
          }
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

        // ─────────────────────────────────────────────────────────────────
        // Sonos State Messages (from popup)
        // ─────────────────────────────────────────────────────────────────
        case 'GET_SONOS_STATE':
          sendResponse(getSonosState());
          break;

        case 'SET_VOLUME': {
          const { speakerIp, volume } = msg as SetVolumeMessage;
          const result = await sendToOffscreen({ type: 'SET_VOLUME', speakerIp, volume });
          sendResponse(result);
          break;
        }

        case 'SET_MUTE': {
          const { speakerIp, muted } = msg as SetMuteMessage;
          const result = await sendToOffscreen({ type: 'SET_MUTE', speakerIp, muted });
          sendResponse(result);
          break;
        }

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
          wsConnected = false;
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

        case 'OFFSCREEN_READY':
          log.info('Offscreen document ready');
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

/**
 * Handles metadata updates from content scripts.
 * Updates the cache and forwards to offscreen if casting.
 *
 * @param msg - The metadata message from content script
 * @param sender - The message sender information
 */
async function handleTabMetadataUpdate(
  msg: TabMetadataUpdateMessage,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  // Parse and validate the metadata
  const metadata = parseMediaMetadata(msg.payload);
  const tabInfo = {
    title: sender.tab?.title,
    favIconUrl: sender.tab?.favIconUrl,
  };

  // Update the cache
  const state = updateCache(tabId, tabInfo, metadata);

  // Notify popup of state change so CurrentTabCard updates
  notifyPopup({ type: 'TAB_STATE_CHANGED', tabId, state });

  // If this tab is casting, notify popup and forward to offscreen
  if (hasSession(tabId)) {
    onMetadataUpdate(tabId);
    forwardMetadataToOffscreen(tabId, msg.payload);
  }
}

/**
 * Forwards metadata to offscreen document for streaming.
 * @param tabId - The tab ID
 * @param metadata - The stream metadata to forward
 */
function forwardMetadataToOffscreen(tabId: number, metadata: unknown): void {
  const offscreenMsg: OffscreenMetadataMessage = {
    type: 'METADATA_UPDATE',
    payload: {
      tabId,
      metadata: metadata as OffscreenMetadataMessage['payload']['metadata'],
    },
  };
  chrome.runtime.sendMessage(offscreenMsg).catch(() => {});
}

/**
 * Handles GET_CURRENT_TAB_STATE query from popup.
 * Returns the current tab's media state and cast status.
 * @returns The current tab state response
 */
async function handleGetCurrentTabState(): Promise<CurrentTabStateResponse> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) {
    return { state: null, isCasting: false };
  }

  // Return cached state or create minimal state from tab info
  const cached = getCachedState(tab.id);
  const state = cached ?? {
    tabId: tab.id,
    tabTitle: tab.title || 'Unknown Tab',
    tabFavicon: tab.favIconUrl,
    metadata: null,
    updatedAt: Date.now(),
  };

  return { state, isCasting: hasSession(tab.id) };
}

/**
 * Logic for starting a new cast session.
 *
 * @param msg - The start cast message.
 * @param sendResponse - Callback to send results back to the caller.
 */
async function handleStartCast(
  msg: StartCastMessage,
  sendResponse: (res: ExtensionResponse) => void,
) {
  let finished = false;
  const safeSendResponse = (res: ExtensionResponse) => {
    if (!finished) {
      sendResponse(res);
      finished = true;
    }
  };

  try {
    const { speakerIp, encoderConfig: providedConfig } = msg.payload;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab');

    // Select encoder config: use provided config or auto-select based on device/battery
    let encoderConfig: typeof providedConfig;
    let lowPowerMode = false;
    if (providedConfig) {
      encoderConfig = providedConfig;
    } else {
      const result = await selectEncoderConfigWithContext();
      encoderConfig = result.config;
      lowPowerMode = result.lowPowerMode;
    }
    log.info(`Encoder config: ${describeConfig(encoderConfig, lowPowerMode)}`);

    // 1. Discover Desktop App and its limits
    const app = await discoverDesktopApp();
    if (!app) {
      clearConnectionState();
      throw new Error('Desktop App not found. Please make sure it is running.');
    }

    // Cache the discovered URL for instant popup display
    setDesktopApp(app.url, app.maxStreams);

    // 2. Check session limits
    if (getSessionCount() >= app.maxStreams) {
      throw new Error(
        `Maximum session limit reached (${app.maxStreams}). Please stop an existing cast first.`,
      );
    }

    // 3. Capture Tab
    const mediaStreamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id! }, (id) => {
        if (id) resolve(id);
        else reject(new Error('Tab capture denied'));
      });
    });

    await ensureOffscreen();

    // 4. Connect control WebSocket if not already connected
    if (!wsConnected) {
      await connectWebSocket(app.url);
    }

    // 5. Start Offscreen Session
    const response: ExtensionResponse = await chrome.runtime.sendMessage({
      type: 'START_CAPTURE',
      payload: {
        tabId: tab.id,
        mediaStreamId,
        encoderConfig,
        baseUrl: app.url,
      },
    });

    if (response.success && response.streamId) {
      // Get cached metadata to send with playback start (avoids "Browser Audio" default)
      const cachedState = getCachedState(tab.id);
      const initialMetadata = cachedState?.metadata ?? undefined;

      // 6. Start playback via WebSocket (waits for STREAM_READY internally)
      // Include initial metadata so Sonos displays correct info immediately
      const playbackResponse: StartPlaybackResponse = await chrome.runtime.sendMessage({
        type: 'START_PLAYBACK',
        payload: { tabId: tab.id, speakerIp, metadata: initialMetadata },
      });

      if (!playbackResponse.success) {
        // Playback failed - clean up the capture
        log.error('Playback failed, cleaning up capture');
        await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', payload: { tabId: tab.id } });
        throw new Error(`Playback failed: ${playbackResponse.error || 'Unknown error'}`);
      }

      // Find speaker name from Sonos state
      const sonosState = getStoredSonosState();
      const speakerName = sonosState.groups.find((g) => g.coordinatorIp === speakerIp)?.name;

      // Ensure cache has tab info for ActiveCast display (even without MediaSession metadata)
      if (!getCachedState(tab.id)) {
        updateCache(tab.id, { title: tab.title, favIconUrl: tab.favIconUrl }, null);
      }

      // Register the session with the session manager
      registerSession(tab.id, response.streamId, speakerIp, speakerName, encoderConfig);

      safeSendResponse({ success: true });
    } else {
      // Offscreen capture failed - no cleanup needed
      safeSendResponse(response);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Cast failed: ${message}`);
    safeSendResponse({ success: false, error: message });
  }
}

/**
 * Logic for stopping the active cast session.
 *
 * @param msg - The stop cast message.
 * @param sendResponse - Callback to send results back to the caller.
 */
async function handleStopCast(
  msg: StopCastMessage,
  sendResponse: (res: ExtensionResponse) => void,
) {
  try {
    // Prefer explicitly provided tabId if available
    let tabId = msg.payload?.tabId;

    if (!tabId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id;
    }

    if (tabId && hasSession(tabId)) {
      await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', payload: { tabId } });
      removeSession(tabId);
    }
    sendResponse({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(`Stop cast failed: ${message}`);
    sendResponse({ success: false, error: message });
  }
}

/**
 * Returns the cast status for the current tab.
 *
 * @param sendResponse - Callback to send status back to the caller.
 */
async function handleGetStatus(sendResponse: (res: ExtensionResponse) => void) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isActive = !!(tab?.id && hasSession(tab.id));
    sendResponse({ success: true, isActive });
  } catch {
    sendResponse({ success: false, isActive: false });
  }
}

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
    chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', payload: { tabId } }).catch(() => {
      // Offscreen might already be closed
    });
    removeSession(tabId);
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
initPromise.then(async () => {
  const connState = getConnectionState();
  if (connState.desktopAppUrl && !wsConnected) {
    // Check if offscreen already has an active connection
    const existing = await chrome.runtime.getContexts({
      contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
    });

    if (existing.length > 0) {
      // Offscreen exists, connection should be recovered via recoverOffscreenState
      return;
    }

    // No offscreen and not connected - attempt background reconnection
    log.info('Attempting background reconnection...');
    connectWebSocket(connState.desktopAppUrl).catch(() => {
      // Will retry when popup opens
    });
  }
});
