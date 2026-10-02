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
import en from './en.json';

const strings = en as Record<string, string>;
const SRC = join(import.meta.dir, '..');
const REPO = join(SRC, '../../..');

/**
 * Reads the transport states the core sends from `TransportState`'s `Display`
 * in the core's source, so a state added there fails this test until it has a
 * label.
 * @returns The state names as `Display` writes them
 */
function transportStates(): string[] {
  const source = readFileSync(join(REPO, 'packages/thaumic-core/src/sonos/types.rs'), 'utf8');
  const display = /impl std::fmt::Display for TransportState \{[\s\S]*?\n\}/.exec(source);
  if (!display) throw new Error('TransportState has no Display impl in sonos/types.rs');
  return [...display[0].matchAll(/Self::\w+ => write!\(f, "([^"]+)"\)/g)].map((m) => m[1]!);
}

/**
 * Entries nothing uses that are left alone on purpose: they belong to the
 * settings pages, whose copy is being redesigned separately.
 */
const KNOWN_UNUSED = ['settings.manual_speakers_empty'];

describe('desktop en.json', () => {
  it('should have a label for every transport state the core sends', () => {
    const states = transportStates();
    expect(states).toContain('Playing');
    for (const state of states) {
      expect(strings[`transport.${state.toLowerCase()}`]).toBeString();
    }
  });

  it('should have a message for every network health reason the core reports', () => {
    const reasons = networkHealthReasons(REPO);
    expect(reasons.sort()).toEqual(['speakers_not_responding', 'speakers_unreachable']);
    for (const reason of reasons) {
      expect(strings[`network.${reason}`]).toBeString();
    }
  });

  it('should have an entry for every key the code looks up by name', () => {
    expect(lookupsWithoutEntry(strings, scanSourceKeys(SRC))).toEqual([]);
  });

  it('should have no entry that nothing looks up', () => {
    expect(entriesWithoutReference(strings, scanSourceKeys(SRC)).sort()).toEqual(
      [...KNOWN_UNUSED].sort(),
    );
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
    const summary = (speakers: number, streams: number): string =>
      i18n.t('speakers.summary', {
        speakers: i18n.t('speakers.summary_speakers', { count: speakers }),
        streams: i18n.t('speakers.summary_streaming', { count: streams }),
      });

    expect(summary(1, 0)).toBe('1 speaker, 0 streaming');
    expect(summary(4, 2)).toBe('4 speakers, 2 streaming');
    expect(i18n.t('device.others', { count: 1 })).toBe('+1 other');
    expect(i18n.t('device.others', { count: 2 })).toBe('+2 others');
    expect(i18n.t('onboarding.speakers.found', { count: 1 })).toStartWith('Found 1 speaker.');
    expect(i18n.t('onboarding.speakers.found', { count: 5 })).toStartWith('Found 5 speakers.');
    expect(i18n.t('onboarding.ready.summary_speakers', { count: 1 })).toBe('Speakers: 1 found');
    expect(i18n.t('onboarding.step_of', { current: 1, total: 5 })).toBe('Step 1 of 5');
  });
});
