/**
 * Registers the video sync page scripts (the audio-lead hook and its relay)
 * with chrome.scripting, only while the video sync setting is on.
 *
 * The scripts are built as standalone files (see vite.config.ts) and run at
 * document_start in every frame, before any page script, so the hook can
 * patch the page's Media Source Extensions in time. Pages opened before the
 * setting was turned on do not have them until they are reloaded.
 *
 * They are registered only while the optional all-sites permission is held
 * (see lib/video-sync-access.ts); the options page asks for it when video
 * sync is turned on.
 */

import { createLogger } from '@thaumic-cast/shared';
import { VIDEO_SYNC_ORIGINS, hasVideoSyncHostAccess } from '../../lib/video-sync-access';

const log = createLogger('VideoSyncScripts');

/** Registration ID of the MAIN-world hook. */
export const HOOK_SCRIPT_ID = 'tc-vs-hook';

/** Registration ID of the ISOLATED-world relay. */
export const RELAY_SCRIPT_ID = 'tc-vs-relay';

/**
 * The two page scripts, with the exact options they are registered with.
 * @returns The registrations
 */
export function videoSyncScripts(): chrome.scripting.RegisteredContentScript[] {
  const common = {
    matches: VIDEO_SYNC_ORIGINS,
    runAt: 'document_start' as const,
    allFrames: true,
    matchOriginAsFallback: true,
    persistAcrossSessions: true,
  };
  return [
    { id: HOOK_SCRIPT_ID, js: ['video-sync-hook.js'], world: 'MAIN', ...common },
    { id: RELAY_SCRIPT_ID, js: ['video-sync-relay.js'], world: 'ISOLATED', ...common },
  ];
}

/**
 * Brings the registered page scripts in line with the setting: registers
 * (or refreshes) both while video sync is on and the host permission is
 * held, and unregisters them otherwise. Safe to call any number of times.
 * @param enabled - The video sync setting
 * @returns True when the scripts are registered afterwards
 */
export async function syncVideoSyncScripts(enabled: boolean): Promise<boolean> {
  const wanted = videoSyncScripts();
  const ids = wanted.map((s) => s.id);
  try {
    const present = new Set(
      (await chrome.scripting.getRegisteredContentScripts({ ids })).map((s) => s.id),
    );
    const on = enabled && (await hasVideoSyncHostAccess());
    if (!on) {
      const stale = ids.filter((id) => present.has(id));
      if (stale.length) await chrome.scripting.unregisterContentScripts({ ids: stale });
      return false;
    }
    const update = wanted.filter((s) => present.has(s.id));
    const add = wanted.filter((s) => !present.has(s.id));
    if (update.length) await chrome.scripting.updateContentScripts(update);
    if (add.length) await chrome.scripting.registerContentScripts(add);
    return true;
  } catch (err) {
    log.warn(`Could not update the video sync page scripts: ${String(err)}`);
    return false;
  }
}
