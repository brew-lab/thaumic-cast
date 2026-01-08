/**
 * Sonos Control Routes
 *
 * Handles message routing for Sonos state and controls:
 * - GET_SONOS_STATE, SET_VOLUME, SET_MUTE, CONTROL_MEDIA
 */

import { registerRoute } from '../router';
import { getSonosState } from '../handlers/connection';
import { handleSetVolume, handleSetMute, handleControlMedia } from '../handlers/media-control';
import {
  SetVolumeMessageSchema,
  SetMuteMessageSchema,
  ControlMediaMessageSchema,
} from '../../lib/message-schemas';

/**
 * Registers all Sonos control routes.
 */
export function registerSonosRoutes(): void {
  registerRoute('GET_SONOS_STATE', () => {
    return getSonosState();
  });

  registerRoute('SET_VOLUME', async (msg) => {
    const validated = SetVolumeMessageSchema.parse(msg);
    return handleSetVolume(validated);
  });

  registerRoute('SET_MUTE', async (msg) => {
    const validated = SetMuteMessageSchema.parse(msg);
    return handleSetMute(validated);
  });

  registerRoute('CONTROL_MEDIA', async (msg) => {
    const validated = ControlMediaMessageSchema.parse(msg);
    await handleControlMedia(validated);
    return { success: true };
  });
}
