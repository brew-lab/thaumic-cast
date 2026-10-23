import { beforeEach, describe, expect, it } from 'bun:test';

import { chromeStorageData, resetChromeStub } from '../test-support/chrome-stub';
import {
  getDefaultExtensionSettings,
  saveExtensionSettings,
  type ExtensionSettings,
} from './settings';
import { isAtDefaults, KEPT_ON_RESET, resetValues } from './settings-reset';

const SETTINGS_KEY = 'extensionSettings';
const MIGRATION_KEY = 'syncToLocalMigrationComplete';

/** Every setting changed from its default, with a hand-given companion and the bookkeeping set. */
const changed: ExtensionSettings = {
  ...getDefaultExtensionSettings(),
  serverUrl: 'http://192.168.2.169:49400',
  useAutoDiscover: false,
  theme: 'dark',
  audioMode: 'custom',
  customAudioSettings: {
    codec: 'aac-lc',
    bitrate: 192,
    channels: 1,
    sampleRate: 44100,
    latencyMode: 'realtime',
    bitsPerSample: 16,
  },
  pcmFrameDurationMs: 20,
  smoothingMigrationNotice: { from: 500, to: 300 },
  videoSyncEnabled: true,
  keepTabAudible: false,
  startCeilingEnabled: false,
  startCeiling: 55,
  captureMode: 'browser',
};

beforeEach(() => {
  resetChromeStub();
  chromeStorageData.local[MIGRATION_KEY] = true;
});

describe('resetValues', () => {
  it('should leave out the connection and the bookkeeping', () => {
    const values = resetValues();
    for (const key of KEPT_ON_RESET) expect(key in values).toBe(false);
    expect(KEPT_ON_RESET).toContain('serverUrl');
    expect(KEPT_ON_RESET).toContain('useAutoDiscover');
  });

  it('should hold every other setting at its default', () => {
    const defaults = getDefaultExtensionSettings();
    const values = resetValues();
    const expected = Object.keys(defaults).filter(
      (key) => !(KEPT_ON_RESET as readonly string[]).includes(key),
    );
    expect(Object.keys(values).sort()).toEqual(expected.sort());
    for (const key of expected) {
      const value: unknown = values[key as keyof typeof values];
      expect(value).toEqual(defaults[key as keyof ExtensionSettings]);
    }
  });

  it('should not share the defaults object, so a change to one does not reach the other', () => {
    resetValues().customAudioSettings.channels = 1;
    expect(getDefaultExtensionSettings().customAudioSettings.channels).toBe(2);
  });
});

describe('isAtDefaults', () => {
  it('should be true for the defaults', () => {
    expect(isAtDefaults(getDefaultExtensionSettings())).toBe(true);
  });

  it('should ignore the connection and the bookkeeping', () => {
    expect(
      isAtDefaults({
        ...getDefaultExtensionSettings(),
        serverUrl: 'http://192.168.2.169:49400',
        useAutoDiscover: false,
        smoothingMigrationNotice: { from: 500, to: 300 },
      }),
    ).toBe(true);
  });

  it('should be false when one setting differs, a nested one too', () => {
    expect(isAtDefaults({ ...getDefaultExtensionSettings(), theme: 'light' })).toBe(false);
    const defaults = getDefaultExtensionSettings();
    expect(
      isAtDefaults({
        ...defaults,
        customAudioSettings: { ...defaults.customAudioSettings, sampleRate: 44100 },
      }),
    ).toBe(false);
  });
});

describe('a reset saved through saveExtensionSettings', () => {
  it('should put every setting back and keep the connection and the bookkeeping', async () => {
    chromeStorageData.local[SETTINGS_KEY] = changed;

    const saved = await saveExtensionSettings(resetValues());

    expect(isAtDefaults(saved)).toBe(true);
    expect(saved.serverUrl).toBe('http://192.168.2.169:49400');
    expect(saved.useAutoDiscover).toBe(false);
    expect(saved.smoothingMigrationNotice).toEqual({ from: 500, to: 300 });
    expect(chromeStorageData.local[SETTINGS_KEY]).toEqual(saved);
  });

  it('should leave the other stored state (saved sets, dismissed notices) alone', async () => {
    chromeStorageData.local[SETTINGS_KEY] = changed;
    chromeStorageData.local.roomSets = [{ id: 'a', name: 'Downstairs', rooms: [] }];
    chromeStorageData.local.dismissedNoReply = true;

    await saveExtensionSettings(resetValues());

    expect(chromeStorageData.local.roomSets).toEqual([{ id: 'a', name: 'Downstairs', rooms: [] }]);
    expect(chromeStorageData.local.dismissedNoReply).toBe(true);
  });
});
