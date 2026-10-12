import { afterEach, beforeEach, describe, expect, it, setSystemTime } from 'bun:test';

import { AWAY_MAX_AGE_MS, POPUP_PORT_NAME, pruneAway, type AwayEvent } from '../lib/away-events';
import { chromeStorageData, resetChromeStub } from '../test-support/chrome-stub';
import {
  AWAY_EVENTS_KEY,
  getAwayEvents,
  isPopupOpen,
  markAwaySeen,
  markConnectionRecovered,
  recordCastEnded,
  recordConnectionLost,
  recordJoinFailed,
  recordSpeakerLeft,
  recordStopFailed,
  resetAwayLogForTests,
  trackPopupPort,
  unseenAwayEvents,
} from './away-log';

const NOW = Date.UTC(2026, 9, 9, 12);

/**
 * A fake popup port.
 * @param name - The port's name
 * @returns The port and a function that disconnects it
 */
function port(name = POPUP_PORT_NAME): { port: chrome.runtime.Port; close: () => void } {
  const listeners: (() => void)[] = [];
  const fake = {
    name,
    onDisconnect: { addListener: (listener: () => void) => listeners.push(listener) },
  } as unknown as chrome.runtime.Port;
  return { port: fake, close: () => listeners.forEach((listener) => listener()) };
}

/**
 * A stored event.
 * @param at - When it happened
 * @returns The event
 */
function event(at: number): AwayEvent {
  return {
    id: String(at),
    kind: 'speaker_left',
    sev: 'neutral',
    subject: 'Patio',
    params: {},
    at,
    shownAt: null,
  };
}

beforeEach(() => {
  resetChromeStub();
  resetAwayLogForTests();
  setSystemTime(NOW);
});

afterEach(() => {
  setSystemTime();
});

describe('pruneAway', () => {
  it('should keep the newest 10', () => {
    const events = Array.from({ length: 12 }, (_, i) => event(NOW - 12 + i));
    expect(pruneAway(events, NOW).map((e) => e.at)).toEqual(events.slice(2).map((e) => e.at));
  });

  it('should drop events older than 24 hours', () => {
    const events = [event(NOW - AWAY_MAX_AGE_MS - 1), event(NOW - AWAY_MAX_AGE_MS), event(NOW)];
    expect(pruneAway(events, NOW).map((e) => e.at)).toEqual([NOW - AWAY_MAX_AGE_MS, NOW]);
  });
});

describe('popup presence', () => {
  it('should count popup ports until they disconnect, and ignore other ports', () => {
    const first = port();
    const second = port();
    trackPopupPort(port('other').port);
    expect(isPopupOpen()).toBe(false);

    trackPopupPort(first.port);
    trackPopupPort(second.port);
    first.close();
    expect(isPopupOpen()).toBe(true);
    second.close();
    expect(isPopupOpen()).toBe(false);
  });
});

describe('recording', () => {
  it('should store a fault while the popup is shut as unseen, with the shipped sentence', async () => {
    await recordCastEnded(4, 'Song', 'Kitchen', 'playback_stopped');

    const [stored] = await getAwayEvents();
    expect(stored).toMatchObject({
      kind: 'cast_ended',
      sev: 'warning',
      subject: 'Song',
      key: 'auto_stop_playback_stopped',
      params: { name: 'Kitchen' },
      tabId: 4,
      at: NOW,
      shownAt: null,
    });
    expect(unseenAwayEvents(await getAwayEvents())).toHaveLength(1);
  });

  it('should store an event seen live as already shown', async () => {
    trackPopupPort(port().port);

    await recordSpeakerLeft(4, 'Patio', 'source_changed');

    const [stored] = await getAwayEvents();
    expect(stored.shownAt).toBe(NOW);
    expect(unseenAwayEvents(await getAwayEvents())).toEqual([]);
  });

  it('should call a cast someone else ended neutral, and skip what the user did', async () => {
    await recordCastEnded(4, 'Song', 'Kitchen', 'source_changed');
    await recordCastEnded(4, 'Song', 'Kitchen', 'user_removed');
    await recordSpeakerLeft(4, 'Patio', 'user_removed');

    expect((await getAwayEvents()).map((e) => e.sev)).toEqual(['neutral']);
  });

  it('should store a stop failure or a failed join only when the popup is shut', async () => {
    trackPopupPort(port().port);
    await recordStopFailed(4, 'Kitchen');
    await recordJoinFailed(4, 'Study');
    expect(await getAwayEvents()).toEqual([]);

    resetAwayLogForTests();
    await recordStopFailed(4, 'Kitchen');
    await recordJoinFailed(4, 'Study');
    expect((await getAwayEvents()).map((e) => [e.kind, e.sev, e.subject])).toEqual([
      ['stop_failed', 'danger', 'Kitchen'],
      ['join_failed', 'danger', 'Study'],
    ]);
  });

  it('should show a lost connection only once it is back, and only when casts stopped', async () => {
    await recordConnectionLost(0);
    expect(await getAwayEvents()).toEqual([]);

    await recordConnectionLost(2);
    expect(unseenAwayEvents(await getAwayEvents())).toEqual([]);

    await markConnectionRecovered();
    const [shown] = unseenAwayEvents(await getAwayEvents());
    expect(shown).toMatchObject({
      kind: 'connection_lost',
      recoveredAt: NOW,
      params: { count: 2 },
    });
  });

  it('should list unseen events newest first and never show one twice', async () => {
    await recordSpeakerLeft(4, 'Patio', 'source_changed');
    setSystemTime(NOW + 1000);
    await recordSpeakerLeft(4, 'Deck', 'source_changed');

    const unseen = unseenAwayEvents(await getAwayEvents());
    expect(unseen.map((e) => e.subject)).toEqual(['Deck', 'Patio']);

    await markAwaySeen(unseen.map((e) => e.id));
    expect(unseenAwayEvents(await getAwayEvents())).toEqual([]);
    expect(chromeStorageData.session[AWAY_EVENTS_KEY]).toHaveLength(2);
  });
});
