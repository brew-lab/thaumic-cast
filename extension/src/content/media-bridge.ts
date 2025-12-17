// ISOLATED world script - has access to chrome.runtime
// Receives media info from MAIN world script via CustomEvent

import type { MediaAction } from '@thaumic-cast/shared';

interface PageMediaInfo {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
  playbackState: string;
  hasMetadata: boolean;
  hasMediaElements?: boolean;
}

let lastSentState: string | null = null;
let currentMediaInfo: PageMediaInfo | null = null;

// Listen for media info from MAIN world script
window.addEventListener('__thaumic_media_info__', ((event: CustomEvent<PageMediaInfo>) => {
  currentMediaInfo = event.detail;
  sendUpdate();
}) as EventListener);

function getMediaInfo() {
  if (!currentMediaInfo) return null;

  const { title, artist, album, artwork, playbackState, hasMetadata, hasMediaElements } =
    currentMediaInfo;

  // Only report if there's media playing, metadata available, or significant media elements on page
  // This keeps paused sources visible as long as they have media content
  if (playbackState === 'none' && !hasMetadata && !hasMediaElements) {
    return null;
  }

  return {
    title,
    artist,
    album,
    artwork,
    isPlaying: playbackState === 'playing',
    lastUpdated: Date.now(),
    hasMetadata,
  };
}

function sendUpdate() {
  const mediaInfo = getMediaInfo();

  const stateSignature = mediaInfo
    ? JSON.stringify({
        title: mediaInfo.title,
        artist: mediaInfo.artist,
        isPlaying: mediaInfo.isPlaying,
      })
    : null;

  const stateChanged = stateSignature !== lastSentState;
  lastSentState = stateSignature;

  // Always send if we have media (to keep it alive), or if state changed to null
  if (mediaInfo || stateChanged) {
    chrome.runtime
      .sendMessage({
        type: 'MEDIA_UPDATE',
        media: mediaInfo,
      })
      .catch(() => {
        // Extension context invalidated
      });
  }
}

// Handle control commands from popup
function handleControl(action: MediaAction) {
  if (action === 'play' || action === 'pause') {
    document.querySelectorAll('video, audio').forEach((el) => {
      const media = el as HTMLMediaElement;
      if (action === 'play' && media.paused) {
        media.play().catch(() => {});
      } else if (action === 'pause' && !media.paused) {
        media.pause();
      }
    });
  }

  if (action === 'previoustrack' || action === 'nexttrack') {
    const selectors =
      action === 'previoustrack'
        ? ['[aria-label*="previous" i]', '[aria-label*="prev" i]', '[title*="previous" i]']
        : ['[aria-label*="next" i]', '[title*="next" i]'];

    for (const selector of selectors) {
      const button = document.querySelector(selector) as HTMLElement;
      if (button) {
        button.click();
        break;
      }
    }
  }

  // Request updated media info
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('__thaumic_request_media__'));
  }, 200);
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'CONTROL_MEDIA') {
    handleControl(message.action as MediaAction);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'GET_MEDIA_STATE') {
    sendResponse({ media: getMediaInfo() });
    return true;
  }

  return false;
});

// When tab becomes visible, request immediate media update
// This helps recover state after background tab throttling
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    window.dispatchEvent(new CustomEvent('__thaumic_request_media__'));
  }
});

// Note: We intentionally do NOT send null on beforeunload because:
// 1. SPA sites trigger beforeunload during normal navigation
// 2. The tab close handler (onRemoved) in background.ts handles cleanup
// 3. Sending null here causes sources to disappear prematurely
