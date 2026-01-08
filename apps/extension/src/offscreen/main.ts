/**
 * Offscreen Document Entry Point
 *
 * This is the main entry point for the offscreen document.
 * All logic is delegated to extracted modules:
 * - control-connection.ts: WebSocket lifecycle and commands
 * - stream-session.ts: Audio capture and streaming
 * - handlers.ts: Message routing and dispatch
 */

import { createLogger } from '@thaumic-cast/shared';
import { setupMessageHandlers } from './handlers';
import { disconnectControlWebSocket } from './control-connection';

const log = createLogger('Offscreen');

// Set up message handlers for all offscreen operations
setupMessageHandlers();

// Signal to background that offscreen is ready
log.info('Offscreen document ready');
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {
  // Background may be suspended during startup
});

// Gracefully close WebSocket on document unload
globalThis.addEventListener('beforeunload', () => {
  disconnectControlWebSocket();
});
