/**
 * Toolbar Icon
 *
 * The extension's toolbar button (DESIGN.md F-mark): mark 1b in the popup
 * mark's ink for the browser's theme, lit (the octagon filled) while any cast
 * from this browser is running, as the popup header's mark is. One icon for
 * every tab, so a closed tab never leaves an icon behind.
 *
 * Chrome has no toolbar theme API. The theme is the browser's colour scheme,
 * which the popup and the offscreen document report (`toolbar-theme.ts`), the
 * same one the toolbar badge uses. The light ink is also the manifest's static
 * icon and the one drawn until a theme is reported: it clears 3:1 on Chrome's
 * light and dark toolbars, so it never vanishes on a dark Web Store theme
 * while Chrome is in Light mode (DESIGN.md §11 call 97).
 */

import { createLogger } from '@thaumic-cast/shared';
import { CHROME } from '@thaumic-cast/ui/tokens';

const log = createLogger('ToolbarIcon');

/** The icon's files by size, as `chrome.action.setIcon` takes them. */
export type ToolbarIconPaths = Record<'16' | '24' | '32', string>;

/**
 * Whether the icon is lit: any cast from this browser is running, paused or
 * not, as the popup header's mark.
 * @param casts - This browser's running casts
 * @returns True to light it
 */
export function isToolbarIconLit(casts: readonly unknown[]): boolean {
  return casts.length > 0;
}

/**
 * The icon's files for a state and theme.
 * @param lit - A cast is running
 * @param dark - The toolbar is dark; light when not known
 * @returns The 16, 24 and 32 px files
 */
export function toolbarIconFor(lit: boolean, dark: boolean): ToolbarIconPaths {
  return CHROME.toolbarIcon[lit ? 'lit' : 'idle'][dark ? 'dark' : 'light'];
}

/** What was last written, so nothing is written twice. */
let written: string | null = null;

/**
 * Writes the icon to the toolbar, only when it differs from what is there.
 * @param paths - The icon's files
 * @returns Resolves when written
 */
export async function writeToolbarIcon(paths: ToolbarIconPaths): Promise<void> {
  const next = paths['16'];
  if (next === written) return;
  written = next;
  try {
    await chrome.action.setIcon({ path: paths });
  } catch (err) {
    written = null;
    log.warn('Failed to write the toolbar icon:', err);
  }
}

/**
 * Forgets what was written. For tests.
 */
export function resetToolbarIconForTests(): void {
  written = null;
}
