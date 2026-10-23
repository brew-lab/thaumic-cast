/**
 * Notices a background service worker left over from an earlier build, and reloads the
 * extension so the worker matches the pages.
 *
 * Chrome keeps an unpacked extension's service worker (and its manifest) when the files on
 * disk are replaced, while the popup and the options page load the new files each time they
 * open. A build copied over an older one without pressing Reload in chrome://extensions then
 * runs the new popup against the old worker, which rejects the new messages: Cast fails with
 * the old worker's own validation error, and the old worker discards settings it did not know.
 * A store install is always updated whole, so this only ever acts on an unpacked build.
 *
 * The worker answers GET_WORKER_SCRIPT with the path of its own entry module (a hashed file
 * name in a build, which changes with any change to the worker's code); the popup reads the
 * worker loader on disk, which imports the entry module of the build on disk. A worker from
 * before this check answers the message with the router's default, which has no script.
 */
import { createLogger } from '@thaumic-cast/shared';

const log = createLogger('StaleWorker');

/** The worker's answer to GET_WORKER_SCRIPT. */
export interface WorkerScriptResponse {
  /** The path of the worker's entry module, as loaded: for example `/assets/main.ts-AbC123.js`. */
  script: string;
}

/**
 * Stores the loader the extension was last reloaded for, so a worker that still does not
 * match after the reload (which should not happen) cannot reload the extension again and
 * again: once per build on disk at most.
 */
export const STALE_WORKER_RELOAD_KEY = 'staleWorkerReloadFor';

/**
 * The worker's answer to GET_WORKER_SCRIPT.
 * @param moduleUrl - The worker's entry module's `import.meta.url`
 * @returns The answer, naming the module's path
 */
export function workerScriptResponse(moduleUrl: string): WorkerScriptResponse {
  return { script: new URL(moduleUrl).pathname };
}

/**
 * Tells whether the running worker is from another build than the files on disk.
 * @param answer - The worker's answer to GET_WORKER_SCRIPT; undefined when it did not answer
 * @param loader - The worker loader on disk, or undefined when it could not be read
 * @returns True when the worker is from an earlier build: it answers without a script (it
 *   predates this check), or names an entry module the loader on disk does not import
 */
export function isWorkerStale(answer: unknown, loader: string | undefined): boolean {
  if (typeof answer !== 'object' || answer === null) return false;
  const script = (answer as Partial<WorkerScriptResponse>).script;
  if (typeof script !== 'string') return true;
  if (loader === undefined) return false;
  return !loader.includes(script.replace(/^\//, ''));
}

/** What {@link reloadIfWorkerStale} reaches the browser through. */
export interface StaleWorkerDeps {
  /** Asks the worker for its script; undefined when it did not answer. */
  ask(): Promise<unknown>;
  /** Reads the worker loader on disk; undefined when it could not be read. */
  readLoader(): Promise<string | undefined>;
  /** Reads the loader the extension was last reloaded for. */
  readReloadedFor(): Promise<string | undefined>;
  /** Records the loader the extension is being reloaded for. */
  writeReloadedFor(loader: string): Promise<void>;
  /** Reloads the extension from disk. */
  reload(): void;
}

/**
 * The browser's side of {@link StaleWorkerDeps}.
 * @returns The deps that reach chrome.*
 */
function chromeDeps(): StaleWorkerDeps {
  return {
    ask: () => chrome.runtime.sendMessage({ type: 'GET_WORKER_SCRIPT' }).catch(() => undefined),
    readLoader: async () => {
      const background = chrome.runtime.getManifest().background;
      const file = background && 'service_worker' in background ? background.service_worker : '';
      if (!file) return undefined;
      try {
        const res = await fetch(chrome.runtime.getURL(file), { cache: 'no-store' });
        return res.ok ? await res.text() : undefined;
      } catch {
        return undefined;
      }
    },
    readReloadedFor: async () => {
      const stored = await chrome.storage.local.get(STALE_WORKER_RELOAD_KEY);
      const value = stored[STALE_WORKER_RELOAD_KEY];
      return typeof value === 'string' ? value : undefined;
    },
    writeReloadedFor: (loader) => chrome.storage.local.set({ [STALE_WORKER_RELOAD_KEY]: loader }),
    reload: () => chrome.runtime.reload(),
  };
}

/**
 * Reloads the extension when its worker is from an earlier build than the files on disk, so
 * the next popup talks to a worker of its own build. The reload closes the popup.
 * @param deps - How to reach the browser (tests pass their own)
 * @returns True when it reloaded the extension
 */
export async function reloadIfWorkerStale(deps: StaleWorkerDeps = chromeDeps()): Promise<boolean> {
  try {
    const [answer, loader] = await Promise.all([deps.ask(), deps.readLoader()]);
    if (!isWorkerStale(answer, loader)) return false;
    // Without the loader there is no build to name, so the guard keys on a fixed value.
    const build = loader ?? '';
    if ((await deps.readReloadedFor()) === build) {
      log.warn('The background is from another build, and a reload did not change it');
      return false;
    }
    log.warn('The background is from an earlier build than these files: reloading the extension');
    await deps.writeReloadedFor(build);
    deps.reload();
    return true;
  } catch (err) {
    log.warn('Could not check the background build:', err);
    return false;
  }
}
