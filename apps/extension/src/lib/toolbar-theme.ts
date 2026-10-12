/**
 * Toolbar Theme
 *
 * Tells the background whether the browser is dark, so the toolbar badge
 * takes the colours that read on that toolbar. The service worker has no
 * `matchMedia`, so the popup reports it on open and the offscreen document
 * when it starts and whenever it changes. The browser's theme, not the
 * extension's own theme setting, decides the toolbar's colour.
 */

import type { SetToolbarThemeMessage } from './messages';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/**
 * Sends the browser's theme to the background.
 * @param dark - Whether the browser is dark
 */
function report(dark: boolean): void {
  const message: SetToolbarThemeMessage = { type: 'SET_TOOLBAR_THEME', payload: { dark } };
  chrome.runtime.sendMessage(message).catch(() => {
    // The background may be starting; the next report or the next open sends it again.
  });
}

/**
 * Reports the browser's theme once.
 */
export function reportToolbarTheme(): void {
  report(globalThis.matchMedia(DARK_QUERY).matches);
}

/**
 * Reports the browser's theme now and whenever it changes.
 */
export function watchToolbarTheme(): void {
  const query = globalThis.matchMedia(DARK_QUERY);
  report(query.matches);
  query.addEventListener('change', (event) => report(event.matches));
}
