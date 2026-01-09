import { listen } from '@tauri-apps/api/event';

/**
 * Payload from the discovery-complete Tauri event.
 * Emitted when SSDP/mDNS discovery finishes.
 */
export interface DiscoveryCompletePayload {
  groupCount: number;
}

/**
 * Payload from the network-health-changed Tauri event.
 * Emitted when network reachability status changes.
 */
export interface NetworkHealthPayload {
  health: 'ok' | 'degraded';
  reason: string | null;
}

/**
 * Payload from the transport-state-changed Tauri event.
 * Emitted when a speaker's playback state changes.
 */
export interface TransportStatePayload {
  speakerIp: string;
  state: string;
}

/**
 * Listens for a Tauri event once, with a timeout fallback.
 * The listener is registered before returning, ensuring no race conditions
 * when the caller triggers an action that emits the event.
 *
 * @param eventName - The Tauri event name to listen for
 * @param timeoutMs - Maximum time to wait before resolving anyway
 * @returns Promise that resolves when the event fires or timeout is reached
 */
export async function listenOnce<T>(
  eventName: string,
  timeoutMs: number,
): Promise<{ timedOut: boolean; payload?: T }> {
  type Result = { timedOut: boolean; payload?: T };

  let resolved = false;
  let resolvePromise: ((result: Result) => void) | null = null;
  let pendingResult: Result | null = null;

  const tryResolve = (result: Result) => {
    if (resolved) return;
    resolved = true;
    unlistenFn();
    if (timeoutId) clearTimeout(timeoutId);

    // If promise is ready, resolve immediately; otherwise queue the result
    if (resolvePromise) {
      resolvePromise(result);
    } else {
      pendingResult = result;
    }
  };

  // Await listener registration to avoid race conditions
  const unlistenFn = await listen<T>(eventName, (event) => {
    tryResolve({ timedOut: false, payload: event.payload });
  });

  const timeoutId = setTimeout(() => {
    tryResolve({ timedOut: true });
  }, timeoutMs);

  return new Promise((resolve) => {
    // If event already fired during registration, resolve immediately
    if (pendingResult) {
      resolve(pendingResult);
    } else {
      resolvePromise = resolve;
    }
  });
}
