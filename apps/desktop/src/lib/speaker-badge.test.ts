import { TransportStateSchema } from '@thaumic-cast/protocol';
import { describe, expect, it } from 'bun:test';

import en from '../locales/en.json';
import { speakerBadge } from './speaker-badge';

const strings = en as Record<string, string>;

/**
 * Reads a badge the way the card shows it.
 * @param state - The transport state
 * @param isCasting - Whether our cast is on the speaker
 * @returns The English label and tone, or null for no badge
 */
function reading(state: string | undefined, isCasting: boolean) {
  const badge = speakerBadge(state, isCasting);
  if (!badge) return null;
  return { label: strings[badge.key], tone: badge.tone };
}

describe('speakerBadge', () => {
  it('should show no badge without a transport state, unless our cast holds it', () => {
    expect(reading(undefined, false)).toBeNull();
    expect(reading(undefined, true)).toEqual({ label: 'Casting', tone: 'casting' });
  });

  it('should say in use when something else is playing', () => {
    expect(reading('Playing', false)).toEqual({ label: 'In use', tone: 'warning' });
  });

  it('should keep loading as it was, since our own cast reports it before the card knows', () => {
    expect(reading('Transitioning', false)).toEqual({ label: 'Loading', tone: 'busy' });
  });

  it('should keep paused and stopped as they were when something else holds the speaker', () => {
    expect(reading('PAUSED_PLAYBACK', false)).toEqual({ label: 'Paused', tone: 'neutral' });
    expect(reading('Stopped', false)).toEqual({ label: 'Not playing', tone: 'neutral' });
  });

  it('should keep every reading of our own cast as it was', () => {
    expect(reading('Playing', true)).toEqual({ label: 'Casting', tone: 'casting' });
    expect(reading('Transitioning', true)).toEqual({ label: 'Loading', tone: 'busy' });
    expect(reading('PAUSED_PLAYBACK', true)).toEqual({ label: 'Paused', tone: 'neutral' });
    expect(reading('Stopped', true)).toEqual({ label: 'Not playing', tone: 'neutral' });
  });

  it('should show no badge for a state with no words, never the raw state name', () => {
    expect(reading('Recording', false)).toBeNull();
    expect(reading('NO_MEDIA_PRESENT', true)).toBeNull();
  });

  it('should have words for every state the core sends', () => {
    for (const state of TransportStateSchema.options) {
      for (const casting of [false, true]) {
        expect(reading(state, casting)?.label).toBeString();
      }
    }
  });
});
