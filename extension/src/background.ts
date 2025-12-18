import type {
  ExtensionMessage,
  StartCastMessage,
  StopCastMessage,
  CastErrorMessage,
  CastEndedMessage,
  ControlMediaMessage,
  SonosEventMessage,
  WsConnectedMessage,
  WsResponseMessage,
  ConnectWsMessage,
  WsAction,
  SonosStateSnapshot,
} from '@thaumic-cast/shared';
import {
  closeOffscreen,
  markOffscreenReady,
  ensureOffscreen,
  recoverOffscreenState,
  sendToOffscreen,
} from './background/offscreen-manager';
import {
  getMediaSources,
  handleMediaUpdate as updateMediaRegistry,
  purgeTab,
  restoreState as restoreMediaState,
} from './background/media-registry';
import {
  startStream,
  stopCurrentStream,
  getActiveStream,
  clearActiveStream,
  pauseActiveStream,
  resumeActiveStream,
  recordHeartbeat,
  updateStreamMetadata,
} from './background/stream-manager';
import {
  sendWsCommand,
  handleWsResponse,
  setWsConnected,
  setWsDisconnected,
  getSonosState,
  updateSonosState,
  isWsConnected,
  restoreWsState,
} from './background/ws-client';
import { getExtensionSettings } from './lib/settings';

// Re-export for external use
export { sendWsCommand, getSonosState, isWsConnected };

// Init gate - messages wait for this before processing
let initResolve: () => void = () => {};
const initPromise = new Promise<void>((resolve) => {
  initResolve = resolve;
});

function signalInitComplete(): void {
  initResolve();
}

// Restore state on service worker startup
(async () => {
  console.log('[Background] Service worker starting, recovering state...');

  // Restore media state (survives service worker unloads)
  try {
    await restoreMediaState();
  } catch (err) {
    console.error('[Background] Failed to restore media state:', err);
  }

  // Check if offscreen document exists from before service worker restart
  const offscreenExists = await recoverOffscreenState();
  if (offscreenExists) {
    // Query offscreen for current WebSocket state to sync background state
    try {
      const wsStatus = await sendToOffscreen<{
        connected: boolean;
        url?: string;
        reconnectAttempts?: number;
        state?: SonosStateSnapshot;
      }>({ type: 'GET_WS_STATUS' });

      // Restore state if offscreen has a WebSocket connection (even if reconnecting)
      // or if it has cached Sonos state
      if (wsStatus?.url || wsStatus?.state) {
        restoreWsState(wsStatus.state ?? null, wsStatus.connected ?? false);
        console.log('[Background] Recovered WebSocket state', {
          connected: wsStatus.connected,
          hasState: !!wsStatus.state,
          groupCount: wsStatus.state?.groups?.length ?? 0,
          reconnectAttempts: wsStatus.reconnectAttempts,
        });

        // If not currently connected but has URL, trigger reconnection
        if (!wsStatus.connected && wsStatus.url) {
          console.log('[Background] Triggering WebSocket reconnection...');
          sendToOffscreen({ type: 'WS_RECONNECT' }).catch(() => {
            // Ignore errors - best effort reconnection
          });
        }
      }
    } catch (err) {
      console.warn('[Background] Failed to query offscreen WS status:', err);
    }
  }

  // Signal that init is complete
  console.log('[Background] Service worker init complete');
  signalInitComplete();
})();

/**
 * Connect to the server WebSocket via offscreen document.
 */
export async function connectWebSocket(serverUrl: string): Promise<void> {
  await ensureOffscreen();

  const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws';
  console.log('[Background] Connecting WebSocket to:', wsUrl);

  await sendToOffscreen({
    type: 'WS_CONNECT',
    url: wsUrl,
  });
}

/**
 * Disconnect from the server WebSocket.
 */
export function disconnectWebSocket(): void {
  setWsDisconnected();

  sendToOffscreen({ type: 'WS_DISCONNECT' }).catch(() => {
    // Offscreen may not exist
  });
}

/**
 * Attempt to reconnect WebSocket (resets reconnect attempt counter).
 * Can be called after permanent disconnection to retry.
 */
export async function reconnectWebSocket(serverUrl?: string): Promise<void> {
  if (serverUrl) {
    await connectWebSocket(serverUrl);
  } else {
    // Try to reconnect using existing URL in offscreen
    await ensureOffscreen();
    await sendToOffscreen({ type: 'WS_RECONNECT' });
  }
}

// Debounce for transport state changes to prevent race conditions from rapid stop/play
let lastTransportStateAt = 0;
const TRANSPORT_STATE_DEBOUNCE_MS = 500;

/**
 * Update Sonos state and sync to offscreen cache.
 * This ensures offscreen has the latest state for service worker recovery.
 */
function updateAndSyncSonosState(state: SonosStateSnapshot): void {
  updateSonosState(state);
  // Sync to offscreen so it can restore state if service worker restarts
  sendToOffscreen({ type: 'SYNC_SONOS_STATE', state }).catch(() => {
    // Offscreen may not exist
  });
}

// Message handler
chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  // Wait for init to complete before processing messages
  // This prevents race conditions when service worker wakes up
  initPromise.then(() => handleMessage(message, sender, sendResponse));
  return true; // Keep channel open for async response
});

async function handleMessage(
  message: (ExtensionMessage | { type: 'OFFSCREEN_HEARTBEAT'; streamId?: string }) & {
    media?: unknown;
  },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): Promise<void> {
  switch (message.type) {
    case 'GET_STATUS': {
      sendResponse({ status: getActiveStream() });
      break;
    }

    case 'GET_SONOS_STATE': {
      sendResponse({ state: getSonosState(), connected: isWsConnected() });
      break;
    }

    case 'START_CAST': {
      const { tabId, groupId, groupName, quality, mediaStreamId, mode, coordinatorIp, metadata } =
        message as StartCastMessage;

      const result = await startStream({
        tabId,
        groupId,
        groupName,
        quality,
        mediaStreamId,
        mode: mode || 'cloud',
        coordinatorIp,
        metadata,
      });

      sendResponse(result);
      break;
    }

    case 'STOP_CAST': {
      const { mode, coordinatorIp } = message as StopCastMessage;
      await stopCurrentStream(mode, coordinatorIp);
      // Note: Don't close offscreen - it maintains the WebSocket for events
      sendResponse({ success: true });
      break;
    }

    case 'CAST_ERROR': {
      const { reason } = message as CastErrorMessage;
      console.error('[Background] Cast error:', reason);
      clearActiveStream();
      sendResponse({ success: true });
      break;
    }

    case 'CAST_ENDED': {
      const { reason, streamId } = message as CastEndedMessage;
      console.log('[Background] Cast ended:', reason, streamId);
      clearActiveStream();
      sendResponse({ success: true });
      break;
    }

    case 'OFFSCREEN_READY': {
      // Offscreen document is ready to receive messages
      console.log('[Background] Offscreen ready');
      markOffscreenReady();
      sendResponse({ success: true });
      break;
    }

    // These messages are for the offscreen document, not us - ignore them
    case 'OFFSCREEN_START':
    case 'OFFSCREEN_STOP':
    case 'OFFSCREEN_PAUSE':
    case 'OFFSCREEN_RESUME':
      sendResponse({ success: true });
      break;
    case 'OFFSCREEN_HEARTBEAT': {
      if ((message as { streamId?: string }).streamId) {
        recordHeartbeat((message as { streamId: string }).streamId);
      }
      sendResponse({ success: true });
      break;
    }

    // Media detection messages
    case 'MEDIA_UPDATE': {
      updateMediaRegistry(message.media, sender);
      // Update Sonos metadata if casting from this tab
      if (message.media && sender.tab?.id) {
        updateStreamMetadata(sender.tab.id, {
          title: message.media.title,
          artist: message.media.artist,
          album: message.media.album,
          artwork: message.media.artwork,
        });
      }
      sendResponse({ success: true });
      break;
    }

    case 'GET_MEDIA_SOURCES': {
      const sources = await getMediaSources();
      console.log('[Background] GET_MEDIA_SOURCES returning:', sources);
      sendResponse({ sources });
      break;
    }

    case 'CONTROL_MEDIA': {
      handleMediaControl(message as ControlMediaMessage, sendResponse);
      break;
    }

    case 'SONOS_EVENT': {
      handleSonosEvent(message as SonosEventMessage);
      sendResponse({ success: true });
      break;
    }

    case 'WS_CONNECTED': {
      const { state } = message as WsConnectedMessage;
      console.log('[Background] WebSocket connected with initial state:', state);
      setWsConnected(state);
      // Notify popup of state change
      chrome.runtime
        .sendMessage({
          type: 'WS_STATE_CHANGED',
          state,
        })
        .catch(() => {
          // Popup may not be open
        });
      sendResponse({ success: true });
      break;
    }

    case 'WS_RESPONSE': {
      const { id, success, data, error } = message as WsResponseMessage;
      handleWsResponse(id, success, data, error);
      sendResponse({ success: true });
      break;
    }

    case 'WS_PERMANENTLY_DISCONNECTED': {
      console.warn('[Background] WebSocket permanently disconnected after max retries');
      setWsDisconnected();
      // Notify popup of connection loss
      chrome.runtime
        .sendMessage({
          type: 'WS_CONNECTION_LOST',
          reason: 'max_retries_exceeded',
        })
        .catch(() => {
          // Popup may not be open
        });
      sendResponse({ success: true });
      break;
    }

    case 'CONNECT_WS': {
      const { serverUrl } = message as ConnectWsMessage;
      connectWebSocket(serverUrl)
        .then(() => sendResponse({ success: true }))
        .catch((err) => sendResponse({ success: false, error: err.message }));
      break;
    }

    case 'DISCONNECT_WS': {
      disconnectWebSocket();
      sendResponse({ success: true });
      break;
    }

    case 'SET_MUTE': {
      const { speakerIp, mute } = message as { speakerIp: string; mute: boolean };
      if (isWsConnected()) {
        sendWsCommand('setMute' as WsAction, { speakerIp, mute })
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
      } else {
        sendResponse({ success: false, error: 'WebSocket not connected' });
      }
      break;
    }

    case 'SET_VOLUME': {
      const { speakerIp, volume } = message as { speakerIp: string; volume: number };
      if (isWsConnected()) {
        sendWsCommand('setVolume' as WsAction, { speakerIp, volume })
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
      } else {
        sendResponse({ success: false, error: 'WebSocket not connected' });
      }
      break;
    }

    case 'SIMULATE_MEDIA_KEY': {
      const { key } = message as { key: string };
      if (isWsConnected()) {
        console.log('[Background] Simulating media key via desktop app:', key);
        sendWsCommand('simulateMediaKey' as WsAction, { key })
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
      } else {
        console.warn('[Background] Cannot simulate media key: desktop app not connected');
        sendResponse({ success: false, error: 'Desktop app not connected' });
      }
      break;
    }

    // Ignore messages meant for offscreen (handled by offscreen.ts)
    case 'WS_CONNECT':
    case 'WS_DISCONNECT':
    case 'WS_COMMAND':
      sendResponse({ success: true });
      break;

    default:
      console.warn('[Background] Unknown message type:', message.type);
      sendResponse({ error: 'Unknown message type' });
  }
}

// Forward media control command to content script
async function handleMediaControl(
  message: ControlMediaMessage,
  sendResponse: (response: unknown) => void
) {
  const { tabId, action } = message;

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'CONTROL_MEDIA',
      action,
    });
    sendResponse({ success: true });
  } catch (err) {
    console.error('[Background] Failed to send control to tab:', err);
    sendResponse({ error: 'Failed to control media' });
  }
}

// Handle Sonos events from server (via WebSocket)
async function handleSonosEvent(message: SonosEventMessage): Promise<void> {
  const { payload } = message;

  console.log('[Background] Received Sonos event:', payload.type, payload);

  switch (payload.type) {
    case 'transportState': {
      // Debounce rapid transport state changes to prevent race conditions
      const now = Date.now();
      if (now - lastTransportStateAt < TRANSPORT_STATE_DEBOUNCE_MS) {
        console.log('[Background] Ignoring transport state change (debounced)');
        break;
      }
      lastTransportStateAt = now;

      if (payload.state === 'STOPPED') {
        // User pressed stop in Sonos app - check settings for behavior
        const settings = await getExtensionSettings();

        if (settings.stopBehavior === 'pause') {
          // Pause mode: keep stream alive, just pause capture
          console.log('[Background] Sonos playback stopped, pausing stream (pause mode)');
          pauseActiveStream().catch((err) => {
            console.error('[Background] Failed to pause stream:', err);
          });
        } else {
          // Stop mode (default): tear everything down
          // Note: Don't close offscreen - keep WS alive for event monitoring
          console.log('[Background] Sonos playback stopped, stopping stream (stop mode)');
          await stopCurrentStream();
        }
      } else if (payload.state === 'PLAYING') {
        // Check if we have a paused stream to resume
        const stream = getActiveStream();
        if (stream.isActive && stream.isPaused) {
          console.log('[Background] Sonos playback resumed, resuming stream');
          resumeActiveStream().catch((err) => {
            console.error('[Background] Failed to resume stream:', err);
          });
        }
      }
      break;
    }

    case 'zoneGroupsUpdated': {
      // Zone topology changed - groups data included directly (from desktop)
      console.log('[Background] Zone groups updated:', payload.groups.length, 'groups');
      const currentState = getSonosState();
      if (currentState) {
        const updatedState = {
          ...currentState,
          groups: payload.groups as SonosStateSnapshot['groups'],
        };
        updateAndSyncSonosState(updatedState);
        // Notify popup of updated groups
        chrome.runtime
          .sendMessage({
            type: 'WS_STATE_CHANGED',
            state: updatedState,
          })
          .catch(() => {
            // Popup may not be open
          });
      }
      break;
    }

    case 'zoneChange': {
      // Legacy event from cloud server (no data included, must fetch)
      // Desktop now sends zoneGroupsUpdated instead, so this is cloud-only
      console.log('[Background] Zone change (legacy), fetching groups');
      if (isWsConnected()) {
        sendWsCommand('getGroups' as WsAction)
          .then((data) => {
            if (data && Array.isArray(data.groups)) {
              const currentState = getSonosState();
              if (currentState) {
                const updatedState = {
                  ...currentState,
                  groups: data.groups as SonosStateSnapshot['groups'],
                };
                updateAndSyncSonosState(updatedState);
                chrome.runtime
                  .sendMessage({
                    type: 'WS_STATE_CHANGED',
                    state: updatedState,
                  })
                  .catch(() => {});
              }
            }
          })
          .catch((err) => {
            console.error('[Background] Failed to fetch groups after zoneChange:', err);
          });
      }
      break;
    }

    case 'sourceChanged': {
      // Sonos switched to a different audio source (user opened Spotify, etc.)
      console.log(
        '[Background] Sonos source changed:',
        `expected=${payload.expectedUri}, current=${payload.currentUri}`
      );
      // Fully stop stream (releases tab capture, clears server state)
      // Note: Don't close offscreen - keep WS alive for event monitoring
      await stopCurrentStream();
      // Notify popup that source changed
      chrome.runtime
        .sendMessage({
          type: 'SOURCE_CHANGED',
          currentUri: payload.currentUri,
          expectedUri: payload.expectedUri,
        })
        .catch(() => {
          // Popup may not be open
        });
      break;
    }

    case 'groupVolume': {
      // Group volume changed - this is the combined volume for all speakers in the group
      console.log('[Background] Sonos group volume changed:', payload.volume);

      // Persist in currentSonosState for when popup opens
      const volumeState = getSonosState();
      if (volumeState && payload.speakerIp) {
        const updatedStatuses = volumeState.group_statuses.map((s) =>
          s.coordinatorIp === payload.speakerIp ? { ...s, volume: payload.volume } : s
        );
        updateAndSyncSonosState({ ...volumeState, group_statuses: updatedStatuses });
      }

      chrome.runtime
        .sendMessage({
          type: 'VOLUME_UPDATE',
          volume: payload.volume,
          speakerIp: payload.speakerIp,
        })
        .catch(() => {
          // Popup may not be open
        });
      break;
    }

    case 'groupMute': {
      // Group mute state changed
      console.log('[Background] Sonos group mute changed:', payload.mute);

      // Persist in currentSonosState for when popup opens
      const muteState = getSonosState();
      if (muteState && payload.speakerIp) {
        const updatedStatuses = muteState.group_statuses.map((s) =>
          s.coordinatorIp === payload.speakerIp ? { ...s, isMuted: payload.mute } : s
        );
        updateAndSyncSonosState({ ...muteState, group_statuses: updatedStatuses });
      }

      chrome.runtime
        .sendMessage({
          type: 'MUTE_UPDATE',
          mute: payload.mute,
          speakerIp: payload.speakerIp,
        })
        .catch(() => {
          // Popup may not be open
        });
      break;
    }
  }
}

// Clean up media state when tabs close
chrome.tabs.onRemoved.addListener((tabId) => {
  purgeTab(tabId);
});

// Note: We intentionally do NOT purge on navigation (onBeforeNavigate) because:
// 1. SPA sites like YouTube/Spotify trigger navigation events during normal use
// 2. The content script will send null when media truly stops
// 3. Tab close (onRemoved) handles cleanup when tabs are closed

// Listen for tab audio state changes - this is how the browser knows audio is playing
// When a tab becomes audible, request media info from content script
// This catches cases where MediaSession was set up before our interceptor ran
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.audible === true) {
    console.log('[Background] Tab became audible:', tabId);
    // Request media info from content script
    chrome.tabs
      .sendMessage(tabId, { type: 'GET_MEDIA_STATE' })
      .then((response) => {
        if (response?.media) {
          console.log('[Background] Got media info from audible tab:', response.media);
          // Process as if we received a MEDIA_UPDATE
          chrome.tabs.get(tabId).then((tab) => {
            updateMediaRegistry(response.media, { tab });
          });
        }
      })
      .catch(() => {
        // Content script not loaded yet - this is fine, it will send update when ready
      });
  }
});

// Clean up on extension unload
chrome.runtime.onSuspend?.addListener(async () => {
  await stopCurrentStream();
  await closeOffscreen();
});
