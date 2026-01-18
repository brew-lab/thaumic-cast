import { z } from 'zod';
import {
  AudioCodecSchema,
  BitrateSchema,
  SampleRateSchema,
  LatencyModeSchema,
  BitDepthSchema,
  DEFAULT_BITS_PER_SAMPLE,
  STREAMING_BUFFER_MS_MIN,
  STREAMING_BUFFER_MS_MAX,
  STREAMING_BUFFER_MS_DEFAULT,
  FRAME_DURATION_MS_DEFAULT,
  FrameDurationMsSchema,
  isValidBitrateForCodec,
  getDefaultBitrate,
} from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';

const log = createLogger('Settings');

// ─────────────────────────────────────────────────────────────────────────────
// Storage Migration Utilities
// ─────────────────────────────────────────────────────────────────────────────

/** Key used to track whether sync-to-local migration has been performed. */
const MIGRATION_COMPLETE_KEY = 'syncToLocalMigrationComplete';

/**
 * Migrates a value from chrome.storage.sync to chrome.storage.local.
 * Validates the legacy data against the provided schema before migration.
 * Cleans up the legacy sync data after successful migration.
 *
 * @param key - The storage key to migrate
 * @param schema - Zod schema to validate the legacy data
 * @param label - Human-readable label for logging
 * @returns The migrated data if successful, null otherwise
 */
async function migrateFromSyncStorage<T>(
  key: string,
  schema: z.ZodType<T>,
  label: string,
): Promise<T | null> {
  try {
    const legacy = await chrome.storage.sync.get(key);
    const legacyData = legacy[key];

    if (!legacyData) return null;

    const parsed = schema.safeParse(legacyData);
    if (!parsed.success) {
      log.warn(`Invalid legacy synced ${label}, skipping migration`);
      return null;
    }

    // Migrate to local storage and clean up sync storage
    await chrome.storage.local.set({ [key]: parsed.data });
    await chrome.storage.sync.remove(key);
    log.info(`Migrated ${label} from sync to local storage`);

    return parsed.data;
  } catch (err) {
    log.error(`Failed to migrate ${label} from sync storage:`, err);
    return null;
  }
}

/**
 * Checks if the sync-to-local migration has already been completed.
 * @returns True if migration is complete
 */
async function isMigrationComplete(): Promise<boolean> {
  const result = await chrome.storage.local.get(MIGRATION_COMPLETE_KEY);
  return result[MIGRATION_COMPLETE_KEY] === true;
}

/**
 * Marks the sync-to-local migration as complete.
 */
async function markMigrationComplete(): Promise<void> {
  await chrome.storage.local.set({ [MIGRATION_COMPLETE_KEY]: true });
}

/**
 * Performs one-time migration of all settings from sync to local storage.
 * Safe to call multiple times - will only migrate once.
 */
async function ensureMigrationComplete(): Promise<void> {
  if (await isMigrationComplete()) return;

  // Migrate both settings and onboarding state
  await migrateFromSyncStorage(
    EXTENSION_SETTINGS_KEY,
    ExtensionSettingsSchema,
    'extension settings',
  );
  await migrateFromSyncStorage(
    ONBOARDING_STORAGE_KEY,
    ExtensionOnboardingSchema,
    'onboarding state',
  );

  await markMigrationComplete();
}

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
  latencyMode: LatencyModeSchema.default('quality'),
  /** Bit depth (16 or 24). Supported depths depend on the codec. */
  bitsPerSample: BitDepthSchema.default(DEFAULT_BITS_PER_SAMPLE),
  /** Buffer size for PCM streaming in milliseconds. */
  streamingBufferMs: z
    .number()
    .min(STREAMING_BUFFER_MS_MIN)
    .max(STREAMING_BUFFER_MS_MAX)
    .default(STREAMING_BUFFER_MS_DEFAULT),
  /** Frame duration in milliseconds. Currently only used when codec is 'pcm'. */
  frameDurationMs: FrameDurationMsSchema.default(FRAME_DURATION_MS_DEFAULT),
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

  // Audio mode (default to high for lossless - lower CPU, just needs bandwidth)
  audioMode: AudioModeSchema.default('high'),

  // Custom audio settings (used when audioMode is 'custom')
  // Default to PCM as it's always available (no WebCodecs dependency)
  customAudioSettings: CustomAudioSettingsSchema.default({
    codec: 'pcm',
    bitrate: 0,
    channels: 2,
    sampleRate: 48000,
    latencyMode: 'quality',
    bitsPerSample: DEFAULT_BITS_PER_SAMPLE,
    streamingBufferMs: STREAMING_BUFFER_MS_DEFAULT,
    frameDurationMs: FRAME_DURATION_MS_DEFAULT,
  }),

  // Video sync: controls visibility of video sync controls in popup (default: false)
  videoSyncEnabled: z.boolean().default(false),

  // Keep tab audible: plays audio at very low volume to prevent Chrome throttling
  // When enabled, Chrome sees the tab as "playing audio" and won't throttle it
  keepTabAudible: z.boolean().default(false),
});
export type ExtensionSettings = z.infer<typeof ExtensionSettingsSchema>;

const EXTENSION_SETTINGS_KEY = 'extensionSettings';

const DEFAULT_EXTENSION_SETTINGS: ExtensionSettings = {
  serverUrl: null,
  useAutoDiscover: true,
  theme: 'auto',
  language: 'en',
  audioMode: 'high',
  customAudioSettings: {
    codec: 'pcm',
    bitrate: 0,
    channels: 2,
    sampleRate: 48000,
    latencyMode: 'quality',
    bitsPerSample: DEFAULT_BITS_PER_SAMPLE,
    streamingBufferMs: STREAMING_BUFFER_MS_DEFAULT,
    frameDurationMs: FRAME_DURATION_MS_DEFAULT,
  },
  videoSyncEnabled: false,
  keepTabAudible: false,
};

/**
 * Loads extension settings from chrome.storage.local.
 * Performs one-time migration from sync storage if needed.
 * Falls back to defaults if not set or invalid.
 * @returns The extension settings
 */
export async function loadExtensionSettings(): Promise<ExtensionSettings> {
  try {
    // Ensure migration from sync storage has been performed
    await ensureMigrationComplete();

    const result = await chrome.storage.local.get(EXTENSION_SETTINGS_KEY);
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
 * Saves extension settings to chrome.storage.local.
 * Merges partial settings with current, validates through Zod, and returns the result.
 * @param settings - The settings to save (can be partial)
 * @returns The fully merged and validated settings (with Zod defaults applied)
 */
export async function saveExtensionSettings(
  settings: Partial<ExtensionSettings>,
): Promise<ExtensionSettings> {
  try {
    const current = await loadExtensionSettings();

    // Deep merge customAudioSettings to preserve all fields
    const merged = {
      ...current,
      ...settings,
      customAudioSettings: settings.customAudioSettings
        ? { ...current.customAudioSettings, ...settings.customAudioSettings }
        : current.customAudioSettings,
    };

    // Normalize bitrate if it's invalid for the selected codec.
    const { codec, bitrate } = merged.customAudioSettings;
    if (!isValidBitrateForCodec(codec, bitrate)) {
      merged.customAudioSettings = {
        ...merged.customAudioSettings,
        bitrate: getDefaultBitrate(codec),
      };
    }

    // Validate and apply Zod defaults
    const parsed = ExtensionSettingsSchema.parse(merged);
    await chrome.storage.local.set({ [EXTENSION_SETTINGS_KEY]: parsed });
    return parsed;
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
 * Loads onboarding state from chrome.storage.local.
 * Performs one-time migration from sync storage if needed.
 * Falls back to defaults if not set or invalid.
 * @returns The onboarding state
 */
export async function loadOnboardingState(): Promise<ExtensionOnboarding> {
  try {
    // Ensure migration from sync storage has been performed
    await ensureMigrationComplete();

    const result = await chrome.storage.local.get(ONBOARDING_STORAGE_KEY);
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
 * Saves onboarding state to chrome.storage.local.
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
    await chrome.storage.local.set({ [ONBOARDING_STORAGE_KEY]: merged });
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

// ─────────────────────────────────────────────────────────────────────────────
// Speaker Selection State (device-specific, uses chrome.storage.local)
// ─────────────────────────────────────────────────────────────────────────────

const SPEAKER_SELECTION_KEY = 'speakerSelection';

/**
 * Speaker selection state stored in chrome.storage.local.
 * Uses local storage because speakers are on the local network
 * and shouldn't sync across devices.
 */
export const SpeakerSelectionStateSchema = z.object({
  /** Array of selected speaker coordinator IPs */
  selectedIps: z.array(z.string()),
});
export type SpeakerSelectionState = z.infer<typeof SpeakerSelectionStateSchema>;

/**
 * Loads speaker selection from chrome.storage.local.
 * @returns The saved speaker IPs, or empty array if not set
 */
export async function loadSpeakerSelection(): Promise<string[]> {
  try {
    const result = await chrome.storage.local.get(SPEAKER_SELECTION_KEY);
    const parsed = SpeakerSelectionStateSchema.safeParse(result[SPEAKER_SELECTION_KEY]);
    return parsed.success ? parsed.data.selectedIps : [];
  } catch (err) {
    log.error('Failed to load speaker selection:', err);
    return [];
  }
}

/**
 * Saves speaker selection to chrome.storage.local.
 * @param selectedIps - Array of selected speaker coordinator IPs
 */
export async function saveSpeakerSelection(selectedIps: string[]): Promise<void> {
  try {
    const state: SpeakerSelectionState = { selectedIps };
    await chrome.storage.local.set({ [SPEAKER_SELECTION_KEY]: state });
  } catch (err) {
    log.error('Failed to save speaker selection:', err);
  }
}
