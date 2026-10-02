import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';

import {
  entriesWithoutReference,
  lookupsWithoutEntry,
  networkHealthReasons,
  scanSourceKeys,
} from '../../../extension/src/test-support/locale-keys';
import en from './en.json';

const strings = en as Record<string, string>;
const SRC = join(import.meta.dir, '..');
const REPO = join(SRC, '../../..');

/** The transport states the core sends, as `TransportState`'s `Display` writes them. */
const TRANSPORT_STATES = ['Playing', 'Paused', 'Stopped', 'Transitioning'];

/**
 * Entries nothing uses that are left alone on purpose: they belong to the
 * settings pages, whose copy is being redesigned separately.
 */
const KNOWN_UNUSED = ['settings.manual_speakers_empty'];

describe('desktop en.json', () => {
  it('should have a label for every transport state the core sends', () => {
    for (const state of TRANSPORT_STATES) {
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
});
