import type {
  ExtensionMessage,
  StartCastMessage,
  StopCastMessage,
  CastErrorMessage,
  CastEndedMessage,
  ControlMediaMessage,
  SonosEventMessage,
} from '@thaumic-cast/shared';
import { closeOffscreen, markOffscreenReady } from './background/offscreen-manager';
import {
  getMediaSources,
  handleMediaUpdate as updateMediaRegistry,
  purgeTab,
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
import { getExtensionSettings } from './lib/settings';

// Debounce for transport state changes to prevent race conditions from rapid stop/play
let lastTransportStateAt = 0;
const TRANSPORT_STATE_DEBOUNCE_MS = 500;

// Message handler
chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
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
      await closeOffscreen();
      sendResponse({ success: true });
      break;
    }

    case 'CAST_ERROR': {
      const { reason } = message as CastErrorMessage;
      console.error('[Background] Cast error:', reason);
      clearActiveStream();
      break;
    }

    case 'CAST_ENDED': {
      const { reason, streamId } = message as CastEndedMessage;
      console.log('[Background] Cast ended:', reason, streamId);
      clearActiveStream();
      break;
    }

    case 'OFFSCREEN_READY': {
      // Offscreen document is ready to receive messages
      console.log('[Background] Offscreen ready');
      markOffscreenReady();
      break;
    }

    // These messages are for the offscreen document, not us - ignore them
    case 'OFFSCREEN_START':
    case 'OFFSCREEN_STOP':
    case 'OFFSCREEN_PAUSE':
    case 'OFFSCREEN_RESUME':
      break;
    case 'OFFSCREEN_HEARTBEAT': {
      if ((message as { streamId?: string }).streamId) {
        recordHeartbeat((message as { streamId: string }).streamId);
      }
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
          console.log('[Background] Sonos playback stopped, stopping stream (stop mode)');
          clearActiveStream();
          closeOffscreen().catch((err) => {
            console.error('[Background] Failed to close offscreen:', err);
          });
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

    case 'zoneChange': {
      // Zone topology changed (speakers grouped/ungrouped)
      console.log('[Background] Sonos zone configuration changed');
      break;
    }

    case 'sourceChanged': {
      // Sonos switched to a different audio source (user opened Spotify, etc.)
      console.log(
        '[Background] Sonos source changed:',
        `expected=${payload.expectedUri}, current=${payload.currentUri}`
      );
      // Auto-stop cast since we're no longer the active source
      clearActiveStream();
      closeOffscreen().catch((err) => {
        console.error('[Background] Failed to close offscreen:', err);
      });
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

// Clean up media state when tab navigates to a different page
// This handles cases where user navigates away from media page
chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
  // Only react to main frame navigation (not iframes)
  if (frameId === 0) {
    purgeTab(tabId);
  }
});

// Clean up on extension unload
chrome.runtime.onSuspend?.addListener(async () => {
  await stopCurrentStream();
  await closeOffscreen();
});
