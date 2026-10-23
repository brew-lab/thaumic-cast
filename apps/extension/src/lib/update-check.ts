/**
 * Check for updates (options page › About).
 *
 * The extension ships two ways. A store install (the Chrome Web Store, Edge Add-ons or any
 * other Chromium store) is updated by the browser, and the store writes an `update_url` into
 * the installed manifest; `chrome.runtime.requestUpdateCheck()` asks it now rather than at
 * the browser's next round. The release zip, loaded unpacked, has no `update_url` and never
 * updates itself, so the only way on is the releases page. The manifest is read rather than
 * `chrome.management.getSelf()`, which says the same through another namespace.
 */

/** How this copy of the extension gets a newer version. */
export type UpdateChannel = 'store' | 'manual';

/** What one update check found. */
export type UpdateCheckResult =
  | { kind: 'latest' }
  | { kind: 'ready'; version?: string }
  | { kind: 'throttled' };

/**
 * Says how this copy updates: from a store (an `update_url` in the installed manifest) or
 * by hand (an unpacked load of the release zip).
 * @param manifest - The installed manifest
 * @returns `store` when the browser can update it, `manual` otherwise
 */
export function updateChannel(
  manifest: chrome.runtime.Manifest = chrome.runtime.getManifest(),
): UpdateChannel {
  return manifest.update_url ? 'store' : 'manual';
}

/**
 * Asks the store for a newer version. One that is found is downloaded by the browser and
 * applies when the extension restarts (`chrome.runtime.reload()`) or the browser does.
 * @returns What the check found
 * @throws When the browser cannot run the check
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const { status, version } = await chrome.runtime.requestUpdateCheck();
  if (status === 'update_available') return { kind: 'ready', version };
  if (status === 'throttled') return { kind: 'throttled' };
  return { kind: 'latest' };
}

/** The locale key of the line under the row, and the version it names, if any. */
export interface UpdateNote {
  /** The locale key. */
  key:
    | 'about_update_latest'
    | 'about_update_ready'
    | 'about_update_ready_unnamed'
    | 'about_update_ready_casting'
    | 'about_update_throttled';
  /** The version found, for `{{version}}`. */
  version?: string;
}

/**
 * The line under the row after a check. A version that is ready applies on a restart of the
 * extension, which would end every cast this browser is running, so while any runs the
 * restart waits and the line says why.
 * @param result - What the check found
 * @param casting - Whether any cast is running
 * @returns The note's key and version
 */
export function updateNote(result: UpdateCheckResult, casting: boolean): UpdateNote {
  if (result.kind === 'latest') return { key: 'about_update_latest' };
  if (result.kind === 'throttled') return { key: 'about_update_throttled' };
  if (casting) return { key: 'about_update_ready_casting' };
  if (!result.version) return { key: 'about_update_ready_unnamed' };
  return { key: 'about_update_ready', version: result.version };
}
