/**
 * Debounced Storage Utility
 *
 * Provides a reusable pattern for debounced persistence to Chrome session storage.
 * Prevents excessive storage writes during rapid state changes.
 *
 * Used by:
 * - metadata-cache.ts
 * - sonos-state.ts
 * - connection-state.ts
 * - useDominantColor.ts
 */

import { createLogger } from '@thaumic-cast/shared';

/**
 * Options for creating a DebouncedStorage instance.
 */
export interface DebouncedStorageOptions<T> {
  /** Storage key for chrome.storage.session */
  storageKey: string;
  /** Debounce interval in milliseconds */
  debounceMs: number;
  /** Logger name for debug/error messages */
  loggerName: string;
  /** Function to serialize state for storage */
  serialize: () => T;
  /**
   * Optional function to restore state from storage.
   * Receives the stored value and should return the restored state.
   * If not provided, stored value is used directly.
   * Use this for migrations or default value handling.
   */
  restore?: (stored: unknown) => T | undefined;
}

/**
 * A utility class for debounced persistence to Chrome session storage.
 */
export class DebouncedStorage<T> {
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly log: ReturnType<typeof createLogger>;

  /**
   * Creates a new DebouncedStorage instance.
   * @param options - Configuration options for debounced storage
   */
  constructor(private readonly options: DebouncedStorageOptions<T>) {
    this.log = createLogger(options.loggerName);
  }

  /**
   * Schedules a debounced persist to session storage.
   * Clears any pending persist and schedules a new one.
   */
  schedule(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => this.persist(), this.options.debounceMs);
  }

  /**
   * Immediately persists state to session storage.
   * Normally called internally after debounce, but can be called directly if needed.
   */
  async persist(): Promise<void> {
    try {
      const data = this.options.serialize();
      await chrome.storage.session.set({ [this.options.storageKey]: data });
      this.log.debug('Persisted state');
    } catch (err) {
      this.log.error('Persist failed:', err);
    }
  }

  /**
   * Restores state from session storage.
   * If a restore function was provided, it will be called to transform the stored value.
   * @returns The restored value, or undefined if nothing was stored
   */
  async restore(): Promise<T | undefined> {
    try {
      const result = await chrome.storage.session.get(this.options.storageKey);
      const stored = result[this.options.storageKey];

      if (stored === undefined) {
        return undefined;
      }

      if (this.options.restore) {
        return this.options.restore(stored);
      }

      return stored as T;
    } catch (err) {
      this.log.error('Restore failed:', err);
      return undefined;
    }
  }

  /**
   * Cancels any pending persist operation.
   */
  cancel(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
  }
}
