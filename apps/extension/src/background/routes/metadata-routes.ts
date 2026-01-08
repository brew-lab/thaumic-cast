/**
 * Metadata Routes
 *
 * Handles message routing for tab metadata:
 * - TAB_METADATA_UPDATE, TAB_OG_IMAGE, GET_CURRENT_TAB_STATE
 */

import type { TabMetadataUpdateMessage, TabOgImageMessage } from '../../lib/messages';
import { registerRoute } from '../router';
import {
  handleTabMetadataUpdate,
  handleTabOgImage,
  handleGetCurrentTabState,
} from '../handlers/metadata';

/**
 * Registers all metadata routes.
 */
export function registerMetadataRoutes(): void {
  registerRoute<TabMetadataUpdateMessage>('TAB_METADATA_UPDATE', async (msg, sender) => {
    await handleTabMetadataUpdate(msg, sender);
    return { success: true };
  });

  registerRoute<TabOgImageMessage>('TAB_OG_IMAGE', (msg, sender) => {
    handleTabOgImage(msg.payload, sender);
    return { success: true };
  });

  registerRoute('GET_CURRENT_TAB_STATE', async () => {
    return handleGetCurrentTabState();
  });
}
