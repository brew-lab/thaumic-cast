import { z } from 'zod';
import {
  AudioCodecSchema,
  BitrateSchema,
  isValidBitrateForCodec,
  getDefaultBitrate,
} from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';

const log = createLogger('Settings');

/**
 * User settings schema for audio configuration.
 */
export const AudioSettingsSchema = z.object({
  codec: AudioCodecSchema,
  bitrate: BitrateSchema,
});
export type AudioSettings = z.infer<typeof AudioSettingsSchema>;

const STORAGE_KEY = 'audioSettings';

const DEFAULT_SETTINGS: AudioSettings = {
  codec: 'aac-lc',
  bitrate: 192,
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
      return { codec, bitrate: getDefaultBitrate(codec) };
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
