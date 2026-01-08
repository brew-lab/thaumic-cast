/**
 * Metadata Routes
 *
 * Handles message routing for tab metadata:
 * - TAB_METADATA_UPDATE, TAB_OG_IMAGE, GET_CURRENT_TAB_STATE
 */

import { registerRoute } from '../router';
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
  registerRoute('TAB_METADATA_UPDATE', async (msg, sender) => {
    const validated = TabMetadataUpdateMessageSchema.parse(msg);
    await handleTabMetadataUpdate(validated, sender);
    return { success: true };
  });

  registerRoute('TAB_OG_IMAGE', (msg, sender) => {
    const validated = TabOgImageMessageSchema.parse(msg);
    handleTabOgImage(validated.payload, sender);
    return { success: true };
  });

  registerRoute('GET_CURRENT_TAB_STATE', async () => {
    return handleGetCurrentTabState();
  });
}
