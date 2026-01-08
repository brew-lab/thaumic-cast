import { createLogger } from '@thaumic-cast/shared';
import {
  SonosStateSnapshot,
  parseMediaMetadata,
  MediaAction,
  MediaActionSchema,
  PlaybackState,
  PlaybackStateSchema,
  StreamMetadata,
} from '@thaumic-cast/protocol';
import { discoverDesktopApp, clearDiscoveryCache } from '../lib/discovery';
import { getSourceFromUrl } from '../lib/url-utils';
import {
  ExtensionMessage,
  StartCastMessage,
  StopCastMessage,
  TabMetadataUpdateMessage,
  OffscreenMetadataMessage,
  ExtensionResponse,
  WsConnectedMessage,
  SonosEventMessage,
  NetworkEventMessage,
  TopologyEventMessage,
  WsStatusResponse,
  SetVolumeMessage,
  SetMuteMessage,
  CurrentTabStateResponse,
  ActiveCastsResponse,
  StartPlaybackResponse,
  SessionHealthMessage,
  ControlMediaMessage,
  EnsureConnectionResponse,
} from '../lib/messages';
import {
  getCachedState,
  updateCache,
  updateTabInfo,
  removeFromCache,
  restoreCache,
} from './metadata-cache';
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
  updateGroups,
} from './sonos-state';
import {
  getConnectionState,
  setConnected,
  setDesktopApp,
  setConnectionError,
  clearConnectionState,
  restoreConnectionState,
  setNetworkHealth,
} from './connection-state';
import { handleSonosEvent } from './sonos-event-handlers';
import {
  selectEncoderConfig,
  recordStableSession,
  recordBadSession,
  describeConfig,
} from '../lib/device-config';
import { loadExtensionSettings } from '../lib/settings';
import { resolveAudioMode, describeEncoderConfig } from '../lib/presets';
import type { SupportedCodecsResult, EncoderConfig } from '@thaumic-cast/protocol';
import i18n from '../lib/i18n';

const log = createLogger('Background');

/** Storage key for caching codec detection results in session storage. */
const CODEC_CACHE_KEY = 'codecSupportCache';

/**
 * Detects supported audio codecs via offscreen document and caches the result.
 * AudioEncoder is only available in window contexts, not service workers,
 * so we must delegate detection to the offscreen document.
 * @returns The codec support result, or null if detection failed
 */
async function detectAndCacheCodecSupport(): Promise<SupportedCodecsResult | null> {
  try {
    // Check if already cached
    const cached = await chrome.storage.session.get(CODEC_CACHE_KEY);
    if (cached[CODEC_CACHE_KEY]) {
      log.debug('Codec support already cached');
      return cached[CODEC_CACHE_KEY] as SupportedCodecsResult;
    }

    // Request detection from offscreen document (AudioEncoder available there)
    log.info('Requesting codec detection from offscreen...');
    const response = await chrome.runtime.sendMessage({ type: 'DETECT_CODECS' });

    if (response?.success && response.result) {
      const result = response.result as SupportedCodecsResult;
      await chrome.storage.session.set({ [CODEC_CACHE_KEY]: result });
      log.info(
        `Codec detection complete: ${result.availableCodecs.length} codecs available (default: ${result.defaultCodec})`,
      );
      return result;
    }

    log.warn('Codec detection failed:', response?.error);
    return null;
  } catch (err) {
    log.warn('Codec detection failed:', err);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sonos State Management
// ─────────────────────────────────────────────────────────────────────────────

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
 * Returns the current Sonos state.
 * @returns Object with state (null if no groups discovered)
 */
function getSonosState(): { state: SonosStateSnapshot | null } {
  const state = getStoredSonosState();
  // Return null if state is empty (no groups)
  const hasState = state.groups.length > 0;
  return { state: hasState ? state : null };
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

/** Result of discovering and caching desktop app info. */
interface DiscoverResult {
  /** The discovered app URL */
  url: string;
  /** Maximum concurrent streams allowed */
  maxStreams: number;
}

/**
 * Discovers the desktop app and caches the result.
 * Centralizes the discover + cache pattern to avoid duplication.
 * @param force - Whether to force fresh discovery (ignore cache)
 * @returns The discovered app info, or null if not found
 */
async function discoverAndCache(force = false): Promise<DiscoverResult | null> {
  const app = await discoverDesktopApp(force);
  if (!app) return null;
  setDesktopApp(app.url, app.maxStreams);
  return { url: app.url, maxStreams: app.maxStreams };
}

/**
 * Handles WebSocket connected event from offscreen.
 * @param state - The initial Sonos state from desktop (may include network health)
 */
function handleWsConnected(state: SonosStateSnapshot): void {
  setConnected(true);
  updateSonosState(state);
  log.info('WebSocket connected');

  // Extract network health from initial state if present
  const stateWithHealth = state as SonosStateSnapshot & {
    networkHealth?: 'ok' | 'degraded';
    networkHealthReason?: string;
  };
  if (stateWithHealth.networkHealth) {
    log.info(
      `Initial network health: ${stateWithHealth.networkHealth}` +
        (stateWithHealth.networkHealthReason ? ` (${stateWithHealth.networkHealthReason})` : ''),
    );
    setNetworkHealth(stateWithHealth.networkHealth, stateWithHealth.networkHealthReason ?? null);
  }

  // Notify popup of state
  notifyPopup({ type: 'WS_STATE_CHANGED', state });
}

/**
 * Handles WebSocket permanently disconnected event.
 */
function handleWsDisconnected(): void {
  setConnectionError(i18n.t('error_connection_lost'));
  log.warn('WebSocket permanently disconnected');
  notifyPopup({ type: 'WS_CONNECTION_LOST', reason: 'max_retries_exceeded' });
}

/**
 * Ensures connection to the desktop app.
 * Discovers and connects if needed, returns current connection state.
 * This centralizes all discovery/connection logic in the background.
 * @returns The connection result
 */
async function ensureConnection(): Promise<EnsureConnectionResponse> {
  const connState = getConnectionState();

  // Already connected - return current state
  if (connState.connected) {
    return {
      connected: true,
      desktopAppUrl: connState.desktopAppUrl,
      maxStreams: connState.maxStreams,
      error: null,
    };
  }

  // Have a cached URL - try to reconnect
  if (connState.desktopAppUrl) {
    try {
      await connectWebSocket(connState.desktopAppUrl);
      // Connection is async - return optimistically, WS_STATE_CHANGED will confirm
      return {
        connected: false, // Not yet confirmed, but connecting
        desktopAppUrl: connState.desktopAppUrl,
        maxStreams: connState.maxStreams,
        error: null,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Reconnection failed, will try discovery:', message);
      // Fall through to discovery
    }
  }

  // No cached URL or reconnection failed - discover desktop app
  try {
    const app = await discoverAndCache();
    if (!app) {
      clearConnectionState();
      return {
        connected: false,
        desktopAppUrl: null,
        maxStreams: null,
        error: i18n.t('error_desktop_not_found'),
      };
    }

    // Connect WebSocket
    await connectWebSocket(app.url);

    // Connection is async - return optimistically
    return {
      connected: false, // Not yet confirmed, but connecting
      desktopAppUrl: app.url,
      maxStreams: app.maxStreams,
      error: null,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('Discovery/connection failed:', message);
    return {
      connected: false,
      desktopAppUrl: null,
      maxStreams: null,
      error: message,
    };
  }
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

/** Resolver for offscreen ready signal. */
let offscreenReadyResolver: (() => void) | null = null;

/** Promise that resolves when offscreen document signals it's ready. */
let offscreenReadyPromise: Promise<void> | null = null;

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
        setConnected(status.connected);
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
 * Ensures the offscreen document is created and ready.
 *
 * Manifest V3 requires an offscreen document to access DOM APIs like AudioContext.
 * This function waits for the OFFSCREEN_READY message to ensure the document's
 * message listener is set up before returning.
 *
 * @returns A promise that resolves when the offscreen document is ready.
 */
async function ensureOffscreen(): Promise<void> {
  // If already creating, wait for the existing promise
  if (offscreenCreationPromise) {
    await offscreenCreationPromise;
    // Also wait for ready signal if we have one pending
    if (offscreenReadyPromise) await offscreenReadyPromise;
    return;
  }

  const existing = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  // Already exists and ready
  if (existing.length > 0) return;

  // Create promise for ready signal BEFORE creating document
  // This ensures we don't miss the signal if it comes quickly
  offscreenReadyPromise = new Promise<void>((resolve) => {
    offscreenReadyResolver = resolve;
  });

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
      offscreenReadyPromise = null;
      offscreenReadyResolver = null;
      throw err;
    });

  // Wait for document creation
  await offscreenCreationPromise;

  // Wait for ready signal (with timeout to avoid hanging forever)
  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('Offscreen ready timeout')), 5000),
  );

  try {
    await Promise.race([offscreenReadyPromise, timeoutPromise]);
  } finally {
    offscreenReadyPromise = null;
    offscreenReadyResolver = null;
  }
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

        case 'TAB_OG_IMAGE':
          handleTabOgImage(msg.payload as { ogImage: string }, _sender);
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

        case 'CONTROL_MEDIA': {
          const { tabId, action } = (msg as ControlMediaMessage).payload;
          await chrome.tabs.sendMessage(tabId, { type: 'CONTROL_MEDIA', action });
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
          try {
            const response = await chrome.tabs.sendMessage(tabId, msg);
            sendResponse(response);
          } catch {
            sendResponse({ success: false, error: 'Content script not available' });
          }
          break;
        }

        case 'GET_VIDEO_SYNC_STATE': {
          const { tabId } = (msg as { payload: { tabId: number } }).payload;
          try {
            const response = await chrome.tabs.sendMessage(tabId, { type: 'GET_VIDEO_SYNC_STATE' });
            sendResponse(response);
          } catch {
            sendResponse({ state: 'off', enabled: false, trimMs: 0 });
          }
          break;
        }

        // Forward video sync state broadcasts from content script to popup
        case 'VIDEO_SYNC_STATE_CHANGED': {
          notifyPopup(msg);
          sendResponse({ success: true });
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
          log.info('Offscreen document ready');
          // Resolve the ready promise if we're waiting for it
          if (offscreenReadyResolver) {
            offscreenReadyResolver();
          }
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
 * Extracts and validates supported actions from raw payload.
 * @param payload - Raw metadata payload from content script
 * @returns Array of validated media actions
 */
function extractSupportedActions(payload: unknown): MediaAction[] {
  if (!payload || typeof payload !== 'object') return [];
  const raw = (payload as { supportedActions?: unknown }).supportedActions;
  if (!Array.isArray(raw)) return [];

  return raw.filter((action): action is MediaAction => {
    const result = MediaActionSchema.safeParse(action);
    return result.success;
  });
}

/**
 * Extracts and validates playback state from raw payload.
 * @param payload - Raw metadata payload from content script
 * @returns Validated playback state or 'none' if invalid
 */
function extractPlaybackState(payload: unknown): PlaybackState {
  if (!payload || typeof payload !== 'object') return 'none';
  const raw = (payload as { playbackState?: unknown }).playbackState;
  const result = PlaybackStateSchema.safeParse(raw);
  return result.success ? result.data : 'none';
}

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

  // Extract supported actions and playback state from payload
  const supportedActions = extractSupportedActions(msg.payload);
  const playbackState = extractPlaybackState(msg.payload);

  // Derive source from tab URL (single point of derivation per SoC)
  const source = getSourceFromUrl(sender.tab?.url);

  // Preserve existing ogImage if present
  const existing = getCachedState(tabId);
  const tabInfo = {
    title: sender.tab?.title,
    favIconUrl: sender.tab?.favIconUrl,
    ogImage: existing?.tabOgImage,
    source,
  };

  // Update the cache with metadata, supported actions, and playback state
  const state = updateCache(tabId, tabInfo, metadata, supportedActions, playbackState);

  // Notify popup of state change so CurrentTabCard updates
  notifyPopup({ type: 'TAB_STATE_CHANGED', tabId, state });

  // If this tab is casting, notify popup and forward to offscreen
  if (hasSession(tabId)) {
    onMetadataUpdate(tabId);
    // Enrich metadata with source for Sonos display
    forwardMetadataToOffscreen(tabId, { ...msg.payload, source });
  }
}

/**
 * Handles og:image updates from content scripts.
 * Updates the cache with the Open Graph image.
 * Creates a cache entry if one doesn't exist.
 *
 * @param payload - The og:image payload
 * @param payload.ogImage
 * @param sender - The message sender information
 */
function handleTabOgImage(
  payload: { ogImage: string },
  sender: chrome.runtime.MessageSender,
): void {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  // Try to update existing cache entry
  let state = updateTabInfo(tabId, { ogImage: payload.ogImage });

  // If no cache entry exists, create one with og:image
  if (!state) {
    state = updateCache(
      tabId,
      {
        title: sender.tab?.title,
        favIconUrl: sender.tab?.favIconUrl,
        ogImage: payload.ogImage,
      },
      null,
    );
  }

  notifyPopup({ type: 'TAB_STATE_CHANGED', tabId, state });
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
    supportedActions: [],
    playbackState: 'none' as const,
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
    const { speakerIps } = msg.payload;
    if (!speakerIps.length) throw new Error(i18n.t('error_no_speakers_selected'));

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error(i18n.t('error_no_active_tab'));

    // 1. Discover Desktop App and its limits (do this early to fail fast)
    const app = await discoverAndCache();
    if (!app) {
      clearConnectionState();
      throw new Error(i18n.t('error_desktop_not_found'));
    }

    // 2. Check session limits
    if (getSessionCount() >= app.maxStreams) {
      throw new Error(i18n.t('error_max_sessions'));
    }

    // 3. Create offscreen document (needed for audio capture)
    await ensureOffscreen();

    // 4. Select encoder config based on extension settings
    let encoderConfig: EncoderConfig;

    // Load extension settings and cached codec support
    const settings = await loadExtensionSettings();
    const codecCache = await chrome.storage.session.get(CODEC_CACHE_KEY);
    let codecSupport: SupportedCodecsResult | null = codecCache[CODEC_CACHE_KEY] ?? null;

    // If codec support not cached, try to detect now (should rarely happen after startup fix)
    if (!codecSupport || codecSupport.availableCodecs.length === 0) {
      log.info('Codec support not cached, detecting now...');
      codecSupport = await detectAndCacheCodecSupport();
    }

    if (codecSupport && codecSupport.availableCodecs.length > 0) {
      // Use preset resolution with codec detection
      try {
        encoderConfig = resolveAudioMode(
          settings.audioMode,
          codecSupport,
          settings.customAudioSettings,
        );
        log.info(
          `Encoder config (${settings.audioMode} mode): ${describeEncoderConfig(encoderConfig)}`,
        );
      } catch (err) {
        // Preset resolution failed, fall back to device-config
        log.warn('Preset resolution failed, falling back to device config:', err);
        encoderConfig = await selectEncoderConfig();
        log.info(`Encoder config (fallback): ${describeConfig(encoderConfig)}`);
      }
    } else {
      // Codec detection failed entirely, fall back to device-config
      log.warn('Codec detection failed, using device config fallback');
      encoderConfig = await selectEncoderConfig();
      log.info(`Encoder config (fallback): ${describeConfig(encoderConfig)}`);
    }

    // 5. Capture Tab
    const mediaStreamId = await new Promise<string>((resolve, reject) => {
      chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id! }, (id) => {
        if (id) resolve(id);
        else reject(new Error(i18n.t('error_capture_denied')));
      });
    });

    // 6. Connect control WebSocket if not already connected
    if (!getConnectionState().connected) {
      await connectWebSocket(app.url);
    }

    // 7. Start Offscreen Session
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
      // Get cached state to build initial metadata for Sonos display
      const cachedState = getCachedState(tab.id);

      // Construct StreamMetadata with source for proper Sonos album display
      const initialMetadata: StreamMetadata | undefined = cachedState?.metadata
        ? {
            ...cachedState.metadata,
            source: cachedState.source,
          }
        : cachedState?.source
          ? { source: cachedState.source }
          : undefined;

      // 8. Start playback via WebSocket (waits for STREAM_READY internally)
      // Include initial metadata so Sonos displays correct info immediately
      const playbackResponse: StartPlaybackResponse = await chrome.runtime.sendMessage({
        type: 'START_PLAYBACK',
        payload: { tabId: tab.id, speakerIps, metadata: initialMetadata },
      });

      // Filter successful results for session registration
      const successfulResults = playbackResponse.results.filter((r) => r.success);

      if (successfulResults.length === 0) {
        // All speakers failed - clean up the capture
        log.error('All playback attempts failed, cleaning up capture');
        await chrome.runtime.sendMessage({ type: 'STOP_CAPTURE', payload: { tabId: tab.id } });
        throw new Error(i18n.t('error_playback_failed'));
      }

      // Log partial failures
      const failedResults = playbackResponse.results.filter((r) => !r.success);
      if (failedResults.length > 0) {
        for (const failed of failedResults) {
          log.warn(`Playback failed on ${failed.speakerIp}: ${failed.error}`);
        }
      }

      // Build arrays of successful speakers
      const sonosState = getStoredSonosState();
      const successfulIps = successfulResults.map((r) => r.speakerIp);
      const successfulNames = successfulResults.map((r) => {
        const group = sonosState.groups.find((g) => g.coordinatorIp === r.speakerIp);
        return group?.name ?? r.speakerIp;
      });

      // Derive source from tab URL for cache
      const source = getSourceFromUrl(tab.url);

      // Ensure cache has tab info for ActiveCast display (even without MediaSession metadata)
      if (!getCachedState(tab.id)) {
        updateCache(tab.id, { title: tab.title, favIconUrl: tab.favIconUrl, source }, null);
      }

      // Register the session with successful speakers only
      registerSession(tab.id, response.streamId, successfulIps, successfulNames, encoderConfig);

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
      // Disable video sync before stopping capture
      chrome.tabs
        .sendMessage(tabId, {
          type: 'SET_VIDEO_SYNC_ENABLED',
          payload: { tabId, enabled: false },
        })
        .catch(() => {
          // Content script may not be available
        });

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
  if (connState.desktopAppUrl && !connState.connected) {
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
