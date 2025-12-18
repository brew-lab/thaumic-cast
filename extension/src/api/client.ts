import type {
  SonosGroupsResponse,
  SonosStatusResponse,
  LocalDiscoveryResponse,
  LocalGroupsResponse,
} from '@thaumic-cast/shared';
import { requestJson } from '../lib/http';
import { getServerUrl, type BackendType } from '../lib/settings';

export async function getSonosStatus(): Promise<{
  data: SonosStatusResponse | null;
  error: string | null;
}> {
  return requestJson<SonosStatusResponse>('/api/sonos/status');
}

export async function getSonosGroups(): Promise<{
  data: SonosGroupsResponse | null;
  error: string | null;
}> {
  return requestJson<SonosGroupsResponse>('/api/sonos/groups');
}

// Local mode API functions

export async function discoverLocalSpeakers(
  forceRefresh = false,
  baseUrl?: string
): Promise<{ data: LocalDiscoveryResponse | null; error: string | null }> {
  const params = forceRefresh ? '?refresh=true' : '';
  if (baseUrl) {
    return requestJson<LocalDiscoveryResponse>(`${baseUrl}/api/local/discover${params}`, {
      absolute: true,
    });
  }
  return requestJson<LocalDiscoveryResponse>(`/api/local/discover${params}`);
}

export async function getLocalGroups(speakerIp?: string): Promise<{
  data: LocalGroupsResponse | null;
  error: string | null;
}> {
  const params = speakerIp ? `?ip=${encodeURIComponent(speakerIp)}` : '';
  return requestJson<LocalGroupsResponse>(`/api/local/groups${params}`);
}

/**
 * Test if the server is reachable
 * @param url Optional URL to test. If not provided, uses the saved server URL.
 */
export async function testServerConnection(url?: string): Promise<{
  success: boolean;
  error: string | null;
  latencyMs?: number;
  backendType?: BackendType;
}> {
  const start = performance.now();

  try {
    const serverUrl = url || (await getServerUrl());
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000); // 5s timeout for test

    const response = await fetch(`${serverUrl}/api/health`, {
      method: 'GET',
      signal: controller.signal,
    });

    clearTimeout(timeoutId);
    const latencyMs = Math.round(performance.now() - start);

    if (response.ok) {
      // Parse the response to detect backend type
      let backendType: BackendType = 'unknown';
      try {
        const data = (await response.json()) as { service?: string };
        if (data.service === 'thaumic-cast-desktop') backendType = 'desktop';
        else if (data.service === 'thaumic-cast-server') backendType = 'server';
      } catch {
        // Ignore JSON parse errors, keep backendType as 'unknown'
      }
      return { success: true, error: null, latencyMs, backendType };
    }

    return {
      success: false,
      error: `Server returned ${response.status}`,
      latencyMs,
    };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { success: false, error: 'Connection timed out' };
    }
    return {
      success: false,
      error: err instanceof Error ? err.message : 'Connection failed',
    };
  }
}
