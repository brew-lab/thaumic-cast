/**
 * Server connection testing utility.
 * Shared between onboarding and settings.
 */

/**
 * Result of a server connection test.
 */
export interface ServerTestResult {
  success: boolean;
  latency?: number;
  error?: string;
}

/**
 * Error types for connection test failures.
 */
export type ServerTestErrorType = 'network_failed' | 'server_error' | 'wrong_server';

/**
 * Maps a server test result to its corresponding i18n error key.
 *
 * @param result - The server test result
 * @returns The i18n key for the error message, or null if successful
 */
export function getServerTestErrorKey(result: ServerTestResult): string | null {
  if (result.success) return null;
  switch (result.error) {
    case 'network_failed':
      return 'error_network_failed';
    case 'server_error':
      return 'error_server_error';
    case 'wrong_server':
      return 'error_wrong_server';
    default:
      return 'server_test_failed';
  }
}

/**
 * Tests connection to a Thaumic Cast desktop server.
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
