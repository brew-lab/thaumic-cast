import type {
  SonosGroupsResponse,
  SonosStatusResponse,
  CreateStreamRequest,
  CreateStreamResponse,
  LocalDiscoveryResponse,
  LocalGroupsResponse,
} from '@thaumic-cast/shared';
import { requestJson } from '../lib/http';
import { getServerUrl } from '../lib/settings';

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

export async function createStream(
  body: CreateStreamRequest
): Promise<{ data: CreateStreamResponse | null; error: string | null }> {
  return requestJson<CreateStreamResponse>('/api/streams', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function stopStream(
  streamId: string
): Promise<{ data: { success: boolean } | null; error: string | null }> {
  return requestJson<{ success: boolean }>(`/api/streams/${streamId}/stop`, {
    method: 'POST',
  });
}

export async function getGroupVolume(
  groupId: string
): Promise<{ data: { volume: number } | null; error: string | null }> {
  return requestJson<{ volume: number }>(`/api/sonos/groups/${groupId}/volume`);
}

export async function setGroupVolume(
  groupId: string,
  volume: number
): Promise<{ data: { success: boolean } | null; error: string | null }> {
  return requestJson<{ success: boolean }>(`/api/sonos/groups/${groupId}/volume`, {
    method: 'POST',
    body: JSON.stringify({ volume }),
  });
}

// Local mode API functions

export async function discoverLocalSpeakers(
  forceRefresh = false
): Promise<{ data: LocalDiscoveryResponse | null; error: string | null }> {
  const params = forceRefresh ? '?refresh=true' : '';
  return requestJson<LocalDiscoveryResponse>(`/api/local/discover${params}`);
}

export async function getLocalGroups(speakerIp?: string): Promise<{
  data: LocalGroupsResponse | null;
  error: string | null;
}> {
  const params = speakerIp ? `?ip=${encodeURIComponent(speakerIp)}` : '';
  return requestJson<LocalGroupsResponse>(`/api/local/groups${params}`);
}

export async function playLocalStream(
  coordinatorIp: string,
  streamUrl: string
): Promise<{ data: { success: boolean } | null; error: string | null }> {
  return requestJson<{ success: boolean }>('/api/local/play', {
    method: 'POST',
    body: JSON.stringify({ coordinatorIp, streamUrl }),
  });
}

export async function stopLocalStream(
  coordinatorIp: string
): Promise<{ data: { success: boolean } | null; error: string | null }> {
  return requestJson<{ success: boolean }>('/api/local/stop', {
    method: 'POST',
    body: JSON.stringify({ coordinatorIp }),
  });
}

export async function getLocalVolume(
  speakerIp: string
): Promise<{ data: { volume: number } | null; error: string | null }> {
  return requestJson<{ volume: number }>(`/api/local/volume/${encodeURIComponent(speakerIp)}`);
}

export async function setLocalVolume(
  speakerIp: string,
  volume: number
): Promise<{ data: { success: boolean } | null; error: string | null }> {
  return requestJson<{ success: boolean }>(`/api/local/volume/${encodeURIComponent(speakerIp)}`, {
    method: 'POST',
    body: JSON.stringify({ volume }),
  });
}

export async function getServerLocalIp(): Promise<{
  data: { ip: string } | null;
  error: string | null;
}> {
  return requestJson<{ ip: string }>('/api/local/server-ip');
}

/**
 * Test if the server is reachable
 * @param url Optional URL to test. If not provided, uses the saved server URL.
 */
export async function testServerConnection(url?: string): Promise<{
  success: boolean;
  error: string | null;
  latencyMs?: number;
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
      return { success: true, error: null, latencyMs };
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
