import type { SonosMode } from '@thaumic-cast/shared';
import type { SupportedLocale } from './i18n';

// Centralized defaults for extension configuration
export const DEFAULT_SERVER_URL = 'http://localhost:3000';
const DEFAULT_SONOS_MODE: SonosMode = 'cloud';
const DEFAULT_LANGUAGE: SupportedLocale = 'en';

export interface ExtensionSettings {
  serverUrl: string;
  sonosMode: SonosMode;
  speakerIp: string;
  language: SupportedLocale;
}

// Normalize and return all persisted settings with defaults
export async function getExtensionSettings(): Promise<ExtensionSettings> {
  const result = (await chrome.storage.sync.get([
    'serverUrl',
    'sonosMode',
    'speakerIp',
    'language',
  ])) as Partial<ExtensionSettings>;

  return {
    serverUrl: normalizeServerUrl(result.serverUrl) || DEFAULT_SERVER_URL,
    sonosMode: (result.sonosMode as SonosMode) || DEFAULT_SONOS_MODE,
    speakerIp: result.speakerIp || '',
    language: (result.language as SupportedLocale) || DEFAULT_LANGUAGE,
  };
}

export async function saveExtensionSettings(partial: Partial<ExtensionSettings>): Promise<void> {
  const current = await getExtensionSettings();
  const next: ExtensionSettings = {
    ...current,
    ...partial,
    serverUrl: normalizeServerUrl(partial.serverUrl) || current.serverUrl,
    speakerIp: partial.speakerIp?.trim() ?? current.speakerIp,
    language: (partial.language as SupportedLocale) || current.language,
  };

  await chrome.storage.sync.set(next);
}

export async function getServerUrl(): Promise<string> {
  const settings = await getExtensionSettings();
  return settings.serverUrl;
}

function normalizeServerUrl(url?: string): string | undefined {
  if (!url) return undefined;
  // Trim whitespace and trailing slashes
  const trimmed = url.trim().replace(/\/+$/, '');
  return trimmed;
}

/**
 * Detect if the desktop app is running at the default server URL
 * Returns true if the health endpoint responds successfully
 */
export async function detectDesktopApp(): Promise<boolean> {
  try {
    const response = await fetch(`${DEFAULT_SERVER_URL}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(1000),
    });
    return response.ok;
  } catch {
    return false;
  }
}
