/**
 * Away Log
 *
 * What happened to the casts while the popup was shut, for its one "While you
 * were away" line (DESIGN.md P-away, notices-spec §6) and the toolbar badge.
 *
 * Responsibilities:
 * - Know whether a popup is open (it holds a `popup` port while it is)
 * - Store events in `chrome.storage.session`: the last 10, none older than 24 h
 * - Store an event the open popup saw live as already shown, so it is never
 *   repeated; store a stop failure or a failed join only when its answer came
 *   after the popup shut
 * - Mark events shown once the popup has drawn them
 *
 * Non-responsibilities:
 * - The words (the popup turns `key` and `params` into text)
 * - The badge itself (toolbar-badge.ts reads `unseenAwayEvents`)
 */

import { createLogger } from '@thaumic-cast/shared';
import type { CastAutoStopReason, SpeakerRemovalReason } from '../lib/message-schemas';
import { autoStopMessageKey } from '../lib/auto-stop-message';
import { getSpeakerGroups } from './sonos-state';
import {
  POPUP_PORT_NAME,
  pruneAway,
  type AwayEvent,
  type AwayEventInput,
} from '../lib/away-events';

export { unseenAwayEvents } from '../lib/away-events';

const log = createLogger('AwayLog');

/** The storage key in `chrome.storage.session`. */
export const AWAY_EVENTS_KEY = 'awayEvents';

// ─────────────────────────────────────────────────────────────────────────────
// Popup presence
// ─────────────────────────────────────────────────────────────────────────────

let openPopups = 0;

/**
 * Whether a popup is open now.
 * @returns True while at least one popup holds its port
 */
export function isPopupOpen(): boolean {
  return openPopups > 0;
}

/**
 * Counts a popup's port, until it disconnects.
 * @param port - A port from `chrome.runtime.onConnect`
 */
export function trackPopupPort(port: chrome.runtime.Port): void {
  if (port.name !== POPUP_PORT_NAME) return;
  openPopups += 1;
  port.onDisconnect.addListener(() => {
    openPopups = Math.max(0, openPopups - 1);
  });
}

/**
 * Listens for popups opening. Call once from the service worker's start.
 */
export function watchPopupPorts(): void {
  chrome.runtime.onConnect.addListener(trackPopupPort);
}

// ─────────────────────────────────────────────────────────────────────────────
// Storage
// ─────────────────────────────────────────────────────────────────────────────

const listeners = new Set<(events: AwayEvent[]) => void>();

/**
 * Calls `listener` whenever the stored events change.
 * @param listener - Receives the events
 * @returns Unsubscribe
 */
export function onAwayEventsChanged(listener: (events: AwayEvent[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Reads the stored events.
 * @returns The events, oldest first
 */
export async function getAwayEvents(): Promise<AwayEvent[]> {
  try {
    const stored = await chrome.storage.session.get(AWAY_EVENTS_KEY);
    const events = stored[AWAY_EVENTS_KEY];
    return Array.isArray(events) ? (events as AwayEvent[]) : [];
  } catch (err) {
    log.warn('Failed to read the away events:', err);
    return [];
  }
}

// Writes run one after another, so two events at once never lose one.
let writes: Promise<unknown> = Promise.resolve();

/**
 * Changes the stored events.
 * @param change - Builds the new list from the stored one
 * @returns The events written
 */
function updateAway(change: (events: AwayEvent[]) => AwayEvent[]): Promise<AwayEvent[]> {
  const next = writes.then(async () => {
    const events = pruneAway(change(await getAwayEvents()), Date.now());
    await chrome.storage.session.set({ [AWAY_EVENTS_KEY]: events });
    for (const listener of listeners) listener(events);
    return events;
  });
  writes = next.catch((err) => log.warn('Failed to write the away events:', err));
  return next;
}

/**
 * Records an event. One the open popup sees live is stored as shown.
 * @param input - The event
 * @returns The stored event
 */
export async function recordAwayEvent(input: AwayEventInput): Promise<AwayEvent> {
  const now = Date.now();
  const event: AwayEvent = {
    ...input,
    id: crypto.randomUUID(),
    at: now,
    shownAt: isPopupOpen() ? now : null,
  };
  await updateAway((events) => [...events, event]);
  return event;
}

/**
 * Marks events shown: the popup drew them, or the user dismissed them.
 * @param ids - The events' ids
 * @returns Resolves when stored
 */
export async function markAwaySeen(ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  const now = Date.now();
  await updateAway((events) =>
    events.map((event) =>
      ids.includes(event.id) && event.shownAt === null ? { ...event, shownAt: now } : event,
    ),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// The events
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A speaker's room name, for the lead and the sentence: its group's name when it leads one,
 * else its own (a room of a cast played as one Sonos group).
 * @param speakerIp - The speaker's IP
 * @returns Its name, or the IP when it is not known
 */
export function speakerNameOf(speakerIp: string): string {
  const group = getSpeakerGroups().findGroupContainingSpeaker(speakerIp);
  if (!group) return speakerIp;
  if (group.isCoordinator(speakerIp)) return group.name;
  return group.findMember(speakerIp)?.name ?? group.name;
}

/**
 * A cast's rooms, for "Cast to {{name}} ended": its speakers' names, joined.
 * @param speakerIps - The cast's speakers
 * @returns The names, joined by " + "
 */
export function castRoomsOf(speakerIps: readonly string[]): string {
  return speakerIps.map(speakerNameOf).join(' + ');
}

/** Auto-stops someone chose (another source, another cast): neutral, no badge. */
const CHOSEN_STOPS: readonly CastAutoStopReason[] = [
  'source_changed',
  'speaker_taken_over',
  'speaker_stopped',
  'stream_ended',
];

/**
 * Records a cast that ended on its own. A stop the user asked for is not one.
 * @param tabId - The cast's tab
 * @param castRooms - The cast's rooms, for "Cast to {{name}} ended"
 * @param speakerName - The room the shipped sentence names
 * @param reason - Why it ended
 * @param params - Values the shipped sentence prints
 * @returns Resolves when stored
 */
export async function recordCastEnded(
  tabId: number,
  castRooms: string,
  speakerName: string,
  reason: CastAutoStopReason,
  params: Record<string, string | number> = {},
): Promise<void> {
  if (reason === 'user_removed') return;
  await recordAwayEvent({
    kind: 'cast_ended',
    sev: CHOSEN_STOPS.includes(reason) ? 'neutral' : 'warning',
    subject: castRooms,
    key: autoStopMessageKey(reason, false),
    params: { ...params, name: speakerName },
    tabId,
  });
}

/**
 * Records a room that left a cast that carries on. Removing it by hand is not one.
 * @param tabId - The cast's tab
 * @param speakerName - The room's name
 * @param reason - Why it left
 * @returns Resolves when stored
 */
export async function recordSpeakerLeft(
  tabId: number,
  speakerName: string,
  reason: SpeakerRemovalReason,
): Promise<void> {
  if (reason === 'user_removed') return;
  await recordAwayEvent({
    kind: 'speaker_left',
    sev: 'neutral',
    subject: speakerName,
    key: autoStopMessageKey(reason, true),
    params: { name: speakerName },
    tabId,
  });
}

/**
 * Records a room that was told to stop and carried on, when the answer came
 * after the popup shut (an open popup shows it on the row).
 * @param tabId - The cast's tab
 * @param speakerName - The room's name
 * @returns Resolves when stored, or at once while a popup is open
 */
export async function recordStopFailed(tabId: number, speakerName: string): Promise<void> {
  if (isPopupOpen()) return;
  await recordAwayEvent({
    kind: 'stop_failed',
    sev: 'danger',
    subject: speakerName,
    params: { name: speakerName },
    tabId,
  });
}

/**
 * Records a room that did not join a cast, when the answer came after the
 * popup shut (an open popup shows it on the row).
 * @param tabId - The cast's tab
 * @param roomName - The room's name
 * @returns Resolves when stored, or at once while a popup is open
 */
export async function recordJoinFailed(tabId: number, roomName: string): Promise<void> {
  if (isPopupOpen()) return;
  await recordAwayEvent({
    kind: 'join_failed',
    sev: 'danger',
    subject: roomName,
    params: { name: roomName },
    tabId,
  });
}

/**
 * Records the companion's connection lost for good while casts were running.
 * It shows in the away line only once the connection is back.
 * @param castsStopped - How many casts it stopped; nothing is recorded for none
 * @returns Resolves when stored
 */
export async function recordConnectionLost(castsStopped: number): Promise<void> {
  if (castsStopped === 0) return;
  await recordAwayEvent({
    kind: 'connection_lost',
    sev: 'warning',
    subject: '',
    key: 'error_connection_lost',
    params: { count: castsStopped },
    recoveredAt: null,
  });
}

/**
 * Marks every lost connection still down as recovered, so the away line can
 * say it happened.
 * @returns Resolves when stored
 */
export async function markConnectionRecovered(): Promise<void> {
  const events = await getAwayEvents();
  if (!events.some((event) => event.kind === 'connection_lost' && !event.recoveredAt)) return;
  const now = Date.now();
  await updateAway((stored) =>
    stored.map((event) =>
      event.kind === 'connection_lost' && !event.recoveredAt
        ? { ...event, recoveredAt: now }
        : event,
    ),
  );
}

/**
 * Forgets every event and open popup. For tests.
 */
export function resetAwayLogForTests(): void {
  openPopups = 0;
  listeners.clear();
  writes = Promise.resolve();
}
