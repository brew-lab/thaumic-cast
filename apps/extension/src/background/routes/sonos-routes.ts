/**
 * Sonos Control Routes
 *
 * Handles message routing for Sonos state and controls:
 * - GET_SONOS_STATE, SET_VOLUME, SET_MUTE, CONTROL_MEDIA
 */

import type { SetVolumeMessage, SetMuteMessage, ControlMediaMessage } from '../../lib/messages';
import { registerRoute } from '../router';
import { getSonosState } from '../handlers/connection';
import { handleSetVolume, handleSetMute, handleControlMedia } from '../handlers/media-control';

/**
 * Registers all Sonos control routes.
 */
export function registerSonosRoutes(): void {
  registerRoute('GET_SONOS_STATE', () => {
    return getSonosState();
  });

  registerRoute<SetVolumeMessage>('SET_VOLUME', async (msg) => {
    return handleSetVolume(msg);
  });

  registerRoute<SetMuteMessage>('SET_MUTE', async (msg) => {
    return handleSetMute(msg);
  });

  registerRoute<ControlMediaMessage>('CONTROL_MEDIA', async (msg) => {
    await handleControlMedia(msg);
    return { success: true };
  });
}
