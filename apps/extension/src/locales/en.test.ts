import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import i18next from 'i18next';
import type { SpeakerAvailability } from '@thaumic-cast/protocol';

import { CastAutoStopReasonSchema, SpeakerRemovalReasonSchema } from '../lib/message-schemas';
import type { ServerTestErrorType } from '../lib/serverTest';
import {
  entriesWithoutReference,
  errorKeysIn,
  hasEntry,
  lookupsWithoutEntry,
  networkHealthReasons,
  scanSourceKeys,
  unpairedPlurals,
} from '../test-support/locale-keys';
import en from './en.json';

const strings = en as Record<string, string>;
const SRC = join(import.meta.dir, '..');
const REPO = join(SRC, '../../..');

/** Files that send an `error_*` key to the popup, which translates it. */
const FILES_THAT_SEND_ERROR_KEYS = [
  'background/handlers/cast.ts',
  'background/handlers/connection.ts',
  'background/discovery.ts',
  'lib/capture-denied.ts',
  'background/connection-state.ts',
  'offscreen/handlers.ts',
  'offscreen/pcm-rate.ts',
  'offscreen/stream-session.ts',
  'popup/hooks/useConnectionStatus.ts',
];

/** Every way a server test can fail; the type makes a new one fail to compile here. */
const SERVER_TEST_ERRORS: Record<ServerTestErrorType, true> = {
  network_failed: true,
  server_error: true,
  wrong_server: true,
  permission_denied: true,
};

/**
 * Whether each availability shows a Badge on a room in the picker; a new one fails to
 * compile here. An available room shows none.
 */
const SPEAKER_AVAILABILITIES: Record<SpeakerAvailability, boolean> = {
  available: false,
  in_use: true,
  casting: true,
  remote_cast: true,
};

describe('extension en.json', () => {
  it('should have a message for every error key the background and offscreen send', () => {
    const sent = FILES_THAT_SEND_ERROR_KEYS.flatMap((file) => errorKeysIn(join(SRC, file)));
    expect(sent).toContain('error_offscreen_unavailable');
    expect(sent).toContain('error_unsupported_sample_rate');
    expect(sent).toContain('error_pcm_rate_unsupported');
    expect(sent).toContain('error_capture_denied_reason');
    expect(sent.filter((key) => !hasEntry(strings, key))).toEqual([]);
  });

  it('should have a message for every server test failure', () => {
    for (const type of Object.keys(SERVER_TEST_ERRORS)) {
      expect(strings[`error_${type}`]).toBeString();
    }
  });

  it('should have a message for every auto-stop reason that is shown', () => {
    // A removal the user asked for is never announced.
    const shown = CastAutoStopReasonSchema.options.filter((reason) => reason !== 'user_removed');
    for (const reason of shown) {
      expect(strings[`auto_stop_${reason}`]).toBeString();
    }
  });

  it('should have a message for every reason a speaker leaves a cast that carries on', () => {
    const shown = SpeakerRemovalReasonSchema.options.filter((reason) => reason !== 'user_removed');
    for (const reason of shown) {
      const line = strings[`speaker_removed_${reason}`];
      expect(line).toContain('{{name}}');
      // The cast is still running, so the line must not send the user to cast again.
      expect(line).not.toContain('Cast again');
      expect(line).toContain('carries on');
    }
  });

  it('should have a Badge word for every speaker availability that shows one', () => {
    for (const [availability, shown] of Object.entries(SPEAKER_AVAILABILITIES)) {
      expect(typeof strings[`speaker_availability_${availability}`]).toBe(
        shown ? 'string' : 'undefined',
      );
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
    expect(entriesWithoutReference(strings, scanSourceKeys(SRC))).toEqual([]);
  });

  it('should have both forms of every plural', () => {
    expect(unpairedPlurals(strings)).toEqual([]);
  });

  it('should pick the singular for one and the plural for any other count', async () => {
    // The same options the extension initialises i18next with.
    const i18n = i18next.createInstance();
    await i18n.init({
      resources: { en: { translation: en } },
      lng: 'en',
      interpolation: { escapeValue: false },
    });

    expect(i18n.t('cast_to_n_rooms', { count: 1 })).toBe('Cast to 1 room');
    expect(i18n.t('cast_to_n_rooms', { count: 3 })).toBe('Cast to 3 rooms');
    expect(i18n.t('hidden_chosen', { count: 1 })).toStartWith('1 chosen room is hidden');
    expect(i18n.t('cast_plays_too', { count: 1, name: 'Patio', with: 'Kitchen' })).toBe(
      'Patio plays too, as it is grouped with Kitchen.',
    );
    expect(i18n.t('cast_plays_too', { count: 2, names: 'Patio and Deck' })).toBe(
      'Patio and Deck play too, as they are grouped with your rooms.',
    );
    expect(i18n.t('cast_leaves_group', { count: 1, name: 'Kitchen' })).toBe(
      'Kitchen leaves its Sonos group until you stop.',
    );
    expect(i18n.t('cast_leaves_group', { count: 2, names: 'Kitchen and Deck' })).toBe(
      'Kitchen and Deck leave their Sonos groups until you stop.',
    );
    expect(i18n.t('onboarding.speakers.found', { count: 1 })).toBe('1 room answered.');
    expect(i18n.t('onboarding.speakers.found', { count: 2 })).toBe('2 rooms answered.');
    expect(i18n.t('ingest_gaps_message_desktop', { count: 1, suggested: 500 })).toContain(
      'late once in the last minute',
    );
    expect(i18n.t('ingest_gaps_message_server', { count: 4, suggested: 500 })).toContain(
      'late 4 times in the last minute',
    );
    expect(i18n.t('onboarding.step_of_named', { current: 2, total: 4, label: 'Desktop' })).toBe(
      'Step 2 of 4: Desktop',
    );
    expect(i18n.t('error_max_sessions', { max: 10 })).toStartWith('10 casts at once is the limit');
    const partial = (missing: string[], rest: string[]): string =>
      i18n.t('set_partial', {
        count: rest.length,
        missing: i18n.t('set_partial_missing', {
          count: missing.length,
          names: missing.join(' and '),
        }),
        rest: rest.join(' and '),
      });
    expect(partial(['Patio'], ['Kitchen'])).toBe('Patio is not answering, so only Kitchen plays.');
    expect(partial(['Patio', 'Deck'], ['Kitchen', 'Study'])).toBe(
      'Patio and Deck are not answering, so only Kitchen and Study play.',
    );
  });
});
