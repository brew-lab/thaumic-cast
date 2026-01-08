/**
 * Cast Session Routes
 *
 * Handles message routing for cast session lifecycle:
 * - START_CAST, STOP_CAST, GET_CAST_STATUS, GET_ACTIVE_CASTS
 */

import type { ActiveCastsResponse } from '../../lib/messages';
import { registerRoute } from '../router';
import { handleStartCast, handleStopCast, handleGetStatus } from '../handlers/cast';
import { getActiveCasts } from '../session-manager';
import { StartCastMessageSchema, StopCastMessageSchema } from '../../lib/message-schemas';

/**
 * Registers all cast session routes.
 */
export function registerCastRoutes(): void {
  registerRoute('START_CAST', (msg) => {
    const validated = StartCastMessageSchema.parse(msg);
    return new Promise((resolve) => handleStartCast(validated, resolve));
  });

  registerRoute('STOP_CAST', (msg) => {
    const validated = StopCastMessageSchema.parse(msg);
    return new Promise((resolve) => handleStopCast(validated, resolve));
  });

  registerRoute('GET_CAST_STATUS', () => {
    return new Promise((resolve) => handleGetStatus(resolve));
  });

  registerRoute('GET_ACTIVE_CASTS', () => {
    const response: ActiveCastsResponse = { casts: getActiveCasts() };
    return response;
  });
}
