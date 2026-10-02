import { describe, expect, it } from 'bun:test';

import en from '../locales/en.json';
import { speakerMonitorOverrideKey } from './speaker-monitor-setting';

const strings = en as Record<string, string>;

describe('speakerMonitorOverrideKey', () => {
  it('should say nothing while the setting loads or no variable fixes it', () => {
    expect(speakerMonitorOverrideKey(null)).toBeNull();
    expect(
      speakerMonitorOverrideKey({ enabled: false, envOverride: null, origin: 'file' }),
    ).toBeNull();
    expect(
      speakerMonitorOverrideKey({ enabled: true, envOverride: null, origin: 'default' }),
    ).toBeNull();
  });

  it('should name THAUMIC_SPEAKER_MONITOR when that variable fixes it', () => {
    const on = speakerMonitorOverrideKey({ enabled: true, envOverride: true, origin: 'env' });
    const off = speakerMonitorOverrideKey({ enabled: false, envOverride: false, origin: 'env' });
    expect(on).toBe('settings.speaker_monitor_env_on');
    expect(off).toBe('settings.speaker_monitor_env_off');
    expect(strings[on!]).toContain('THAUMIC_SPEAKER_MONITOR');
    expect(strings[off!]).toContain('THAUMIC_SPEAKER_MONITOR');
  });

  it('should name THAUMIC_SPEAKER_DIAGNOSTICS when the legacy variable turns it on', () => {
    const key = speakerMonitorOverrideKey({
      enabled: true,
      envOverride: true,
      origin: 'legacyEnv',
    });
    expect(key).toBe('settings.speaker_monitor_legacy_env');
    expect(strings[key!]).toContain('THAUMIC_SPEAKER_DIAGNOSTICS');
    expect(strings[key!]).not.toContain('THAUMIC_SPEAKER_MONITOR');
  });
});
