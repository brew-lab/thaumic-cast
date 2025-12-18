import type { WsAction, SonosStateSnapshot } from '@thaumic-cast/shared';

// ============ WebSocket Command/Response Correlation ============

interface PendingRequest {
  resolve: (data: Record<string, unknown> | undefined) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();
let currentSonosState: SonosStateSnapshot | null = null;
let wsConnected = false;

/**
 * Send a command to the server via the offscreen WebSocket.
 * Returns a promise that resolves with the response data.
 */
export async function sendWsCommand(
  action: WsAction,
  payload?: Record<string, unknown>
): Promise<Record<string, unknown> | undefined> {
  if (!wsConnected) {
    throw new Error('WebSocket not connected');
  }

  const id = crypto.randomUUID();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Command timeout'));
    }, 10000);

    pendingRequests.set(id, { resolve, reject, timeout });

    chrome.runtime.sendMessage({
      type: 'WS_COMMAND',
      id,
      action,
      payload,
    });
  });
}

/**
 * Handle a WS_RESPONSE message from offscreen.
 * Resolves or rejects the corresponding pending request.
 */
export function handleWsResponse(
  id: string,
  success: boolean,
  data?: Record<string, unknown>,
  error?: string
): void {
  const pending = pendingRequests.get(id);
  if (pending) {
    clearTimeout(pending.timeout);
    pendingRequests.delete(id);
    if (success) {
      pending.resolve(data);
    } else {
      pending.reject(new Error(error || 'Command failed'));
    }
  }
}

/**
 * Mark WebSocket as connected and store initial state.
 */
export function setWsConnected(state: SonosStateSnapshot): void {
  wsConnected = true;
  currentSonosState = state;
}

/**
 * Restore WebSocket state after service worker restart.
 * Called when we detect offscreen has an active connection or cached state.
 * @param state - Cached Sonos state from offscreen
 * @param connected - Whether WebSocket is currently connected (default true for backwards compat)
 */
export function restoreWsState(state: SonosStateSnapshot | null, connected: boolean = true): void {
  wsConnected = connected;
  currentSonosState = state;
  console.log('[WsClient] Restored WebSocket state from offscreen cache', {
    connected,
    hasState: !!state,
  });
}

/**
 * Mark WebSocket as disconnected.
 */
export function setWsDisconnected(): void {
  wsConnected = false;
  currentSonosState = null;
}

/**
 * Update cached Sonos state.
 */
export function updateSonosState(state: SonosStateSnapshot): void {
  currentSonosState = state;
}

/**
 * Get the current Sonos state from the WebSocket connection.
 */
export function getSonosState(): SonosStateSnapshot | null {
  return currentSonosState;
}

/**
 * Check if WebSocket is connected.
 */
export function isWsConnected(): boolean {
  return wsConnected;
}
