import { beforeEach, describe, expect, it } from 'bun:test';

import { resetChromeStub } from '../test-support/chrome-stub';
import {
  compareSemver,
  companionTypeLabelKey,
  getDismissedCompanionVersion,
  hasVersionMismatch,
  isCompatible,
  setDismissedCompanionVersion,
  shouldWarnAboutVersion,
  versionMismatchActionKey,
  type CompanionInfo,
} from './versionCheck';

const MIN = '0.4.0';

function companion(overrides: Partial<CompanionInfo> = {}): CompanionInfo {
  return { appVersion: '1.0.0', protocolVersion: '0.4.0', appType: 'desktop', ...overrides };
}

describe('compareSemver', () => {
  it('should order by major, then minor, then patch', () => {
    expect(compareSemver('2.0.0', '1.9.9')).toBeGreaterThan(0);
    expect(compareSemver('1.2.0', '1.10.0')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '1.2.4')).toBeLessThan(0);
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
  });

  it('should ignore a prerelease suffix', () => {
    expect(compareSemver('1.2.3-beta.1', '1.2.3')).toBe(0);
  });

  it('should treat missing or malformed segments as zero', () => {
    expect(compareSemver('1', '1.0.1')).toBeLessThan(0);
    expect(compareSemver('1.x.3', '1.0.3')).toBe(0);
  });
});

describe('isCompatible', () => {
  it('should accept versions at or above the minimum', () => {
    expect(isCompatible('0.4.0', MIN)).toBe(true);
    expect(isCompatible('0.5.2', MIN)).toBe(true);
    expect(isCompatible('0.3.9', MIN)).toBe(false);
  });
});

describe('hasVersionMismatch', () => {
  it('should report nothing before any companion has connected', () => {
    expect(hasVersionMismatch(null, MIN)).toBe(false);
  });

  it('should treat a companion that does not advertise a protocol version as out of date', () => {
    expect(hasVersionMismatch(companion({ protocolVersion: null }), MIN)).toBe(true);
  });

  it('should compare the advertised protocol version against the minimum', () => {
    expect(hasVersionMismatch(companion({ protocolVersion: '0.3.0' }), MIN)).toBe(true);
    expect(hasVersionMismatch(companion({ protocolVersion: '0.4.0' }), MIN)).toBe(false);
  });
});

describe('shouldWarnAboutVersion', () => {
  const outdated = companion({ protocolVersion: '0.1.0' });

  it('should stay quiet for a compatible companion', () => {
    expect(shouldWarnAboutVersion(companion(), null, MIN)).toBe(false);
  });

  it('should warn about an outdated companion that was never dismissed', () => {
    expect(shouldWarnAboutVersion(outdated, null, MIN)).toBe(true);
  });

  it('should stay quiet once dismissed for the same companion build', () => {
    expect(shouldWarnAboutVersion(outdated, { appVersion: '1.0.0' }, MIN)).toBe(false);
  });

  it('should warn again when the companion build changes after a dismissal', () => {
    expect(shouldWarnAboutVersion(outdated, { appVersion: '0.9.0' }, MIN)).toBe(true);
  });

  it('should treat an unknown app version as its own dismissal bucket', () => {
    const unknownBuild = companion({ appVersion: null, protocolVersion: null });

    expect(shouldWarnAboutVersion(unknownBuild, { appVersion: null }, MIN)).toBe(false);
    expect(shouldWarnAboutVersion(outdated, { appVersion: null }, MIN)).toBe(true);
  });
});

describe('dismissal persistence', () => {
  beforeEach(() => {
    resetChromeStub();
  });

  it('should report null before anything was dismissed', async () => {
    expect(await getDismissedCompanionVersion()).toBeNull();
  });

  it('should round-trip the dismissed app version, including the null bucket', async () => {
    await setDismissedCompanionVersion('1.2.3');
    expect(await getDismissedCompanionVersion()).toEqual({ appVersion: '1.2.3' });

    await setDismissedCompanionVersion(null);
    expect(await getDismissedCompanionVersion()).toEqual({ appVersion: null });
  });
});

describe('i18n key helpers', () => {
  it('should pick the companion-specific key and fall back to generic', () => {
    expect(companionTypeLabelKey('desktop')).toBe('about_companion_type_desktop');
    expect(companionTypeLabelKey('server')).toBe('about_companion_type_server');
    expect(companionTypeLabelKey(null)).toBe('about_companion_type_generic');
    expect(companionTypeLabelKey(undefined)).toBe('about_companion_type_generic');
  });

  it('should resolve the update action key the same way', () => {
    expect(versionMismatchActionKey('server')).toBe('version_mismatch_action_server');
    expect(versionMismatchActionKey('desktop')).toBe('version_mismatch_action_desktop');
    expect(versionMismatchActionKey(null)).toBe('version_mismatch_action_generic');
  });
});
