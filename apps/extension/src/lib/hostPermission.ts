/**
 * Host permission helpers for a user-configured companion server.
 *
 * The manifest only grants `http://localhost/*`. Any other server host is an
 * optional host permission the user grants through the browser's own prompt,
 * scoped to that host. Without it every `fetch` to the server is blocked by
 * CORS, so discovery and the connection check fail. The WebSocket used for
 * streaming is not subject to host permissions.
 *
 * Match patterns cannot carry a port, so a grant covers every port on the host.
 */

/** Hosts the manifest already covers; never involve chrome.permissions for them. */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Builds the match pattern covering a server URL's host.
 * @param url - The server URL (e.g. `http://192.168.1.50:49400`)
 * @returns The pattern (e.g. `http://192.168.1.50/*`), or null if the URL is not plain http
 */
function originPattern(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' ? `http://${parsed.hostname}/*` : null;
  } catch {
    return null;
  }
}

/**
 * Whether a server URL points at this machine and needs no extra permission.
 * @param url - The server URL
 * @returns True for localhost-style hosts
 */
function isLocalHost(url: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Checks whether the extension may already reach the server URL.
 * @param url - The server URL
 * @returns True if the host is local or covered by a granted permission
 */
export async function hasHostPermission(url: string): Promise<boolean> {
  if (isLocalHost(url)) return true;
  const pattern = originPattern(url);
  if (!pattern) return false;
  try {
    return await chrome.permissions.contains({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * Asks the user to allow the server URL's host. Must run from a user gesture
 * (a button click) for the browser to show its prompt.
 * @param url - The server URL
 * @returns True if the permission is held afterwards
 */
export async function requestHostPermission(url: string): Promise<boolean> {
  if (isLocalHost(url)) return true;
  const pattern = originPattern(url);
  if (!pattern) return false;
  try {
    return await chrome.permissions.request({ origins: [pattern] });
  } catch {
    return false;
  }
}

/**
 * Gives back the permission for a server URL's host once it is no longer the
 * configured server, so grants don't accumulate.
 * @param url - The server URL that is no longer in use
 * @param keepUrl - A URL still in use; its host is never released
 */
export async function releaseHostPermission(url: string, keepUrl?: string | null): Promise<void> {
  if (isLocalHost(url)) return;
  const pattern = originPattern(url);
  if (!pattern || (keepUrl && originPattern(keepUrl) === pattern)) return;
  try {
    await chrome.permissions.remove({ origins: [pattern] });
  } catch {
    // Nothing to release, or the browser refused; either way it's not ours to hold.
  }
}

/**
 * Whether a permission change (from `chrome.permissions.onAdded`/`onRemoved`)
 * concerns the server URL's host.
 * @param origins - The origins in the change event
 * @param url - The configured server URL
 * @returns True if the change covers that host
 */
export function permissionChangeCovers(origins: string[] | undefined, url: string): boolean {
  const pattern = originPattern(url);
  return !!pattern && !!origins?.includes(pattern);
}
