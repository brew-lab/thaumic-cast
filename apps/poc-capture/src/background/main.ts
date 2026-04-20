/**
 * Background Service Worker
 *
 * Handles tab capture initiation, offscreen document lifecycle,
 * and message relay between popup and offscreen.
 */

import type {
  PopupToBackgroundMessage,
  RelayMessage,
  CaptureConfig,
  CaptureStats,
} from '../lib/messages';

let capturing = false;

// ─────────────────────────────────────────────────────────────────────────────
// Offscreen Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ensures the offscreen document exists, creating it if needed.
 */
async function ensureOffscreen(): Promise<void> {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
  });
  if (contexts.length > 0) return;

  await chrome.offscreen.createDocument({
    url: 'src/offscreen/offscreen.html',
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: 'Tab audio capture via getUserMedia + MSTP',
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Keepalive Port (prevents SW idle timeout during capture)
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'capture-keepalive') {
    port.onDisconnect.addListener(() => {
      // Offscreen disconnected — reset capture state
      capturing = false;
    });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// State Query (for popup reopen)
// ─────────────────────────────────────────────────────────────────────────────

/** Last stats received, cached for popup state recovery. */
let lastStats: CaptureStats | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Message Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Relays a message to the popup. Fails silently if popup is closed.
 * @param message - The message to relay
 */
function relayToPopup(message: RelayMessage): void {
  chrome.runtime.sendMessage(message).catch(() => {
    // Popup may be closed — this is expected
  });
}

chrome.runtime.onMessage.addListener(
  (msg: PopupToBackgroundMessage | RelayMessage | { type: 'GET_STATUS' }, sender, sendResponse) => {
    // ─── Filter: only handle messages from popup (not offscreen relay) ─
    // Offscreen messages come from an offscreen context; popup messages
    // come from the popup context. Both hit this listener because
    // chrome.runtime.onMessage is broadcast to all contexts.
    const isFromOffscreen = sender.documentId !== undefined && sender.url?.includes('offscreen');

    // ─── Popup -> Background ────────────────────────────────────────
    if (msg.type === 'GET_STATUS') {
      sendResponse({ capturing, stats: lastStats });
      return true;
    }

    if (msg.type === 'START_CAPTURE' && !isFromOffscreen) {
      if (capturing) {
        sendResponse({ success: false, error: 'Already capturing' });
        return true;
      }

      // Set immediately to prevent double-start race
      capturing = true;

      handleStartCapture((msg as PopupToBackgroundMessage & { type: 'START_CAPTURE' }).config)
        .then(() => sendResponse({ success: true }))
        .catch((err) => {
          capturing = false;
          sendResponse({
            success: false,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      return true; // async response
    }

    if (msg.type === 'STOP_CAPTURE' && !isFromOffscreen) {
      handleStopCapture();
      sendResponse({ success: true });
      return true;
    }

    // ─── Offscreen -> Background (relay to popup) ───────────────────
    if (
      msg.type === 'CAPTURE_STARTED' ||
      msg.type === 'CAPTURE_STOPPED' ||
      msg.type === 'CAPTURE_STATS' ||
      msg.type === 'DOWNLOADS_COMPLETE' ||
      msg.type === 'CAPTURE_ERROR'
    ) {
      if (msg.type === 'CAPTURE_STARTED') capturing = true;
      if (msg.type === 'CAPTURE_STATS') {
        lastStats = (msg as RelayMessage & { type: 'CAPTURE_STATS' }).stats;
      }
      if (
        msg.type === 'CAPTURE_STOPPED' ||
        msg.type === 'DOWNLOADS_COMPLETE' ||
        msg.type === 'CAPTURE_ERROR'
      ) {
        capturing = false;
        lastStats = null;
      }
      relayToPopup(msg as RelayMessage);
      return false;
    }

    return false;
  },
);

/**
 * Initiates tab capture and forwards to offscreen document.
 * @param config - Capture configuration from popup
 */
async function handleStartCapture(config: CaptureConfig): Promise<void> {
  // Get the active tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');

  // Get media stream ID for tab capture
  const mediaStreamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tab.id,
  });

  // Ensure offscreen document exists
  await ensureOffscreen();

  // Forward to offscreen
  const response = await chrome.runtime.sendMessage({
    type: 'START_CAPTURE',
    mediaStreamId,
    config,
  });

  // Propagate offscreen errors
  if (response && !response.success) {
    throw new Error(response.error || 'Offscreen capture failed');
  }
}

/**
 * Stops the active capture session.
 */
function handleStopCapture(): void {
  chrome.runtime.sendMessage({ type: 'STOP_CAPTURE' }).catch(() => {
    // Offscreen may already be closed
  });
}
