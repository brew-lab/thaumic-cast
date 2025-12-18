// ISOLATED world script - has access to chrome.runtime
// Receives media info from MAIN world script via CustomEvent

console.log('[ThaumicCast Bridge] media-bridge.ts loaded');

import type { MediaAction } from '@thaumic-cast/shared';

/**
 * Check if the extension context is still valid.
 * Context becomes invalid when the extension is reloaded/updated
 * or the service worker restarts in certain conditions.
 */
function isContextValid(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}

interface PageMediaInfo {
  title?: string;
  artist?: string;
  album?: string;
  artwork?: string;
  playbackState: string;
  hasMetadata: boolean;
  hasMediaElements?: boolean;
  // Position state from MediaSession.setPositionState()
  duration?: number;
  position?: number;
  // Actions the site has registered handlers for
  supportedActions?: string[];
}

let lastSentState: string | null = null;
let currentMediaInfo: PageMediaInfo | null = null;

// Listen for media info from MAIN world script
console.log('[ThaumicCast Bridge] Setting up __thaumic_media_info__ listener');
window.addEventListener('__thaumic_media_info__', ((event: CustomEvent<PageMediaInfo>) => {
  console.log('[ThaumicCast Bridge] Received media info from MAIN world:', event.detail?.title);
  currentMediaInfo = event.detail;
  sendUpdate();
}) as EventListener);

function getMediaInfo() {
  if (!currentMediaInfo) return null;

  const {
    title,
    artist,
    album,
    artwork,
    playbackState,
    hasMetadata,
    hasMediaElements,
    duration,
    position,
    supportedActions,
  } = currentMediaInfo;

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
    duration,
    position,
    supportedActions,
  };
}

function sendUpdate() {
  // Don't try to send if extension context is invalid
  if (!isContextValid()) {
    console.log('[ThaumicCast Bridge] sendUpdate: context invalid, skipping');
    return;
  }

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
    console.log('[ThaumicCast Bridge] Sending MEDIA_UPDATE to background:', mediaInfo?.title);
    chrome.runtime
      .sendMessage({
        type: 'MEDIA_UPDATE',
        media: mediaInfo,
      })
      .then(() => {
        console.log('[ThaumicCast Bridge] MEDIA_UPDATE sent successfully');
      })
      .catch((err) => {
        console.error('[ThaumicCast Bridge] Failed to send MEDIA_UPDATE:', err);
      });
  }
}
// Handle control commands from popup
function handleControl(action: MediaAction) {
  console.log('[ThaumicCast Bridge] handleControl called with action:', action);

  if (action === 'play' || action === 'pause') {
    const mediaElements = document.querySelectorAll('video, audio');
    console.log('[ThaumicCast Bridge] Found', mediaElements.length, 'media elements');

    let handled = false;

    if (mediaElements.length > 0) {
      // Standard approach: control media elements directly
      mediaElements.forEach((el) => {
        const media = el as HTMLMediaElement;
        console.log(
          '[ThaumicCast Bridge] Media element:',
          media.tagName,
          'paused:',
          media.paused,
          'src:',
          media.src?.slice(0, 50)
        );
        if (action === 'play' && media.paused) {
          media.play().catch((err) => {
            console.error('[ThaumicCast Bridge] play() failed:', err);
          });
          handled = true;
        } else if (action === 'pause' && !media.paused) {
          media.pause();
          handled = true;
        }
      });
    }

    // If no media elements or they didn't work, try clicking the page's play/pause button
    // This works around browser autoplay restrictions since it's a real DOM click
    if (!handled) {
      console.log('[ThaumicCast Bridge] No media elements, trying to click play/pause button');
      const playPauseSelectors = [
        // Generic play/pause buttons
        '[aria-label*="play" i]',
        '[aria-label*="pause" i]',
        '[title*="play" i]',
        '[title*="pause" i]',
        // BBC Sounds specific
        'button[class*="PlayButton"]',
        'button[class*="play"]',
        '[data-testid="play-button"]',
        '[data-testid="pause-button"]',
        // Common player classes
        '.play-button',
        '.pause-button',
        '.playPauseButton',
        // SMP (BBC's Standard Media Player)
        '.smp-play-button',
        '.smp-pause-button',
        '[class*="playback-control"]',
      ];

      for (const selector of playPauseSelectors) {
        const button = document.querySelector(selector) as HTMLElement;
        if (button && button.offsetParent !== null) {
          // Check it's visible
          console.log('[ThaumicCast Bridge] Clicking play/pause button:', selector);
          button.click();
          handled = true;
          break;
        }
      }

      // Last resort: simulate OS media key via desktop app
      // This works for Web Audio API players like BBC that don't use <audio> elements
      if (!handled) {
        console.log('[ThaumicCast Bridge] No buttons found, requesting OS media key simulation');
        chrome.runtime
          .sendMessage({
            type: 'SIMULATE_MEDIA_KEY',
            key: 'play_pause',
          })
          .catch((err) => {
            console.error('[ThaumicCast Bridge] Failed to send SIMULATE_MEDIA_KEY:', err);
          });
      }
    }
  }

  if (action === 'previoustrack' || action === 'nexttrack') {
    // Use OS media key simulation for track navigation
    // This is the most reliable approach for all player types
    const key = action === 'previoustrack' ? 'previous' : 'next';
    console.log('[ThaumicCast Bridge] Requesting OS media key simulation for:', key);
    chrome.runtime
      .sendMessage({
        type: 'SIMULATE_MEDIA_KEY',
        key,
      })
      .catch((err) => {
        console.error('[ThaumicCast Bridge] Failed to send SIMULATE_MEDIA_KEY:', err);
      });

    // Also try DOM button click as fallback
    const selectors =
      action === 'previoustrack'
        ? ['[aria-label*="previous" i]', '[aria-label*="prev" i]', '[title*="previous" i]']
        : ['[aria-label*="next" i]', '[title*="next" i]'];

    for (const selector of selectors) {
      const button = document.querySelector(selector) as HTMLElement;
      if (button) {
        console.log('[ThaumicCast Bridge] Clicking button for', action, ':', selector);
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
// Note: When context is invalidated, Chrome automatically stops delivering messages
// but we still guard sendResponse calls to be safe
console.log('[ThaumicCast Bridge] Setting up message listener, context valid:', isContextValid());
if (isContextValid()) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    console.log('[ThaumicCast Bridge] Received message:', message.type);

    // Double-check context is still valid before responding
    if (!isContextValid()) {
      console.log('[ThaumicCast Bridge] Context invalid, ignoring message');
      return false;
    }

    if (message.type === 'CONTROL_MEDIA') {
      console.log('[ThaumicCast Bridge] CONTROL_MEDIA received, action:', message.action);
      handleControl(message.action as MediaAction);
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'GET_MEDIA_STATE') {
      console.log('[ThaumicCast Bridge] GET_MEDIA_STATE received');
      sendResponse({ media: getMediaInfo() });
      return true;
    }

    return false;
  });
}

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
