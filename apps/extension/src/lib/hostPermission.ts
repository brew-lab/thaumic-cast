/**
 * Host permission helpers for a user-configured companion server.
 *
 * The manifest only grants `http://localhost/*`. Any other server origin is an
 * optional host permission the user grants through Chrome's own prompt, scoped
 * to that one origin. Without it every `fetch` to the server is blocked by
 * CORS, so discovery and the connection test fail. The WebSocket used for
 * streaming is not subject to host permissions.
 */

/** Outcome of ensuring the permission for a server URL. */
export type HostPermissionResult = 'granted' | 'denied' | 'invalid';

/**
 * Builds the match pattern covering a server URL's origin.
 * @param url - The server URL (e.g. `http://192.168.1.50:49400`)
 * @returns The pattern (e.g. `http://192.168.1.50/*`), or null if the URL is not http(s)
 */
export function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    // Match patterns cover all ports of a host, so the port is dropped.
    return `${parsed.protocol}//${parsed.hostname}/*`;
  } catch {
    return null;
  }
}

/**
 * Checks whether the extension may already reach the server URL.
 * @param url - The server URL
 * @returns True if the origin is covered by a granted host permission
 */
export async function hasHostPermission(url: string): Promise<boolean> {
  const pattern = originPattern(url);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * Ensures the extension may reach the server URL, prompting the user if needed.
 * Must be called from a user gesture (e.g. a button click) for the prompt to show.
 * @param url - The server URL
 * @returns Whether access is granted, was refused, or the URL is unusable
 */
export async function ensureHostPermission(url: string): Promise<HostPermissionResult> {
  const pattern = originPattern(url);
  if (!pattern) return 'invalid';
  try {
    if (await chrome.permissions.contains({ origins: [pattern] })) return 'granted';
    return (await chrome.permissions.request({ origins: [pattern] })) ? 'granted' : 'denied';
  } catch {
    return 'denied';
  }
}
