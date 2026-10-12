/**
 * Away Routes
 *
 * The popup's "While you were away" line:
 * - GET_AWAY_EVENTS: the events it has not shown yet, newest first
 * - MARK_AWAY_SEEN: it drew them, or the user dismissed the line
 */

import { registerRoute, registerValidatedRoute } from '../router';
import { getAwayEvents, markAwaySeen, unseenAwayEvents } from '../away-log';
import type { AwayEvent } from '../../lib/away-events';
import { MarkAwaySeenMessageSchema } from '../../lib/message-schemas';

/** The answer to GET_AWAY_EVENTS. */
export interface AwayEventsResponse {
  /** The unseen events, newest first. */
  events: AwayEvent[];
}

/**
 * Registers the away line's routes.
 */
export function registerAwayRoutes(): void {
  registerRoute('GET_AWAY_EVENTS', async (): Promise<AwayEventsResponse> => {
    return { events: unseenAwayEvents(await getAwayEvents()) };
  });

  registerValidatedRoute('MARK_AWAY_SEEN', MarkAwaySeenMessageSchema, async (msg) => {
    await markAwaySeen(msg.payload.ids);
    return { success: true };
  });
}
