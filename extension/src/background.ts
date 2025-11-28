import type {
  ExtensionMessage,
  CastStatus,
  StartCastMessage,
  CastErrorMessage,
  CastEndedMessage,
} from '@thaumic-cast/shared';
import type { CreateStreamResponse } from '@thaumic-cast/shared';

// Active stream state
let activeStream: CastStatus = { isActive: false };

// Offscreen document tracking
let offscreenCreated = false;
let offscreenReadyResolve: (() => void) | null = null;

async function getServerUrl(): Promise<string> {
  const result = (await chrome.storage.sync.get('serverUrl')) as { serverUrl?: string };
  return result.serverUrl || 'http://localhost:3000';
}

async function ensureOffscreen(): Promise<void> {
  if (offscreenCreated) return;

  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });

  if (existingContexts.length > 0) {
    offscreenCreated = true;
    return;
  }

  // Create a promise that resolves when offscreen sends OFFSCREEN_READY
  const readyPromise = new Promise<void>((resolve) => {
    offscreenReadyResolve = resolve;
  });

  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Capture and encode tab audio for streaming to Sonos',
  });

  // Wait for offscreen to signal it's ready (with timeout)
  const timeoutPromise = new Promise<void>((_, reject) =>
    setTimeout(() => reject(new Error('Offscreen ready timeout')), 5000)
  );

  await Promise.race([readyPromise, timeoutPromise]);
  offscreenCreated = true;
}

async function closeOffscreen(): Promise<void> {
  if (!offscreenCreated) return;

  try {
    await chrome.offscreen.closeDocument();
  } catch {
    // Already closed
  }
  offscreenCreated = false;
}

async function stopCurrentStream(): Promise<void> {
  if (!activeStream.isActive || !activeStream.streamId) return;

  // Notify offscreen to stop
  try {
    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_STOP',
      streamId: activeStream.streamId,
    });
  } catch {
    // Offscreen might not exist
  }

  // Notify server
  try {
    const serverUrl = await getServerUrl();
    await fetch(`${serverUrl}/api/streams/${activeStream.streamId}/stop`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // Server might be unavailable
  }

  activeStream = { isActive: false };
}

// Message handler
chrome.runtime.onMessage.addListener((message: ExtensionMessage, _sender, sendResponse) => {
  handleMessage(message, sendResponse);
  return true; // Keep channel open for async response
});

async function handleMessage(
  message: ExtensionMessage,
  sendResponse: (response: unknown) => void
): Promise<void> {
  switch (message.type) {
    case 'GET_STATUS': {
      sendResponse({ status: activeStream });
      break;
    }

    case 'START_CAST': {
      const { tabId, groupId, groupName, quality, mediaStreamId } = message as StartCastMessage;

      // Stop any existing stream
      await stopCurrentStream();

      try {
        const serverUrl = await getServerUrl();

        // Create stream on server
        const response = await fetch(`${serverUrl}/api/streams`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ groupId, quality }),
        });

        if (!response.ok) {
          const error = await response.json();
          sendResponse({ error: error.message || 'Failed to create stream' });
          return;
        }

        const { streamId, ingestUrl } = (await response.json()) as CreateStreamResponse;

        // Ensure offscreen document exists
        await ensureOffscreen();

        // Start capture in offscreen
        console.log('[Background] Sending OFFSCREEN_START with ingestUrl:', ingestUrl);
        const offscreenResult = await chrome.runtime.sendMessage({
          type: 'OFFSCREEN_START',
          streamId,
          mediaStreamId,
          quality,
          ingestUrl,
        });
        console.log('[Background] OFFSCREEN_START response:', offscreenResult);

        // Update state
        activeStream = {
          isActive: true,
          streamId,
          tabId,
          groupId,
          groupName,
          quality,
        };

        sendResponse({ success: true, streamId });
      } catch (err) {
        sendResponse({ error: err instanceof Error ? err.message : 'Unknown error' });
      }
      break;
    }

    case 'STOP_CAST': {
      await stopCurrentStream();
      await closeOffscreen();
      sendResponse({ success: true });
      break;
    }

    case 'CAST_ERROR': {
      const { reason } = message as CastErrorMessage;
      console.error('[Background] Cast error:', reason);
      activeStream = { isActive: false };
      break;
    }

    case 'CAST_ENDED': {
      const { reason, streamId } = message as CastEndedMessage;
      console.log('[Background] Cast ended:', reason, streamId);
      activeStream = { isActive: false };
      break;
    }

    case 'OFFSCREEN_READY': {
      // Offscreen document is ready to receive messages
      console.log('[Background] Offscreen ready');
      if (offscreenReadyResolve) {
        offscreenReadyResolve();
        offscreenReadyResolve = null;
      }
      break;
    }

    // These messages are for the offscreen document, not us - ignore them
    case 'OFFSCREEN_START':
    case 'OFFSCREEN_STOP':
      break;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
}

// Clean up on extension unload
chrome.runtime.onSuspend?.addListener(async () => {
  await stopCurrentStream();
  await closeOffscreen();
});
