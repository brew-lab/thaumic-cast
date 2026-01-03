import { z } from 'zod';
import {
  AudioCodecSchema,
  BitrateSchema,
  SampleRateSchema,
  isValidBitrateForCodec,
  getDefaultBitrate,
} from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';

const log = createLogger('Settings');

// ─────────────────────────────────────────────────────────────────────────────
// Audio Settings (legacy, per-stream - kept for backward compat)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * User settings schema for audio configuration.
 */
export const AudioSettingsSchema = z.object({
  auto: z.boolean().default(true),
  codec: AudioCodecSchema,
  bitrate: BitrateSchema,
});
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;

const STORAGE_KEY = 'audioSettings';

const DEFAULT_SETTINGS: AudioSettings = {
  auto: true,
  codec: 'aac-lc',
  bitrate: 192,
};

// ─────────────────────────────────────────────────────────────────────────────
// Extension Settings (global settings for the extension)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Audio quality mode presets.
 * - auto: Device tier + power state detection
 * - low: Optimized for low bandwidth/battery
 * - mid: Balanced quality
 * - high: Maximum quality (lossless when available)
 * - custom: User-defined settings
 */
export const AudioModeSchema = z.enum(['auto', 'low', 'mid', 'high', 'custom']);
export type AudioMode = z.infer<typeof AudioModeSchema>;

/**
 * Supported languages for the extension UI.
 * Uses the locales defined in i18n.ts.
 */
export { type SupportedLocale, SUPPORTED_LOCALES } from './i18n';
import { SUPPORTED_LOCALES } from './i18n';
const SupportedLocaleSchema = z.enum(SUPPORTED_LOCALES as [string, ...string[]]);

/**
 * Theme mode for the extension UI.
 * - auto: Follow system preference (prefers-color-scheme)
 * - light: Force light mode
 * - dark: Force dark mode
 */
export const ThemeModeSchema = z.enum(['auto', 'light', 'dark']);
export type ThemeMode = z.infer<typeof ThemeModeSchema>;

/**
 * Custom audio settings when mode is 'custom'.
 */
export const CustomAudioSettingsSchema = z.object({
  codec: AudioCodecSchema,
  bitrate: BitrateSchema,
  channels: z.union([z.literal(1), z.literal(2)]).default(2),
  sampleRate: SampleRateSchema.default(48000),
});
export type CustomAudioSettings = z.infer<typeof CustomAudioSettingsSchema>;

/**
 * Global extension settings schema.
 */
export const ExtensionSettingsSchema = z.object({
  // Server configuration
  serverUrl: z.string().nullable().default(null),
  useAutoDiscover: z.boolean().default(true),

  // Appearance
  theme: ThemeModeSchema.default('auto'),

  // Language
  language: SupportedLocaleSchema.default('en'),

  // Audio mode
  audioMode: AudioModeSchema.default('auto'),

  // Custom audio settings (used when audioMode is 'custom')
  customAudioSettings: CustomAudioSettingsSchema.default({
    codec: 'aac-lc',
    bitrate: 192,
    channels: 2,
    sampleRate: 48000,
  }),
});
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;

const EXTENSION_SETTINGS_KEY = 'extensionSettings';

const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  serverUrl: null,
  useAutoDiscover: true,
  theme: 'auto',
  language: 'en',
  audioMode: 'auto',
  customAudioSettings: {
    codec: 'aac-lc',
    bitrate: 192,
    channels: 2,
    sampleRate: 48000,
  },
};

/**
 * Loads audio settings from chrome.storage.sync.
 * Falls back to defaults if not set or invalid.
 * @returns The audio settings
 */
export async function loadAudioSettings(): Promise<AudioSettings> {
  try {
    const result = await chrome.storage.sync.get(STORAGE_KEY);
    const data = result[STORAGE_KEY];

    if (!data) return DEFAULT_SETTINGS;

    const parsed = AudioSettingsSchema.safeParse(data);
    if (!parsed.success) {
      log.warn('Invalid stored settings, using defaults');
      return DEFAULT_SETTINGS;
    }

    const { codec, bitrate } = parsed.data;
    if (!isValidBitrateForCodec(codec, bitrate)) {
      return { ...parsed.data, bitrate: getDefaultBitrate(codec) };
    }

    return parsed.data;
  } catch (err) {
    log.error('Failed to load settings:', err);
    return DEFAULT_SETTINGS;
  }
}

/**
 * Saves audio settings to chrome.storage.sync.
 * @param settings - The settings to save
 */
export async function saveAudioSettings(settings: AudioSettings): Promise<void> {
  const parsed = AudioSettingsSchema.parse(settings);

  if (!isValidBitrateForCodec(parsed.codec, parsed.bitrate)) {
    parsed.bitrate = getDefaultBitrate(parsed.codec);
  }

  await chrome.storage.sync.set({ [STORAGE_KEY]: parsed });
}

/**
 * Returns the default audio settings.
 * @returns Default settings
 */
export function getDefaultSettings(): AudioSettings {
  return { ...DEFAULT_SETTINGS };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension Settings Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Loads extension settings from chrome.storage.sync.
 * Falls back to defaults if not set or invalid.
 * @returns The extension settings
 */
export async function loadExtensionSettings(): Promise<ExtensionSettings> {
  try {
    const result = await chrome.storage.sync.get(EXTENSION_SETTINGS_KEY);
    const data = result[EXTENSION_SETTINGS_KEY];

    if (!data) return { ...DEFAULT_EXTENSION_SETTINGS };

    const parsed = ExtensionSettingsSchema.safeParse(data);
    if (!parsed.success) {
      log.warn('Invalid stored extension settings, using defaults');
      return { ...DEFAULT_EXTENSION_SETTINGS };
    }

    return parsed.data;
  } catch (err) {
    log.error('Failed to load extension settings:', err);
    return { ...DEFAULT_EXTENSION_SETTINGS };
  }
}

/**
 * Saves extension settings to chrome.storage.sync.
 * @param settings - The settings to save (can be partial)
 */
export async function saveExtensionSettings(settings: Partial<ExtensionSettings>): Promise<void> {
  try {
    const current = await loadExtensionSettings();
    const merged = { ...current, ...settings };

    // Validate custom audio settings if provided
    if (settings.customAudioSettings) {
      const { codec, bitrate } = settings.customAudioSettings;
      if (!isValidBitrateForCodec(codec, bitrate)) {
        merged.customAudioSettings = {
          ...settings.customAudioSettings,
          bitrate: getDefaultBitrate(codec),
        };
      }
    }

    const parsed = ExtensionSettingsSchema.parse(merged);
    await chrome.storage.sync.set({ [EXTENSION_SETTINGS_KEY]: parsed });
  } catch (err) {
    log.error('Failed to save extension settings:', err);
    throw err;
  }
}

/**
 * Returns the default extension settings.
 * @returns Default extension settings
 */
export function getDefaultExtensionSettings(): ExtensionSettings {
  return { ...DEFAULT_EXTENSION_SETTINGS };
}
