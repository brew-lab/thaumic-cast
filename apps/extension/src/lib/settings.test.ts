import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { chromeStorageData, resetChromeStub } from '../test-support/chrome-stub';
import {
  getDefaultExtensionSettings,
  loadExtensionSettings,
  saveExtensionSettings,
  type ExtensionSettings,
} from './settings';

const SETTINGS_KEY = 'extensionSettings';
const MIGRATION_KEY = 'syncToLocalMigrationComplete';

const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/130.0';

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setUserAgent(userAgent: string): void {
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent },
    configurable: true,
    writable: true,
  });
}

/** Seeds local storage as if a previous session stored `settings`, skipping the sync migration. */
function storeSettings(settings: unknown): void {
  chromeStorageData.local[MIGRATION_KEY] = true;
  chromeStorageData.local[SETTINGS_KEY] = settings;
}

function customAudio(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...getDefaultExtensionSettings().customAudioSettings, ...overrides };
}

let warn: ReturnType<typeof spyOn>;

beforeEach(() => {
  resetChromeStub();
  setUserAgent(MAC_UA);
  // The loader reports every discarded field; keep the test output readable.
  warn = spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
  if (originalNavigator) Object.defineProperty(globalThis, 'navigator', originalNavigator);
});

describe('loadExtensionSettings', () => {
  it('should return the defaults when nothing is stored', async () => {
    chromeStorageData.local[MIGRATION_KEY] = true;

    expect(await loadExtensionSettings()).toEqual(getDefaultExtensionSettings());
  });

  it('should replace one invalid field with its default and keep the rest', async () => {
    storeSettings({ theme: 'neon', language: 'en', audioMode: 'low', keepTabAudible: false });

    const settings = await loadExtensionSettings();

    expect(settings.theme).toBe('auto');
    expect(settings.audioMode).toBe('low');
    expect(settings.keepTabAudible).toBe(false);
  });

  it('should always produce the full settings shape', async () => {
    storeSettings({ audioMode: 'mid', legacyFlag: true });

    const settings = await loadExtensionSettings();

    expect(Object.keys(settings).sort()).toEqual(Object.keys(getDefaultExtensionSettings()).sort());
    expect('legacyFlag' in settings).toBe(false);
  });

  it('should validate custom audio settings field by field', async () => {
    storeSettings({ customAudioSettings: customAudio({ channels: 1, sampleRate: 12345 }) });

    const { customAudioSettings } = await loadExtensionSettings();

    expect(customAudioSettings.channels).toBe(1);
    expect(customAudioSettings.sampleRate).toBe(48000);
  });

  it('should fall back to the default codec and re-apply the bitrate invariant', async () => {
    storeSettings({ customAudioSettings: customAudio({ codec: 'opus', bitrate: 192 }) });

    const { customAudioSettings } = await loadExtensionSettings();

    expect(customAudioSettings.codec).toBe('pcm');
    expect(customAudioSettings.bitrate).toBe(0);
  });

  it('should repair a bitrate the stored codec does not support', async () => {
    storeSettings({ customAudioSettings: customAudio({ codec: 'aac-lc', bitrate: 999 }) });

    const { customAudioSettings } = await loadExtensionSettings();

    expect(customAudioSettings.codec).toBe('aac-lc');
    expect(customAudioSettings.bitrate).toBe(192);
  });

  it('should repair a bit depth the stored codec does not support', async () => {
    storeSettings({
      customAudioSettings: customAudio({ codec: 'aac-lc', bitrate: 192, bitsPerSample: 24 }),
    });

    expect((await loadExtensionSettings()).customAudioSettings.bitsPerSample).toBe(16);
  });

  it('should keep 24-bit when the stored codec supports it', async () => {
    storeSettings({
      customAudioSettings: customAudio({ codec: 'flac', bitrate: 0, bitsPerSample: 24 }),
    });

    expect((await loadExtensionSettings()).customAudioSettings.bitsPerSample).toBe(24);
  });

  it('should replace custom audio settings wholesale when they are not an object', async () => {
    storeSettings({ customAudioSettings: 'high' });

    expect((await loadExtensionSettings()).customAudioSettings).toEqual(
      getDefaultExtensionSettings().customAudioSettings,
    );
  });

  it('should keep browser capture on Windows', async () => {
    setUserAgent(WINDOWS_UA);
    storeSettings({ captureMode: 'browser' });

    expect((await loadExtensionSettings()).captureMode).toBe('browser');
  });

  it('should force browser capture back to tab capture off Windows', async () => {
    setUserAgent(MAC_UA);
    storeSettings({ captureMode: 'browser' });

    expect((await loadExtensionSettings()).captureMode).toBe('tab');
  });

  it('should fall back to the defaults when the stored value is not an object', async () => {
    storeSettings('corrupted');

    expect(await loadExtensionSettings()).toEqual(getDefaultExtensionSettings());
  });

  it('should migrate legacy synced settings into local storage once', async () => {
    chromeStorageData.sync[SETTINGS_KEY] = { audioMode: 'custom', theme: 'bogus' };

    const settings = await loadExtensionSettings();

    expect(settings.audioMode).toBe('custom');
    expect(settings.theme).toBe('auto');
    expect(chromeStorageData.local[MIGRATION_KEY]).toBe(true);
    expect(chromeStorageData.sync[SETTINGS_KEY]).toBeUndefined();
    expect(chromeStorageData.local[SETTINGS_KEY]).toMatchObject({ audioMode: 'custom' });
  });
});

describe('saveExtensionSettings', () => {
  it('should merge a partial update over the stored settings', async () => {
    storeSettings({ audioMode: 'low', keepTabAudible: false });

    const saved = await saveExtensionSettings({ theme: 'dark' });

    expect(saved).toMatchObject({ theme: 'dark', audioMode: 'low', keepTabAudible: false });
    expect(chromeStorageData.local[SETTINGS_KEY]).toEqual(saved);
  });

  it('should merge nested custom audio settings instead of replacing them', async () => {
    storeSettings({
      customAudioSettings: customAudio({ codec: 'aac-lc', bitrate: 256, channels: 1 }),
    });

    const saved = await saveExtensionSettings({
      customAudioSettings: { latencyMode: 'realtime' } as ExtensionSettings['customAudioSettings'],
    });

    expect(saved.customAudioSettings).toMatchObject({
      codec: 'aac-lc',
      bitrate: 256,
      channels: 1,
      latencyMode: 'realtime',
    });
  });

  it('should normalise the bitrate when the codec changes underneath it', async () => {
    storeSettings({ customAudioSettings: customAudio({ codec: 'vorbis', bitrate: 320 }) });

    const saved = await saveExtensionSettings({
      customAudioSettings: { codec: 'he-aac-v2' } as ExtensionSettings['customAudioSettings'],
    });

    expect(saved.customAudioSettings.bitrate).toBe(64);
  });
});
