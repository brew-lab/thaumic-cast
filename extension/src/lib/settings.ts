import type { SonosMode } from '@thaumic-cast/shared';
import type { SupportedLocale } from './i18n';

// Centralized defaults for extension configuration
export const DEFAULT_SERVER_URL = 'http://localhost:3000';
const DEFAULT_SONOS_MODE: SonosMode = 'cloud';
const DEFAULT_LANGUAGE: SupportedLocale = 'en';

export type BackendType = 'desktop' | 'server' | 'unknown';

export interface ExtensionSettings {
  serverUrl: string;
  sonosMode: SonosMode;
  speakerIp: string;
  language: SupportedLocale;
  backendType: BackendType;
}

// Normalize and return all persisted settings with defaults
export async function getExtensionSettings(): Promise<ExtensionSettings> {
  const result = (await chrome.storage.sync.get([
    'serverUrl',
    'sonosMode',
    'speakerIp',
    'language',
    'backendType',
  ])) as Partial<ExtensionSettings>;

  return {
    serverUrl: normalizeServerUrl(result.serverUrl) || DEFAULT_SERVER_URL,
    sonosMode: (result.sonosMode as SonosMode) || DEFAULT_SONOS_MODE,
    speakerIp: result.speakerIp || '',
    language: (result.language as SupportedLocale) || DEFAULT_LANGUAGE,
    backendType: (result.backendType as BackendType) || 'unknown',
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
    backendType: partial.backendType ?? current.backendType,
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

// ============ Backend Type Detection ============

/**
 * Detect the backend type by checking the service field in the health response.
 * - 'desktop': thaumic-cast-desktop (no auth required for local mode)
 * - 'server': thaumic-cast-server (auth required for local mode)
 * - 'unknown': could not determine (treat as requiring auth)
 */
export async function detectBackendType(): Promise<BackendType> {
  try {
    const serverUrl = await getServerUrl();
    const response = await fetch(`${serverUrl}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return 'unknown';

    const data = (await response.json()) as { service?: string };
    if (data.service === 'thaumic-cast-desktop') return 'desktop';
    if (data.service === 'thaumic-cast-server') return 'server';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

// ============ Speaker Groups Cache ============

export interface CachedGroup {
  id: string;
  name: string;
  coordinatorIp?: string;
}

export interface CachedSpeakerGroups {
  groups: CachedGroup[];
  cachedAt: number;
}

/**
 * Get cached speaker groups from local storage
 */
export async function getCachedGroups(): Promise<CachedSpeakerGroups | null> {
  const result = await chrome.storage.local.get(['cachedGroups']);
  return (result.cachedGroups as CachedSpeakerGroups) || null;
}

/**
 * Save speaker groups to local storage cache
 */
export async function setCachedGroups(groups: CachedGroup[]): Promise<void> {
  await chrome.storage.local.set({
    cachedGroups: {
      groups,
      cachedAt: Date.now(),
    } satisfies CachedSpeakerGroups,
  });
}

/**
 * Clear cached speaker groups
 */
export async function clearCachedGroups(): Promise<void> {
  await chrome.storage.local.remove(['cachedGroups']);
}
