import { createLogger } from '@thaumic-cast/shared';

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

 * Cache for the discovered app info to avoid rescanning on every request.

 */

let cachedApp: DiscoveredApp | null = null;

/**

 * Timestamp of when the cache was last updated.

 */

let lastDiscoveredAt = 0;

/**

 * TTL for the discovery cache (5 minutes).

 */

const CACHE_TTL = 5 * 60 * 1000;

/**

 * Default fallback stream limit if not provided by server.

 */

const DEFAULT_MAX_STREAMS = 5;

/**
 * Discovers the active port of the Desktop App by scanning the local range.
 *
 * This function implements caching to avoid unnecessary network scans.
 * It checks ports 49400-49410 in parallel.
 *
 * @param force - If true, bypasses the cache and performs a full scan.
 * @returns Discovered app info or null if not found.
 */
export async function discoverDesktopApp(force = false): Promise<DiscoveredApp | null> {
  const now = Date.now();

  if (!force && cachedApp && now - lastDiscoveredAt < CACHE_TTL) {
    // Verify cached URL is still alive

    try {
      const response = await fetch(`${cachedApp.url}/health`, {
        signal: AbortSignal.timeout(200),
      });

      if (response.ok) return cachedApp;
    } catch {
      log.debug('Cached Desktop App URL no longer responding, rescanning...');
    }
  }

  const ports = Array.from(
    { length: PORT_RANGE.end - PORT_RANGE.start + 1 },

    (_, i) => PORT_RANGE.start + i,
  );

  // Scan all ports in parallel

  const scanPromises = ports.map(async (port) => {
    const url = `http://localhost:${port}`;

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
          } as DiscoveredApp;
        }
      }
    } catch {
      // Port is closed or timed out
    }

    return null;
  });

  const results = await Promise.all(scanPromises);

  const foundApp = results.find((app) => app !== null);

  if (foundApp) {
    log.info(`Desktop App discovered at: ${foundApp.url} (Limit: ${foundApp.maxStreams})`);

    cachedApp = foundApp;

    lastDiscoveredAt = now;

    return foundApp;
  }

  log.warn('Desktop App not found in port range.');

  cachedApp = null;

  return null;
}
