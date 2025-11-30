import type {
  ExtensionMessage,
  CastStatus,
  StartCastMessage,
  StopCastMessage,
  CastErrorMessage,
  CastEndedMessage,
  SonosMode,
  MediaInfo,
  ControlMediaMessage,
} from '@thaumic-cast/shared';
import type { CreateStreamResponse } from '@thaumic-cast/shared';
import { API_TIMEOUT_MS } from '@thaumic-cast/shared';

// Active stream state
let activeStream: CastStatus = { isActive: false };

// Media state tracking for all tabs
const mediaByTab = new Map<number, MediaInfo>();

// Track when each tab's media was first detected (for stable sorting)
const firstDetectedByTab = new Map<number, number>();

/**
 * Fetch with timeout support
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw err;
  }
}

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

async function stopCurrentStream(mode?: SonosMode, coordinatorIp?: string): Promise<void> {
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

  const serverUrl = await getServerUrl();

  // For local mode, stop playback on the speaker
  const effectiveMode = mode || activeStream.mode;
  const effectiveIp = coordinatorIp || activeStream.coordinatorIp;

  if (effectiveMode === 'local' && effectiveIp) {
    try {
      await fetchWithTimeout(
        `${serverUrl}/api/local/stop`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ coordinatorIp: effectiveIp }),
        },
        5000 // Shorter timeout for stop operations
      );
    } catch {
      // Server might be unavailable - continue with cleanup
      console.warn('[Background] Failed to stop playback on speaker');
    }
  }

  // Notify server to clean up stream
  try {
    await fetchWithTimeout(
      `${serverUrl}/api/streams/${activeStream.streamId}/stop`,
      {
        method: 'POST',
        credentials: 'include',
      },
      5000
    );
  } catch {
    // Server might be unavailable - continue with cleanup
    console.warn('[Background] Failed to notify server of stream stop');
  }

  activeStream = { isActive: false };
}

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
      sendResponse({ status: activeStream });
      break;
    }

    case 'START_CAST': {
      const { tabId, groupId, groupName, quality, mediaStreamId, mode, coordinatorIp } =
        message as StartCastMessage;

      // Stop any existing stream
      await stopCurrentStream();

      try {
        const serverUrl = await getServerUrl();
        const isLocalMode = mode === 'local';

        // Create stream on server
        // For local mode, pass mode='local' so server doesn't call Sonos Cloud API
        const response = await fetchWithTimeout(`${serverUrl}/api/streams`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            groupId,
            quality,
            mode: isLocalMode ? 'local' : 'cloud',
            coordinatorIp: isLocalMode ? coordinatorIp : undefined,
          }),
        });

        if (!response.ok) {
          const error = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
          sendResponse({ error: error.message || 'Failed to create stream' });
          return;
        }

        const { streamId, ingestUrl, playbackUrl } =
          (await response.json()) as CreateStreamResponse;

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

        // For local mode, tell Sonos to play the stream via UPnP
        let localPlayError: string | null = null;
        if (isLocalMode && coordinatorIp) {
          console.log('[Background] Starting local playback on', coordinatorIp);

          // Small delay to allow some frames to buffer
          await new Promise((resolve) => setTimeout(resolve, 500));

          try {
            const playResponse = await fetchWithTimeout(`${serverUrl}/api/local/play`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              credentials: 'include',
              body: JSON.stringify({
                coordinatorIp,
                streamUrl: playbackUrl,
              }),
            });

            if (!playResponse.ok) {
              const error = await playResponse.json().catch(() => ({ message: 'Unknown error' }));
              localPlayError = error.message || 'Failed to start playback on speaker';
              console.error('[Background] Local play failed:', localPlayError);
            }
          } catch (err) {
            localPlayError = err instanceof Error ? err.message : 'Failed to connect to speaker';
            console.error('[Background] Local play error:', localPlayError);
          }
        }

        // Update state
        activeStream = {
          isActive: true,
          streamId,
          tabId,
          groupId,
          groupName,
          quality,
          mode: isLocalMode ? 'local' : 'cloud',
          coordinatorIp: isLocalMode ? coordinatorIp : undefined,
        };

        // Return success but include warning if local play had issues
        if (localPlayError) {
          sendResponse({
            success: true,
            streamId,
            warning: `Streaming started but speaker may not be playing: ${localPlayError}`,
          });
        } else {
          sendResponse({ success: true, streamId });
        }
      } catch (err) {
        const errorMessage =
          err instanceof Error
            ? err.message.includes('timed out')
              ? 'Server connection timed out. Check server URL in settings.'
              : err.message
            : 'Unknown error';
        sendResponse({ error: errorMessage });
      }
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

    // Media detection messages
    case 'MEDIA_UPDATE': {
      handleMediaUpdate(message.media, sender);
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

// Handle media update from content script
function handleMediaUpdate(
  media: Omit<MediaInfo, 'tabId' | 'tabTitle' | 'tabFavicon'> | null,
  sender: chrome.runtime.MessageSender
) {
  const tabId = sender.tab?.id;
  console.log('[Background] Media update from tab', tabId, media);
  if (!tabId) return;

  if (!media) {
    // Tab no longer has media
    mediaByTab.delete(tabId);
    firstDetectedByTab.delete(tabId);
    return;
  }

  // Track when this source was first detected (for stable ordering)
  if (!firstDetectedByTab.has(tabId)) {
    firstDetectedByTab.set(tabId, Date.now());
  }

  // Build full media info with tab details
  const fullInfo: MediaInfo = {
    tabId,
    tabTitle: sender.tab?.title || 'Unknown tab',
    tabFavicon: sender.tab?.favIconUrl,
    title: media.title,
    artist: media.artist,
    album: media.album,
    artwork: media.artwork,
    isPlaying: media.isPlaying,
    lastUpdated: Date.now(),
    hasMetadata: media.hasMetadata ?? false,
  };

  mediaByTab.set(tabId, fullInfo);
}

// Get all active media sources, sorted by first detected (stable order)
// Verifies tabs still exist and removes stale entries
async function getMediaSources(): Promise<MediaInfo[]> {
  const sources: MediaInfo[] = [];

  // Verify each tab still exists and collect valid sources
  for (const [tabId, info] of mediaByTab) {
    try {
      await chrome.tabs.get(tabId);
      // Tab exists, include this source
      sources.push(info);
    } catch {
      // Tab no longer exists, clean up
      mediaByTab.delete(tabId);
      firstDetectedByTab.delete(tabId);
    }
  }

  // Stable sort by first detected time only (oldest first)
  // Do NOT sort by playing status to avoid UI jumping
  sources.sort((a, b) => {
    const aFirst = firstDetectedByTab.get(a.tabId) || 0;
    const bFirst = firstDetectedByTab.get(b.tabId) || 0;
    return aFirst - bFirst;
  });

  return sources;
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
  mediaByTab.delete(tabId);
  firstDetectedByTab.delete(tabId);
});

// Clean up media state when tab navigates to a different page
// This handles cases where user navigates away from media page
chrome.webNavigation.onBeforeNavigate.addListener(({ tabId, frameId }) => {
  // Only react to main frame navigation (not iframes)
  if (frameId === 0) {
    mediaByTab.delete(tabId);
    firstDetectedByTab.delete(tabId);
  }
});

// Clean up on extension unload
chrome.runtime.onSuspend?.addListener(async () => {
  await stopCurrentStream();
  await closeOffscreen();
});
