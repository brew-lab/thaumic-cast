/**
 * Toolbar Badge Routes
 *
 * - SET_TOOLBAR_THEME: the popup or the offscreen document reports the
 *   browser's theme, for the badge's colours
 */

import { registerValidatedRoute } from '../router';
import { setToolbarDark } from '../toolbar-badge';
import { SetToolbarThemeMessageSchema } from '../../lib/message-schemas';

/**
 * Registers the toolbar badge's routes.
 */
export function registerBadgeRoutes(): void {
  registerValidatedRoute('SET_TOOLBAR_THEME', SetToolbarThemeMessageSchema, async (msg) => {
    await setToolbarDark(msg.payload.dark);
    return { success: true };
  });
}
