/**
 * Cast Session Routes
 *
 * Handles message routing for cast session lifecycle:
 * - START_CAST, STOP_CAST, REMOVE_SPEAKER, GET_CAST_STATUS, GET_ACTIVE_CASTS
 */

import type { ActiveCastsResponse } from '../../lib/messages';
import { registerRoute, registerValidatedRoute } from '../router';
import {
  handleStartCast,
  handleStopCast,
  handleGetStatus,
  handleRemoveSpeaker,
} from '../handlers/cast';
import { getActiveCasts } from '../session-manager';
import {
  StartCastMessageSchema,
  StopCastMessageSchema,
  RemoveSpeakerMessageSchema,
} from '../../lib/message-schemas';

/**
 * Registers all cast session routes.
 */
export function registerCastRoutes(): void {
  registerValidatedRoute('START_CAST', StartCastMessageSchema, handleStartCast);

  registerValidatedRoute('STOP_CAST', StopCastMessageSchema, handleStopCast);

  registerValidatedRoute('REMOVE_SPEAKER', RemoveSpeakerMessageSchema, handleRemoveSpeaker);

  registerRoute('GET_CAST_STATUS', handleGetStatus);

  registerRoute('GET_ACTIVE_CASTS', () => {
    const response: ActiveCastsResponse = { casts: getActiveCasts() };
    return response;
  });
}
