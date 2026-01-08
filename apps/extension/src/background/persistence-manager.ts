/**
 * Persistence Manager
 *
 * Centralized orchestration of all session storage persistence.
 * Provides unified restore sequence, batched writes, and a single point
 * for future migrations.
 *
 * Benefits:
 * - Single point for all storage operations
 * - Coordinated restore sequence on startup
 * - Batched persistAll() for efficiency
 * - Auditable: all storage registrations visible in one place
 */

import { createLogger } from '@thaumic-cast/shared';
import { DebouncedStorage, type DebouncedStorageOptions } from '../lib/debounced-storage';

const log = createLogger('PersistenceManager');

/** Registered storage entry with metadata */
interface StorageEntry {
  key: string;
  storage: DebouncedStorage<unknown>;
  onRestore?: (data: unknown) => void;
}

/**
 * Manages all session storage persistence for the extension.
 * Singleton pattern ensures consistent state across modules.
 */
class PersistenceManager {
  private entries = new Map<string, StorageEntry>();
  private restoreOrder: string[] = [];

  /**
   * Registers a storage configuration with the manager.
   * @param options - DebouncedStorage configuration
   * @param onRestore - Callback to handle restored data
   * @returns The created DebouncedStorage instance
   */
  register<T>(
    options: DebouncedStorageOptions<T>,
    onRestore?: (data: T | undefined) => void,
  ): DebouncedStorage<T> {
    if (this.entries.has(options.storageKey)) {
      log.warn(`Storage key "${options.storageKey}" already registered, returning existing`);
      return this.entries.get(options.storageKey)!.storage as DebouncedStorage<T>;
    }

    const storage = new DebouncedStorage(options);

    this.entries.set(options.storageKey, {
      key: options.storageKey,
      storage: storage as DebouncedStorage<unknown>,
      onRestore: onRestore as ((data: unknown) => void) | undefined,
    });

    // Track registration order for restore sequence
    this.restoreOrder.push(options.storageKey);

    log.debug(`Registered storage: ${options.storageKey}`);
    return storage;
  }

  /**
   * Restores all registered storages in registration order.
   * Calls onRestore callback for each with the restored data.
   */
  async restoreAll(): Promise<void> {
    log.info(`Restoring ${this.entries.size} storage entries...`);

    for (const key of this.restoreOrder) {
      const entry = this.entries.get(key);
      if (!entry) continue;

      try {
        const data = await entry.storage.restore();
        if (entry.onRestore) {
          entry.onRestore(data);
        }
        log.debug(`Restored: ${key}`);
      } catch (err) {
        log.error(`Failed to restore ${key}:`, err);
      }
    }

    log.info('All storage restored');
  }

  /**
   * Persists all registered storages immediately.
   * Useful for ensuring all state is saved before shutdown.
   */
  async persistAll(): Promise<void> {
    log.debug(`Persisting ${this.entries.size} storage entries...`);

    const promises = Array.from(this.entries.values()).map(async (entry) => {
      try {
        await entry.storage.persist();
      } catch (err) {
        log.error(`Failed to persist ${entry.key}:`, err);
      }
    });

    await Promise.all(promises);
    log.debug('All storage persisted');
  }

  /**
   * Gets a registered storage by key.
   * @param key - The storage key
   * @returns The DebouncedStorage instance or undefined
   */
  get<T>(key: string): DebouncedStorage<T> | undefined {
    return this.entries.get(key)?.storage as DebouncedStorage<T> | undefined;
  }

  /**
   * Returns all registered storage keys.
   * Useful for debugging.
   */
  get registeredKeys(): string[] {
    return Array.from(this.entries.keys());
  }

  /**
   * Returns the count of registered storages.
   */
  get count(): number {
    return this.entries.size;
  }
}

/** Singleton instance of the persistence manager */
export const persistenceManager = new PersistenceManager();
