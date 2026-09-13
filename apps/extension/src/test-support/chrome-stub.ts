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

/**
 * Creates an in-memory replacement for one `chrome.storage` area.
 * @param data - The backing record, exposed so tests can seed and inspect it
 * @returns An object implementing the `get`/`set`/`remove`/`clear` subset used by the code
 */
function createStorageArea(data: StorageRecord): chrome.storage.StorageArea {
  const area = {
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
      Object.assign(data, items);
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

/** Every message handed to `chrome.tabs.sendMessage`, oldest first. */
export const tabMessages: { tabId: number; message: unknown }[] = [];

/**
 * Empties every storage area and recorded message list.
 * Call from `beforeEach` in tests that read the stub's state.
 */
export function resetChromeStub(): void {
  for (const area of Object.values(chromeStorageData)) {
    for (const name of Object.keys(area)) delete area[name];
  }
  runtimeMessages.length = 0;
  tabMessages.length = 0;
}

const chromeStub = {
  storage: {
    local: createStorageArea(chromeStorageData.local),
    sync: createStorageArea(chromeStorageData.sync),
    session: createStorageArea(chromeStorageData.session),
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
  },
  power: {
    requestKeepAwake(): void {},
    releaseKeepAwake(): void {},
  },
  i18n: {
    getUILanguage: (): string => 'en-US',
  },
};

Object.defineProperty(globalThis, 'chrome', {
  value: chromeStub,
  configurable: true,
  writable: true,
});
