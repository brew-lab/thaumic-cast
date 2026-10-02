import { describe, expect, it } from 'bun:test';

import en from '../locales/en.json';
import { getSpeakerErrorMessage, probeErrorCode } from './useAddManualSpeaker';

const strings = en as Record<string, string>;
const t = (key: string): string => key;

/** Words a rejected probe as the form does: read the code, then pick the key. */
function keyFor(rejection: unknown): string {
  return getSpeakerErrorMessage(probeErrorCode(rejection), t);
}

describe('probeErrorCode', () => {
  it('should read the code off the object a Tauri command rejects with', () => {
    expect(probeErrorCode({ code: 'ip_unreachable', message: 'No route to host' })).toBe(
      'ip_unreachable',
    );
  });

  it('should fall back to the value as text when there is no code', () => {
    expect(probeErrorCode('not_sonos_device: no device description')).toBe(
      'not_sonos_device: no device description',
    );
    expect(probeErrorCode(new Error('boom'))).toBe('Error: boom');
    expect(probeErrorCode({ code: 42 })).toBe('[object Object]');
    expect(probeErrorCode(null)).toBe('null');
  });
});

describe('manual speaker errors', () => {
  it('should give each of the three codes its own message', () => {
    expect(keyFor({ code: 'ip_unreachable', message: 'x' })).toBe(
      'onboarding.speakers.manual_error_unreachable',
    );
    expect(keyFor({ code: 'not_sonos_device', message: 'x' })).toBe(
      'onboarding.speakers.manual_error_not_sonos',
    );
    expect(keyFor({ code: 'invalid_ip', message: 'x' })).toBe(
      'onboarding.speakers.manual_error_invalid',
    );
  });

  it('should still recognise a code inside a plain string', () => {
    expect(keyFor('ip_unreachable')).toBe('onboarding.speakers.manual_error_unreachable');
  });

  it('should give the generic message for an unknown code or anything else', () => {
    const generic = 'onboarding.speakers.manual_error_generic';
    expect(keyFor({ code: 'network_error', message: 'x' })).toBe(generic);
    expect(keyFor(new Error('timed out'))).toBe(generic);
    expect(keyFor({ message: 'no code here' })).toBe(generic);
    expect(keyFor(undefined)).toBe(generic);
  });

  it('should have a string for all four messages', () => {
    for (const kind of ['unreachable', 'not_sonos', 'invalid', 'generic']) {
      expect(strings[`onboarding.speakers.manual_error_${kind}`]).toBeString();
    }
  });
});
