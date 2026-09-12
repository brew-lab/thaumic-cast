/**
 * Connecting the extension to a companion server.
 * Shared between onboarding and settings.
 */

import { hasHostPermission, releaseHostPermission, requestHostPermission } from './hostPermission';
import type { EnsureConnectionMessage } from './message-schemas';
import { loadExtensionSettings, saveExtensionSettings } from './settings';

/**
 * Error types for connection failures. Each maps to the i18n key `error_<type>`.
 */
export type ServerTestErrorType =
  | 'network_failed'
  | 'server_error'
  | 'wrong_server'
  | 'permission_denied';

/**
 * Result of a server connection test.
 */
export interface ServerTestResult {
  success: boolean;
  latency?: number;
  error?: ServerTestErrorType;
}

/** Keeps the in-progress state visible long enough not to flash. */
const MIN_FEEDBACK_MS = 400;

/**
 * Maps a server test result to its corresponding i18n error key.
 *
 * @param result - The server test result
 * @returns The i18n key for the error message, or null if successful
 */
export function getServerTestErrorKey(result: ServerTestResult): string | null {
  if (result.success) return null;
  return result.error ? `error_${result.error}` : 'server_test_failed';
}

/**
 * Tests connection to a Thaumic Cast companion server.
 * Validates that the server responds correctly and is the expected service.
 *
 * @param url - The server URL to test (e.g., "http://localhost:49400")
 * @param timeoutMs - Request timeout in milliseconds (default: 3000)
 * @returns Test result with success status, latency, or error type
 */
export async function testServerConnection(
  url: string,
  timeoutMs = 3000,
): Promise<ServerTestResult> {
  const start = performance.now();

  try {
    const res = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return { success: false, error: 'server_error' };
    }

    const data = await res.json();
    if (data.service !== 'thaumic-cast') {
      return { success: false, error: 'wrong_server' };
    }

    return {
      success: true,
      latency: Math.round(performance.now() - start),
    };
  } catch {
    // All fetch errors (network, timeout, etc.) are treated as unreachable
    return { success: false, error: 'network_failed' };
  }
}

/**
 * Connects the extension to a companion server: obtains the host permission
 * if needed, checks the server answers, then saves it as the configured
 * server. Nothing is saved for a server that could not be reached.
 *
 * Must be called from a user gesture (a button click) so the permission
 * prompt can appear. The background reconnects on its own when the settings
 * or the permission change; only when neither did is it nudged directly.
 *
 * @param url - The server URL to connect to
 * @returns The connection test result
 */
export async function connectToServer(url: string): Promise<ServerTestResult> {
  const hadPermission = await hasHostPermission(url);
  if (!hadPermission && !(await requestHostPermission(url))) {
    return { success: false, error: 'permission_denied' };
  }

  const [result] = await Promise.all([
    testServerConnection(url),
    new Promise((resolve) => setTimeout(resolve, MIN_FEEDBACK_MS)),
  ]);
  if (!result.success) return result;

  const previous = await loadExtensionSettings();
  const changed = previous.serverUrl !== url || previous.useAutoDiscover;
  if (changed) {
    await saveExtensionSettings({ serverUrl: url, useAutoDiscover: false });
    if (previous.serverUrl) await releaseHostPermission(previous.serverUrl, url);
  } else if (hadPermission) {
    const message: EnsureConnectionMessage = { type: 'ENSURE_CONNECTION' };
    await chrome.runtime.sendMessage(message);
  }

  return result;
}
