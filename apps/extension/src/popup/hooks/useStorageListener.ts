/**
 * Storage Listener Hook
 *
 * Subscribes to chrome.storage changes for a specific key.
 * Handles listener setup and cleanup automatically.
 */

import { useEffect, useRef } from 'preact/hooks';

/**
 * Hook that listens for chrome.storage.local changes on a specific key.
 * @param key - The storage key to listen for
 * @param onChanged - Callback when the value changes
 */
export function useStorageListener<T>(key: string, onChanged: (newValue: T) => void): void {
  const callbackRef = useRef(onChanged);

  // Keep callback ref updated
  useEffect(() => {
    callbackRef.current = onChanged;
  });

  useEffect(() => {
    const handler = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      const change = changes[key];
      if (change?.newValue !== undefined) {
        callbackRef.current(change.newValue as T);
      }
    };

    chrome.storage.local.onChanged.addListener(handler);
    return () => chrome.storage.local.onChanged.removeListener(handler);
  }, [key]);
}
