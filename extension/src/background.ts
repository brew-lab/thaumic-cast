import type {
  ExtensionMessage,
  StartCastMessage,
  StopCastMessage,
  CastErrorMessage,
  CastEndedMessage,
  ControlMediaMessage,
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
} from './background/stream-manager';

// Message handler
chrome.runtime.onMessage.addListener((message: ExtensionMessage, sender, sendResponse) => {
  handleMessage(message, sender, sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(
  message: ExtensionMessage & { media?: unknown },
  sender: chrome.runtime.MessageSender,
  sendResponse: (response: unknown) => void
): Promise<void> {
  switch (message.type) {
    case 'GET_STATUS': {
      sendResponse({ status: getActiveStream() });
      break;
    }

    case 'START_CAST': {
      const { tabId, groupId, groupName, quality, mediaStreamId, mode, coordinatorIp } =
        message as StartCastMessage;

      const result = await startStream({
        tabId,
        groupId,
        groupName,
        quality,
        mediaStreamId,
        mode: mode || 'cloud',
        coordinatorIp,
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
      break;

    // Media detection messages
    case 'MEDIA_UPDATE': {
      updateMediaRegistry(message.media, sender);
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
