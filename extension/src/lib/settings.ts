import type { SonosMode } from '@thaumic-cast/shared';

// Centralized defaults for extension configuration
const DEFAULT_SERVER_URL = 'http://localhost:3000';
const DEFAULT_SONOS_MODE: SonosMode = 'cloud';

export interface ExtensionSettings {
  serverUrl: string;
  sonosMode: SonosMode;
  speakerIp: string;
}

// Normalize and return all persisted settings with defaults
export async function getExtensionSettings(): Promise<ExtensionSettings> {
  const result = (await chrome.storage.sync.get([
    'serverUrl',
    'sonosMode',
    'speakerIp',
  ])) as Partial<ExtensionSettings>;

  return {
    serverUrl: normalizeServerUrl(result.serverUrl) || DEFAULT_SERVER_URL,
    sonosMode: (result.sonosMode as SonosMode) || DEFAULT_SONOS_MODE,
    speakerIp: result.speakerIp || '',
  };
}

export async function saveExtensionSettings(partial: Partial<ExtensionSettings>): Promise<void> {
  const current = await getExtensionSettings();
  const next: ExtensionSettings = {
    ...current,
    ...partial,
    serverUrl: normalizeServerUrl(partial.serverUrl) || current.serverUrl,
    speakerIp: partial.speakerIp?.trim() ?? current.speakerIp,
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
