/**
 * The host permission video sync needs.
 *
 * The audio-lead hook runs inside each site's own player, injected with
 * chrome.scripting. Dynamically registered content scripts only inject where
 * the extension holds an explicit host permission; the static content
 * scripts' match patterns are not enough (checked in Chrome 149). The
 * manifest lists all sites as an optional host permission, asked for when
 * video sync is turned on.
 */

/** The origins the video sync page scripts must be allowed on. */
export const VIDEO_SYNC_ORIGINS = ['http://*/*', 'https://*/*'];

/**
 * Whether the extension holds the host permission video sync needs.
 * @returns True when http and https pages are allowed
 */
export async function hasVideoSyncHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.contains({ origins: VIDEO_SYNC_ORIGINS });
  } catch {
    return false;
  }
}

/**
 * Asks the user for the host permission video sync needs. Must run from a
 * user gesture for the browser to show its prompt.
 * @returns True when the permission is held afterwards
 */
export async function requestVideoSyncHostAccess(): Promise<boolean> {
  try {
    return await chrome.permissions.request({ origins: VIDEO_SYNC_ORIGINS });
  } catch {
    return false;
  }
}
