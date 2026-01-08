/**
 * Offscreen Document Manager
 *
 * Manages the lifecycle of the offscreen document required for
 * DOM APIs (AudioContext, AudioEncoder) not available in service workers.
 *
 * Responsibilities:
 * - Create/verify offscreen document existence
 * - Wait for document ready signal
 * - Recover WebSocket state from existing offscreen
 * - Send messages to offscreen with error handling
 *
 * Non-responsibilities:
 * - WebSocket connection logic (handled by handlers/connection.ts)
 * - Message routing (handled by main.ts)
 */

import { createLogger } from '@thaumic-cast/shared';
import type { WsStatusResponse } from '../lib/messages';
import { setConnected, getConnectionState } from './connection-state';
import { setSonosState } from './sonos-state';
import { notifyPopup } from './notification-service';

const log = createLogger('Background');

/** Promise to track ongoing offscreen creation to avoid duplicates. */
let offscreenCreationPromise: Promise<void> | null = null;

/** Resolver for offscreen ready signal. */
let offscreenReadyResolver: (() => void) | null = null;

/** Promise that resolves when offscreen document signals it's ready. */
let offscreenReadyPromise: Promise<void> | null = null;

/**
 * Sends a message to the offscreen document with error handling.
 * @param message - The message to send
 * @returns The response from the offscreen document
 */
export async function sendToOffscreen<T = unknown>(message: object): Promise<T | undefined> {
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

/**
 * Ensures the offscreen document is created and ready.
 *
 * Manifest V3 requires an offscreen document to access DOM APIs like AudioContext.
 * This function waits for the OFFSCREEN_READY message to ensure the document's
 * message listener is set up before returning.
 *
 * @returns A promise that resolves when the offscreen document is ready.
 */
export async function ensureOffscreen(): Promise<void> {
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
 * Handles the OFFSCREEN_READY message from the offscreen document.
 * Resolves the ready promise if we're waiting for it.
 */
export function handleOffscreenReady(): void {
  log.info('Offscreen document ready');
  if (offscreenReadyResolver) {
    offscreenReadyResolver();
  }
}

/**
 * Recovers WebSocket state from offscreen on service worker startup.
 */
export async function recoverOffscreenState(): Promise<void> {
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

          // Notify popup of recovered state (it may already be open)
          if (status.connected) {
            notifyPopup({ type: 'WS_STATE_CHANGED', state: status.state });
          }
        }

        // If not connected but has URL, trigger reconnection
        if (!status.connected && status.url) {
          log.info('Triggering WebSocket reconnection...');
          sendToOffscreen({ type: 'WS_RECONNECT' }).catch(() => {});
        }
      }
    } else {
      // No offscreen document exists - we're definitely not connected
      // Clear stale connected state from session storage
      setConnected(false);
      log.info('No offscreen document found, cleared stale connection state');
    }
  } catch (err) {
    log.warn('Failed to recover offscreen state:', err);
    // On error, assume not connected to prevent stale state
    setConnected(false);
  }
}

/**
 * Checks if WebSocket reconnection is needed and triggers it.
 * Used for background reconnection on service worker wake.
 * @param connectWebSocket - Function to establish WebSocket connection
 */
export async function checkAndReconnect(
  connectWebSocket: (url: string) => Promise<void>,
): Promise<void> {
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
}
