/**
 * Away Events
 *
 * The shape of what the background stores for the popup's "While you were
 * away" line, and the pure rules over it. The background keeps the store
 * (`background/away-log.ts`); the popup reads it through GET_AWAY_EVENTS.
 */

/** The port name a popup connects with while it is open. */
export const POPUP_PORT_NAME = 'popup';

/** How many events are kept. */
export const AWAY_MAX_EVENTS = 10;

/** How long an event is kept, in ms. */
export const AWAY_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** What happened. */
export type AwayEventKind =
  | 'cast_ended'
  | 'speaker_left'
  | 'connection_lost'
  | 'stop_failed'
  | 'join_failed';

/** How serious it is: neutral events never set the badge. */
export type AwaySeverity = 'neutral' | 'warning' | 'danger';

/** One stored event. */
export interface AwayEvent {
  /** A unique id. */
  id: string;
  /** What happened. */
  kind: AwayEventKind;
  /** How serious it is. */
  sev: AwaySeverity;
  /**
   * Who the lead names: the cast's title ("Cast to {{name}} ended") or the
   * room's name ("{{name}} left this cast"); empty for a lost connection.
   */
  subject: string;
  /**
   * The shipped sentence's string key (the line under the lead), when the
   * event has one. The lead itself follows from `kind`.
   */
  key?: string;
  /** The sentence's values. */
  params: Record<string, string | number>;
  /** The cast's tab, when the event is about one cast. */
  tabId?: number;
  /** When it happened (epoch ms). */
  at: number;
  /** When the popup showed it (live or in the away line); null while unseen. */
  shownAt: number | null;
  /** For a lost connection: when it came back; null while it is still down. */
  recoveredAt?: number | null;
}

/** What a caller records; the log adds the id, the time and whether it was seen. */
export type AwayEventInput = Omit<AwayEvent, 'id' | 'at' | 'shownAt'>;

/**
 * Keeps the newest {@link AWAY_MAX_EVENTS}, none older than {@link AWAY_MAX_AGE_MS}.
 * @param events - The events, oldest first
 * @param now - The time now
 * @returns The events kept, oldest first
 */
export function pruneAway(events: readonly AwayEvent[], now: number): AwayEvent[] {
  return events.filter((event) => now - event.at <= AWAY_MAX_AGE_MS).slice(-AWAY_MAX_EVENTS);
}

/**
 * The events the away line shows: not yet shown, newest first. A lost
 * connection shows only once it has come back; until then the banner says it.
 * @param events - The stored events
 * @returns The unseen events, newest first
 */
export function unseenAwayEvents(events: readonly AwayEvent[]): AwayEvent[] {
  return events
    .filter((event) => event.shownAt === null)
    .filter((event) => event.kind !== 'connection_lost' || Boolean(event.recoveredAt))
    .reverse();
}
