/**
 * Media Bridge (ISOLATED world)
 *
 * Bridge between MAIN world (media-reader) and background script.
 * Runs in ISOLATED world with chrome.runtime access.
 *
 * Responsibilities:
 * - Listen for events from media-reader
 * - Forward metadata to background via chrome.runtime
 * - Handle metadata requests from background
 * - Handle control commands from background
 * - Extract og:image from page
 * - Stop quietly once the extension reloads, updates or is turned off
 *
 * Non-responsibilities:
 * - Parsing or validating data
 * - Caching
 * - Any business logic
 *
 * Built as a self-contained classic script (see vite.config.ts), not loaded through
 * dynamic import, so the page's own fetch rules never apply to it.
 */

import { startMediaBridge } from './bridge';

startMediaBridge(chrome.runtime, {
  win: window,
  doc: document,
});
