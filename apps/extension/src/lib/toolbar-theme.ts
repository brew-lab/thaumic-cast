/**
 * Toolbar Theme
 *
 * Tells the background whether the browser is dark, so the toolbar badge and
 * icon take the colours that read on that toolbar. The service worker has no
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

/** How often a document that is never drawn reads the theme again, in ms. */
export const THEME_POLL_MS = 2000;

/**
 * Reports the browser's theme now and whenever it changes. A media query's
 * `change` event is fired while a page is drawn, and the offscreen document
 * never is: its `matches` follows the theme but the event never comes. So
 * the query is also read again every {@link THEME_POLL_MS}, and a change
 * either way is reported once.
 * @returns Stops watching (for tests)
 */
export function watchToolbarTheme(): () => void {
  const query = globalThis.matchMedia(DARK_QUERY);
  let last = query.matches;
  report(last);
  const check = (): void => {
    if (query.matches === last) return;
    last = query.matches;
    report(last);
  };
  query.addEventListener('change', check);
  const timer = setInterval(check, THEME_POLL_MS);
  return () => {
    query.removeEventListener('change', check);
    clearInterval(timer);
  };
}
