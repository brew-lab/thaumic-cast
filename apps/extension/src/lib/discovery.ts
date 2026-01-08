import { createLogger } from '@thaumic-cast/shared';
import { loadExtensionSettings } from './settings';
import { getConnectionState, setDesktopApp } from '../background/connection-state';

const log = createLogger('Discovery');

/**
 * Expected port range for the Thaumic Cast Desktop App.
 */
const PORT_RANGE = { start: 49400, end: 49410 };

/**
 * Discovered Desktop App information including system limits.
 */
export interface DiscoveredApp {
  /** The base URL of the app (e.g. http://localhost:49400). */
  url: string;
  /** Maximum concurrent streams allowed by the server. */
  maxStreams: number;
}

/**
 * TTL for the discovery cache (5 minutes).
 */
const CACHE_TTL = 5 * 60 * 1000;

/**
 * Default fallback stream limit if not provided by server.
 */
const DEFAULT_MAX_STREAMS = 5;

/**
 * Clears the discovery cache, forcing a fresh discovery on next call.
 * Note: This is now a no-op since cache is managed by connection-state.
 * Use clearConnectionState() from connection-state.ts instead.
 */
export function clearDiscoveryCache(): void {
  log.debug('Discovery cache cleared (cache now managed by connection-state)');
}

/**
 * Probes a specific URL to check if it's a valid Thaumic Cast Desktop App.
 * @param url - The URL to probe
 * @returns Discovered app info or null if not valid
 */
async function probeUrl(url: string): Promise<DiscoveredApp | null> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(500),
    });

    if (response.ok) {
      const data = await response.json();

      if (data.service === 'thaumic-cast-desktop') {
        return {
          url,
          maxStreams: data.limits?.maxStreams || DEFAULT_MAX_STREAMS,
        };
      }
    }
  } catch {
    // URL is unreachable or timed out
  }

  return null;
}

/**
 * Discovers the active port of the Desktop App.
 *
 * This function respects extension settings:
 * - If useAutoDiscover is false and serverUrl is set, uses that URL directly
 * - Otherwise, scans localhost ports 49400-49410 in parallel
 *
 * Uses connection-state as the single source of truth for caching.
 *
 * @param force - If true, bypasses the cache and performs a full scan.
 * @returns Discovered app info or null if not found.
 */
export async function discoverDesktopApp(force = false): Promise<DiscoveredApp | null> {
  const now = Date.now();

  // Check extension settings for custom server URL
  const settings = await loadExtensionSettings();

  if (!settings.useAutoDiscover && settings.serverUrl) {
    log.info(`Using custom server URL: ${settings.serverUrl}`);
    const app = await probeUrl(settings.serverUrl);

    if (app) {
      setDesktopApp(app.url, app.maxStreams);
      return app;
    }

    log.warn(`Custom server URL not responding: ${settings.serverUrl}`);
    return null;
  }

  // Auto-discover mode: check cache first (using connection-state as source of truth)
  const connState = getConnectionState();
  if (!force && connState.desktopAppUrl && connState.lastDiscoveredAt) {
    const cacheAge = now - connState.lastDiscoveredAt;
    if (cacheAge < CACHE_TTL) {
      // Verify cached URL is still alive
      try {
        const response = await fetch(`${connState.desktopAppUrl}/health`, {
          signal: AbortSignal.timeout(200),
        });

        if (response.ok) {
          return {
            url: connState.desktopAppUrl,
            maxStreams: connState.maxStreams ?? DEFAULT_MAX_STREAMS,
          };
        }
      } catch {
        log.debug('Cached Desktop App URL no longer responding, rescanning...');
      }
    }
  }

  // Scan all ports in parallel
  const ports = Array.from(
    { length: PORT_RANGE.end - PORT_RANGE.start + 1 },
    (_, i) => PORT_RANGE.start + i,
  );

  const scanPromises = ports.map((port) => probeUrl(`http://localhost:${port}`));
  const results = await Promise.all(scanPromises);
  const foundApp = results.find((app) => app !== null);

  if (foundApp) {
    log.info(`Desktop App discovered at: ${foundApp.url} (Limit: ${foundApp.maxStreams})`);
    setDesktopApp(foundApp.url, foundApp.maxStreams);
    return foundApp;
  }

  log.warn('Desktop App not found in port range.');
  return null;
}
