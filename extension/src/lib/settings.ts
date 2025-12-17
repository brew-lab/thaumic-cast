import type { SonosMode, QualityPreset } from '@thaumic-cast/shared';
import { DESKTOP_PORT_RANGE } from '@thaumic-cast/shared';
import type { SupportedLocale } from './i18n';

// Centralized defaults for extension configuration
export const DEFAULT_SERVER_URL = 'http://localhost:3000';
export const DESKTOP_APP_DEEPLINK = 'thaumic-cast://';
const DEFAULT_SONOS_MODE: SonosMode = 'cloud';
const DEFAULT_LANGUAGE: SupportedLocale = 'en';

export type BackendType = 'desktop' | 'server' | 'unknown';
export type StopBehavior = 'stop' | 'pause';

export interface ExtensionSettings {
  serverUrl: string;
  sonosMode: SonosMode;
  speakerIp: string;
  language: SupportedLocale;
  backendType: BackendType;
  selectedGroupId: string;
  quality: QualityPreset;
  stopBehavior: StopBehavior;
}

// Normalize and return all persisted settings with defaults
export async function getExtensionSettings(): Promise<ExtensionSettings> {
  const result = (await chrome.storage.sync.get([
    'serverUrl',
    'sonosMode',
    'speakerIp',
    'language',
    'backendType',
    'selectedGroupId',
    'quality',
    'stopBehavior',
  ])) as Partial<ExtensionSettings>;

  return {
    serverUrl: normalizeServerUrl(result.serverUrl) || DEFAULT_SERVER_URL,
    sonosMode: (result.sonosMode as SonosMode) || DEFAULT_SONOS_MODE,
    speakerIp: result.speakerIp || '',
    language: (result.language as SupportedLocale) || DEFAULT_LANGUAGE,
    backendType: (result.backendType as BackendType) || 'unknown',
    selectedGroupId: result.selectedGroupId || '',
    quality: (result.quality as QualityPreset) || 'medium',
    stopBehavior: (result.stopBehavior as StopBehavior) || 'stop',
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
    selectedGroupId: partial.selectedGroupId ?? current.selectedGroupId,
    quality: partial.quality ?? current.quality,
    stopBehavior: partial.stopBehavior ?? current.stopBehavior,
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
 * Detect if the desktop app is running on any port in the expected range.
 * Scans ports 49400-49410 in parallel and returns as soon as one responds.
 * Verifies the service name to ensure it's actually the desktop app.
 */
export async function detectDesktopApp(): Promise<{ found: boolean; url: string | null }> {
  const ports = Array.from(
    { length: DESKTOP_PORT_RANGE.end - DESKTOP_PORT_RANGE.start + 1 },
    (_, i) => DESKTOP_PORT_RANGE.start + i
  );

  try {
    // Returns as soon as ANY port responds with valid desktop app
    const url = await Promise.any(
      ports.map(async (port) => {
        const url = `http://localhost:${port}`;
        const response = await fetch(`${url}/api/health`, {
          method: 'GET',
          signal: AbortSignal.timeout(500),
        });
        if (!response.ok) throw new Error('Not OK');
        const data = (await response.json()) as { service?: string };
        if (data.service !== 'thaumic-cast-desktop') throw new Error('Wrong service');
        return url;
      })
    );
    return { found: true, url };
  } catch {
    // AggregateError - no desktop app found on any port
    return { found: false, url: null };
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
