/**
 * Sonos Control Routes
 *
 * Handles message routing for Sonos state and controls:
 * - GET_SONOS_STATE, SET_VOLUME, SET_MUTE, SET_ORIGINAL_GROUP_VOLUME, CONTROL_MEDIA
 */

import { registerRoute, registerValidatedRoute } from '../router';
import { getSonosState } from '../handlers/connection';
import {
  handleSetVolume,
  handleSetMute,
  handleSetOriginalGroupVolume,
  handleControlMedia,
} from '../handlers/media-control';
import {
  SetVolumeMessageSchema,
  SetMuteMessageSchema,
  SetOriginalGroupVolumeMessageSchema,
  ControlMediaMessageSchema,
} from '../../lib/message-schemas';

/**
 * Registers all Sonos control routes.
 */
export function registerSonosRoutes(): void {
  registerRoute('GET_SONOS_STATE', () => {
    return getSonosState();
  });

  registerValidatedRoute('SET_VOLUME', SetVolumeMessageSchema, handleSetVolume);

  registerValidatedRoute('SET_MUTE', SetMuteMessageSchema, handleSetMute);

  registerValidatedRoute(
    'SET_ORIGINAL_GROUP_VOLUME',
    SetOriginalGroupVolumeMessageSchema,
    handleSetOriginalGroupVolume,
  );

  registerValidatedRoute('CONTROL_MEDIA', ControlMediaMessageSchema, async (msg) => {
    await handleControlMedia(msg);
    return { success: true };
  });
}
