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
 * - low: Optimized for low bandwidth (mono, lower sample rate)
 * - mid: Balanced quality
 * - high: Maximum quality (highest bitrate available)
 * - custom: User-defined settings
 */
export const AudioModeSchema = z.enum(['low', 'mid', 'high', 'custom']);
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
  audioMode: AudioModeSchema.default('mid'),

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
  audioMode: 'mid',
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

// ─────────────────────────────────────────────────────────────────────────────
// Onboarding State
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Onboarding steps completion tracking.
 */
export const OnboardingStepsSchema = z.object({
  welcome: z.boolean().default(false),
  desktopConnection: z.boolean().default(false),
  speakerDiscovery: z.boolean().default(false),
  ready: z.boolean().default(false),
});
export type OnboardingSteps = z.infer<typeof OnboardingStepsSchema>;

/**
 * Extension onboarding state schema.
 */
export const ExtensionOnboardingSchema = z.object({
  /** Whether onboarding has been completed (or skipped) */
  completed: z.boolean().default(false),
  /** When onboarding was completed (ISO string) */
  completedAt: z.string().nullable().default(null),
  /** Whether user explicitly skipped onboarding */
  skipped: z.boolean().default(false),
  /** Individual step completion tracking for resumption */
  stepsCompleted: OnboardingStepsSchema.default({
    welcome: false,
    desktopConnection: false,
    speakerDiscovery: false,
    ready: false,
  }),
  /** The app version when onboarding was completed */
  completedVersion: z.string().nullable().default(null),
});
export type ExtensionOnboarding = z.infer<typeof ExtensionOnboardingSchema>;

const ONBOARDING_STORAGE_KEY = 'extensionOnboarding';

const DEFAULT_ONBOARDING: ExtensionOnboarding = {
  completed: false,
  completedAt: null,
  skipped: false,
  stepsCompleted: {
    welcome: false,
    desktopConnection: false,
    speakerDiscovery: false,
    ready: false,
  },
  completedVersion: null,
};

/**
 * Loads onboarding state from chrome.storage.sync.
 * Falls back to defaults if not set or invalid.
 * @returns The onboarding state
 */
export async function loadOnboardingState(): Promise<ExtensionOnboarding> {
  try {
    const result = await chrome.storage.sync.get(ONBOARDING_STORAGE_KEY);
    const data = result[ONBOARDING_STORAGE_KEY];

    if (!data) return { ...DEFAULT_ONBOARDING };

    const parsed = ExtensionOnboardingSchema.safeParse(data);
    if (!parsed.success) {
      log.warn('Invalid stored onboarding state, using defaults');
      return { ...DEFAULT_ONBOARDING };
    }

    return parsed.data;
  } catch (err) {
    log.error('Failed to load onboarding state:', err);
    return { ...DEFAULT_ONBOARDING };
  }
}

/**
 * Saves onboarding state to chrome.storage.sync.
 * @param state - Partial state to merge with existing
 */
export async function saveOnboardingState(state: Partial<ExtensionOnboarding>): Promise<void> {
  try {
    const current = await loadOnboardingState();
    const merged = {
      ...current,
      ...state,
      stepsCompleted: {
        ...current.stepsCompleted,
        ...state.stepsCompleted,
      },
    };
    await chrome.storage.sync.set({ [ONBOARDING_STORAGE_KEY]: merged });
  } catch (err) {
    log.error('Failed to save onboarding state:', err);
  }
}

/**
 * Marks onboarding as completed.
 * @param version - Optional app version at completion
 */
export async function completeOnboarding(version?: string): Promise<void> {
  await saveOnboardingState({
    completed: true,
    completedAt: new Date().toISOString(),
    completedVersion: version ?? null,
  });
}

/**
 * Marks onboarding as skipped.
 */
export async function skipOnboarding(): Promise<void> {
  await saveOnboardingState({
    completed: true,
    skipped: true,
    completedAt: new Date().toISOString(),
  });
}
