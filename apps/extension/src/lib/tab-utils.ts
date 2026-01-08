/**
 * Tab Utilities
 *
 * Common utilities for working with Chrome tabs.
 * Eliminates repeated chrome.tabs.query patterns across handlers.
 */

/**
 * Gets the currently active tab in the current window.
 * @returns The active tab, or null if none found
 */
export async function getActiveTab(): Promise<chrome.tabs.Tab | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab ?? null;
}

/**
 * Gets the ID of the currently active tab in the current window.
 * @returns The active tab ID, or null if none found
 */
export async function getActiveTabId(): Promise<number | null> {
  const tab = await getActiveTab();
  return tab?.id ?? null;
}
