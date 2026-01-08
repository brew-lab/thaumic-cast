/**
 * Cast Session Routes
 *
 * Handles message routing for cast session lifecycle:
 * - START_CAST, STOP_CAST, GET_CAST_STATUS, GET_ACTIVE_CASTS
 */

import type { StartCastMessage, StopCastMessage, ActiveCastsResponse } from '../../lib/messages';
import { registerRoute } from '../router';
import { handleStartCast, handleStopCast, handleGetStatus } from '../handlers/cast';
import { getActiveCasts } from '../session-manager';

/**
 * Registers all cast session routes.
 */
export function registerCastRoutes(): void {
  registerRoute<StartCastMessage>('START_CAST', (msg) => {
    return new Promise((resolve) => handleStartCast(msg, resolve));
  });

  registerRoute<StopCastMessage>('STOP_CAST', (msg) => {
    return new Promise((resolve) => handleStopCast(msg, resolve));
  });

  registerRoute('GET_CAST_STATUS', () => {
    return new Promise((resolve) => handleGetStatus(resolve));
  });

  registerRoute('GET_ACTIVE_CASTS', () => {
    const response: ActiveCastsResponse = { casts: getActiveCasts() };
    return response;
  });
}
