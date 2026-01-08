/**
 * Metadata Routes
 *
 * Handles message routing for tab metadata:
 * - TAB_METADATA_UPDATE, TAB_OG_IMAGE, GET_CURRENT_TAB_STATE
 */

import { registerRoute, registerValidatedRoute } from '../router';
import {
  handleTabMetadataUpdate,
  handleTabOgImage,
  handleGetCurrentTabState,
} from '../handlers/metadata';
import { TabMetadataUpdateMessageSchema, TabOgImageMessageSchema } from '../../lib/message-schemas';

/**
 * Registers all metadata routes.
 */
export function registerMetadataRoutes(): void {
  registerValidatedRoute(
    'TAB_METADATA_UPDATE',
    TabMetadataUpdateMessageSchema,
    async (msg, sender) => {
      await handleTabMetadataUpdate(msg, sender);
      return { success: true };
    },
  );

  registerValidatedRoute('TAB_OG_IMAGE', TabOgImageMessageSchema, (msg, sender) => {
    handleTabOgImage(msg.payload, sender);
    return { success: true };
  });

  registerRoute('GET_CURRENT_TAB_STATE', async () => {
    return handleGetCurrentTabState();
  });
}
