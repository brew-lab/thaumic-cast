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
  return { label: strings[badge.key] ?? badge.defaultValue, tone: badge.tone };
}

describe('speakerBadge', () => {
  it('should show no badge without a transport state', () => {
    expect(reading(undefined, false)).toBeNull();
    expect(reading(undefined, true)).toBeNull();
  });

  it('should say in use when something else is playing', () => {
    expect(reading('Playing', false)).toEqual({ label: 'In use', tone: 'busy' });
  });

  it('should keep loading as it was, since our own cast reports it before the card knows', () => {
    expect(reading('Transitioning', false)).toEqual({ label: 'Loading', tone: 'idle' });
  });

  it('should keep paused and stopped as they were when something else holds the speaker', () => {
    expect(reading('Paused', false)).toEqual({ label: 'Paused', tone: 'idle' });
    expect(reading('Stopped', false)).toEqual({ label: 'Not playing', tone: 'idle' });
  });

  it('should keep every reading of our own cast as it was', () => {
    expect(reading('Playing', true)).toEqual({ label: 'Casting', tone: 'casting' });
    expect(reading('Transitioning', true)).toEqual({ label: 'Loading', tone: 'idle' });
    expect(reading('Paused', true)).toEqual({ label: 'Paused', tone: 'idle' });
    expect(reading('Stopped', true)).toEqual({ label: 'Not playing', tone: 'idle' });
  });

  it('should fall back to the raw state for one with no label', () => {
    expect(reading('Recording', false)).toEqual({ label: 'Recording', tone: 'idle' });
  });
});
