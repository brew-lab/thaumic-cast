/**
 * Minimal `chrome.*` stub for bun tests.
 *
 * Loaded once per test run through `bunfig.toml` (`[test] preload`), so every
 * extension module can be imported without a browser. Only the surface the
 * modules under test touch at import time or during pure logic is provided:
 * in-memory storage areas, fire-and-forget messaging that resolves, and no-op
 * power management. Anything else stays undefined so a test that wanders into
 * a real Chrome API fails loudly instead of silently succeeding.
 *
 * Tests that need to inspect or reset the stub import the helpers below.
 */

type StorageRecord = Record<string, unknown>;

type StorageChanges = Record<string, chrome.storage.StorageChange>;

/** Listeners on `chrome.storage.onChanged`, which hears every area. */
const storageListeners = new Set<(changes: StorageChanges, areaName: string) => void>();

/**
 * Creates an in-memory replacement for one `chrome.storage` area.
 * @param data - The backing record, exposed so tests can seed and inspect it
 * @param areaName - The area's name, as `chrome.storage.onChanged` reports it
 * @returns An object implementing the `get`/`set`/`remove`/`clear`/`onChanged` subset used by the code
 */
function createStorageArea(data: StorageRecord, areaName: string): chrome.storage.StorageArea {
  type Listener = (changes: Record<string, chrome.storage.StorageChange>) => void;
  const listeners = new Set<Listener>();
  const area = {
    // Fired synchronously inside `set`, before its promise settles, as Chrome may.
    onChanged: {
      addListener: (listener: Listener): void => void listeners.add(listener),
      removeListener: (listener: Listener): void => void listeners.delete(listener),
    },
    async get(keys?: string | string[] | StorageRecord | null): Promise<StorageRecord> {
      if (keys === undefined || keys === null) return { ...data };
      const names =
        typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const result: StorageRecord = {};
      for (const name of names) {
        if (name in data) result[name] = data[name];
      }
      return result;
    },
    async set(items: StorageRecord): Promise<void> {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [name, newValue] of Object.entries(items)) {
        changes[name] = { oldValue: data[name], newValue };
      }
      Object.assign(data, items);
      for (const listener of listeners) listener(changes);
      for (const listener of storageListeners) listener(changes, areaName);
    },
    async remove(keys: string | string[]): Promise<void> {
      for (const name of typeof keys === 'string' ? [keys] : keys) delete data[name];
    },
    async clear(): Promise<void> {
      for (const name of Object.keys(data)) delete data[name];
    },
  };
  return area as unknown as chrome.storage.StorageArea;
}

/** Backing records for each storage area; seed or inspect them directly. */
export const chromeStorageData = {
  local: {} as StorageRecord,
  sync: {} as StorageRecord,
  session: {} as StorageRecord,
};

/** Every message handed to `chrome.runtime.sendMessage`, oldest first. */
export const runtimeMessages: unknown[] = [];

/** Every `chrome.action` write, oldest first, as `[method, details]`. */
export const actionCalls: [string, unknown][] = [];

/** Every message handed to `chrome.tabs.sendMessage`, oldest first. */
export const tabMessages: { tabId: number; message: unknown }[] = [];

/** Content scripts registered through `chrome.scripting`, by ID. */
export const registeredScripts = new Map<string, chrome.scripting.RegisteredContentScript>();

/** Every `chrome.scripting` call that changed the registrations, oldest first. */
export const scriptingCalls: { op: 'register' | 'update' | 'unregister'; ids: string[] }[] = [];

/** Host origins `chrome.permissions.contains` reports as granted. */
export const grantedOrigins = new Set<string>();

/**
 * Each tab's address as `chrome.tabs.get` reports it; a tab left out has
 * none, as Chrome reports a page outside the granted hosts.
 */
export const tabUrls = new Map<number, string>();

/**
 * Empties every storage area, recorded message list, script registration,
 * granted origin and tab address.
 * Call from `beforeEach` in tests that read the stub's state.
 */
export function resetChromeStub(): void {
  for (const area of Object.values(chromeStorageData)) {
    for (const name of Object.keys(area)) delete area[name];
  }
  runtimeMessages.length = 0;
  tabMessages.length = 0;
  registeredScripts.clear();
  scriptingCalls.length = 0;
  grantedOrigins.clear();
  tabUrls.clear();
  actionCalls.length = 0;
}

const chromeStub = {
  storage: {
    local: createStorageArea(chromeStorageData.local, 'local'),
    sync: createStorageArea(chromeStorageData.sync, 'sync'),
    session: createStorageArea(chromeStorageData.session, 'session'),
    onChanged: {
      addListener: (listener: (changes: StorageChanges, areaName: string) => void): void =>
        void storageListeners.add(listener),
      removeListener: (listener: (changes: StorageChanges, areaName: string) => void): void =>
        void storageListeners.delete(listener),
    },
  },
  runtime: {
    async sendMessage(message: unknown): Promise<void> {
      runtimeMessages.push(message);
    },
  },
  tabs: {
    async sendMessage(tabId: number, message: unknown): Promise<void> {
      tabMessages.push({ tabId, message });
    },
    async update(): Promise<void> {},
    async get(tabId: number): Promise<{ id: number; url?: string }> {
      return { id: tabId, url: tabUrls.get(tabId) };
    },
  },
  scripting: {
    async getRegisteredContentScripts(filter?: {
      ids?: string[];
    }): Promise<chrome.scripting.RegisteredContentScript[]> {
      const all = [...registeredScripts.values()];
      return filter?.ids ? all.filter((s) => filter.ids?.includes(s.id)) : all;
    },
    async registerContentScripts(
      scripts: chrome.scripting.RegisteredContentScript[],
    ): Promise<void> {
      for (const s of scripts) {
        if (registeredScripts.has(s.id)) throw new Error(`Duplicate script ID '${s.id}'`);
      }
      for (const s of scripts) registeredScripts.set(s.id, { ...s });
      scriptingCalls.push({ op: 'register', ids: scripts.map((s) => s.id) });
    },
    async updateContentScripts(scripts: chrome.scripting.RegisteredContentScript[]): Promise<void> {
      for (const s of scripts) {
        const old = registeredScripts.get(s.id);
        if (!old) throw new Error(`No script with ID '${s.id}'`);
        registeredScripts.set(s.id, { ...old, ...s });
      }
      scriptingCalls.push({ op: 'update', ids: scripts.map((s) => s.id) });
    },
    async unregisterContentScripts(filter?: { ids?: string[] }): Promise<void> {
      const ids = filter?.ids ?? [...registeredScripts.keys()];
      for (const id of ids) registeredScripts.delete(id);
      scriptingCalls.push({ op: 'unregister', ids });
    },
  },
  permissions: {
    async contains(p: { origins?: string[] }): Promise<boolean> {
      return (p.origins ?? []).every((o) => grantedOrigins.has(o));
    },
  },
  power: {
    requestKeepAwake(): void {},
    releaseKeepAwake(): void {},
  },
  i18n: {
    getUILanguage: (): string => 'en-US',
    getMessage: (name: string): string => (name === 'extensionName' ? 'Thaumic Cast' : ''),
  },
  action: {
    async setBadgeText(details: unknown): Promise<void> {
      actionCalls.push(['setBadgeText', details]);
    },
    async setBadgeBackgroundColor(details: unknown): Promise<void> {
      actionCalls.push(['setBadgeBackgroundColor', details]);
    },
    async setBadgeTextColor(details: unknown): Promise<void> {
      actionCalls.push(['setBadgeTextColor', details]);
    },
    async setTitle(details: unknown): Promise<void> {
      actionCalls.push(['setTitle', details]);
    },
    async setIcon(details: unknown): Promise<void> {
      actionCalls.push(['setIcon', details]);
    },
  },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeStub,
  configurable: true,
  writable: true,
});
