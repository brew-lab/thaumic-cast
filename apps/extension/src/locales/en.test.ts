import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import type { SpeakerAvailability } from '@thaumic-cast/protocol';

import { CastAutoStopReasonSchema } from '../lib/message-schemas';
import type { ServerTestErrorType } from '../lib/serverTest';
import {
  entriesWithoutReference,
  errorKeysIn,
  hasEntry,
  lookupsWithoutEntry,
  networkHealthReasons,
  scanSourceKeys,
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
  'background/connection-state.ts',
  'offscreen/handlers.ts',
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

/** Every availability the speaker picker can show; a new one fails to compile here. */
const SPEAKER_AVAILABILITIES: Record<SpeakerAvailability, true> = {
  available: true,
  in_use: true,
  casting: true,
  remote_cast: true,
};

/**
 * Entries nothing uses that are left alone on purpose: they belong to the
 * settings pages, whose copy is being redesigned separately.
 */
const KNOWN_UNUSED = ['bitrate_not_applicable'];

describe('extension en.json', () => {
  it('should have a message for every error key the background and offscreen send', () => {
    const sent = FILES_THAT_SEND_ERROR_KEYS.flatMap((file) => errorKeysIn(join(SRC, file)));
    expect(sent).toContain('error_offscreen_unavailable');
    expect(sent).toContain('error_unsupported_sample_rate');
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

  it('should have a label for every speaker availability', () => {
    for (const availability of Object.keys(SPEAKER_AVAILABILITIES)) {
      expect(strings[`speaker_availability_${availability}`]).toBeString();
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
});
