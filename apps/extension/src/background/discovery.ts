/**
 * Desktop App Discovery Module
 *
 * Discovers the Thaumic Cast Desktop App on localhost.
 * This module is background-only as it depends on connection-state.
 *
 * Responsibilities:
 * - Probe localhost ports for desktop app
 * - Handle custom server URL from settings
 * - Cache discovery results in connection-state
 *
 * Non-responsibilities:
 * - Connection management (handled by handlers/connection.ts)
 * - WebSocket lifecycle (handled by offscreen-manager.ts)
 */

import { DEFAULT_MAX_CONCURRENT_STREAMS } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import { loadExtensionSettings } from '../lib/settings';
import { getConnectionState, setDesktopApp } from './connection-state';

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
          maxStreams: data.limits?.maxStreams || DEFAULT_MAX_CONCURRENT_STREAMS,
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
            maxStreams: connState.maxStreams ?? DEFAULT_MAX_CONCURRENT_STREAMS,
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
