import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import i18next from 'i18next';

import {
  entriesWithoutReference,
  lookupsWithoutEntry,
  networkHealthReasons,
  scanSourceKeys,
  unpairedPlurals,
} from '../../../extension/src/test-support/locale-keys';
import { speakerBadge } from '../lib/speaker-badge';
import en from './en.json';

const strings = en as Record<string, string>;
const SRC = join(import.meta.dir, '..');
const REPO = join(SRC, '../../..');

/**
 * Reads the transport states the core sends from `TransportState` in the core's
 * source, as serde writes them to the app (a `#[serde(rename)]` wins over the
 * variant's name), so a state added there fails this test until it has a label.
 * @returns The state names as the app receives them
 */
function transportStates(): string[] {
  const source = readFileSync(join(REPO, 'packages/thaumic-core/src/sonos/types.rs'), 'utf8');
  const body = /pub enum TransportState \{([\s\S]*?)\n\}/.exec(source);
  if (!body) throw new Error('TransportState is missing from sonos/types.rs');
  return [...body[1]!.matchAll(/(?:#\[serde\(rename = "([^"]+)"\)\]\s*)?(\w+),/g)].map(
    (m) => m[1] ?? m[2]!,
  );
}

describe('desktop en.json', () => {
  it('should have badge words for every transport state the core sends', () => {
    const states = transportStates();
    expect(states).toContain('Playing');
    expect(states).toContain('PAUSED_PLAYBACK');
    for (const state of states) {
      for (const casting of [false, true]) {
        const badge = speakerBadge(state, casting);
        expect(badge).not.toBeNull();
        expect(strings[badge!.key]).toBeString();
      }
    }
  });

  it('should have a message for every network health reason the core reports', () => {
    const reasons = networkHealthReasons(REPO);
    expect(reasons.sort()).toEqual([
      'speakers_not_responding',
      'speakers_unreachable',
      'speakers_upnp_disabled',
    ]);
    for (const reason of reasons) {
      expect(strings[`network.${reason}`]).toBeString();
    }
  });

  it('should have an entry for every key the code looks up by name', () => {
    expect(lookupsWithoutEntry(strings, scanSourceKeys(SRC))).toEqual([]);
  });

  it('should have no entry that nothing looks up', () => {
    expect(entriesWithoutReference(strings, scanSourceKeys(SRC))).toEqual([]);
  });

  it('should have both forms of every plural', () => {
    expect(unpairedPlurals(strings)).toEqual([]);
  });

  it('should pick the singular for one and the plural for any other count', async () => {
    // The same options the desktop app initialises i18next with.
    const i18n = i18next.createInstance();
    await i18n.init({
      resources: { en: { translation: en } },
      lng: 'en',
      interpolation: { escapeValue: false },
    });
    const summary = (rooms: number, streams: number): string =>
      i18n.t('speakers.summary', {
        rooms: i18n.t('speakers.summary_rooms', { count: rooms }),
        streams: i18n.t('speakers.summary_streaming', { count: streams }),
      });

    expect(summary(1, 0)).toBe('1 room, 0 casting');
    expect(summary(4, 2)).toBe('4 rooms, 2 casting');
    expect(i18n.t('onboarding.speakers.found', { count: 1 })).toBe('1 room answered.');
    expect(i18n.t('onboarding.speakers.found', { count: 5 })).toBe('5 rooms answered.');
    expect(i18n.t('onboarding.ready.summary_rooms', { count: 1 })).toBe('Rooms: 1 answered');
    expect(i18n.t('server.stopped', { count: 1 })).toBe('Stopped 1 cast.');
    expect(i18n.t('server.stopped', { count: 3 })).toBe('Stopped 3 casts.');
    expect(i18n.t('server.stopped_remote', { count: 2 })).toBe(
      '2 of them were not started on this computer.',
    );
    expect(i18n.t('onboarding.step_of', { current: 1, total: 5 })).toBe('Step 1 of 5');
  });
});
