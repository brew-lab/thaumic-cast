import type {
  SonosGroupsResponse,
  SonosStatusResponse,
  CreateStreamRequest,
  CreateStreamResponse,
  ApiError,
  LocalDiscoveryResponse,
  LocalGroupsResponse,
} from '@thaumic-cast/shared';
import { API_TIMEOUT_MS } from '@thaumic-cast/shared';

async function getServerUrl(): Promise<string> {
  const result = (await chrome.storage.sync.get('serverUrl')) as { serverUrl?: string };
  return result.serverUrl || 'http://localhost:3000';
}

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
}

async function request<T>(
  endpoint: string,
  options: RequestOptions = {}
): Promise<{ data: T | null; error: string | null }> {
  const serverUrl = await getServerUrl();
  const { timeoutMs = API_TIMEOUT_MS, ...fetchOptions } = options;

  // Create abort controller for timeout
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${serverUrl}${endpoint}`, {
      ...fetchOptions,
      signal: controller.signal,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...fetchOptions.headers,
      },
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorData: ApiError = await response.json().catch(() => ({
        error: 'unknown',
        message: `HTTP ${response.status}`,
      }));
      return { data: null, error: errorData.message };
    }

    const data = (await response.json()) as T;
    return { data, error: null };
  } catch (err) {
    clearTimeout(timeoutId);

    // Handle abort/timeout specifically
    if (err instanceof Error && err.name === 'AbortError') {
      return {
        data: null,
        error: 'Request timed out. Check your server connection.',
      };
    }

    // Handle network errors with more context
    if (err instanceof TypeError && err.message.includes('fetch')) {
      return {
        data: null,
        error: 'Cannot reach server. Check the server URL in settings.',
      };
    }

    return {
      data: null,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

export async function getSonosStatus(): Promise<{
  data: SonosStatusResponse | null;
  error: string | null;
}> {
  return request<SonosStatusResponse>('/api/sonos/status');
}

export async function getSonosGroups(): Promise<{
  data: SonosGroupsResponse | null;
  error: string | null;
}> {
  return request<SonosGroupsResponse>('/api/sonos/groups');
}

export async function createStream(
  body: CreateStreamRequest
): Promise<{ data: CreateStreamResponse | null; error: string | null }> {
  return request<CreateStreamResponse>('/api/streams', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function stopStream(
  streamId: string
): Promise<{ data: { success: boolean } | null; error: string | null }> {
  return request<{ success: boolean }>(`/api/streams/${streamId}/stop`, {
    method: 'POST',
  });
}

export async function getGroupVolume(
  groupId: string
): Promise<{ data: { volume: number } | null; error: string | null }> {
  return request<{ volume: number }>(`/api/sonos/groups/${groupId}/volume`);
}

export async function setGroupVolume(
  groupId: string,
  volume: number
): Promise<{ data: { success: boolean } | null; error: string | null }> {
  return request<{ success: boolean }>(`/api/sonos/groups/${groupId}/volume`, {
    method: 'POST',
    body: JSON.stringify({ volume }),
  });
}

// Local mode API functions

export async function discoverLocalSpeakers(
  forceRefresh = false
): Promise<{ data: LocalDiscoveryResponse | null; error: string | null }> {
  const params = forceRefresh ? '?refresh=true' : '';
  return request<LocalDiscoveryResponse>(`/api/local/discover${params}`);
}

export async function getLocalGroups(speakerIp?: string): Promise<{
  data: LocalGroupsResponse | null;
  error: string | null;
}> {
  const params = speakerIp ? `?ip=${encodeURIComponent(speakerIp)}` : '';
  return request<LocalGroupsResponse>(`/api/local/groups${params}`);
}

export async function playLocalStream(
  coordinatorIp: string,
  streamUrl: string
): Promise<{ data: { success: boolean } | null; error: string | null }> {
  return request<{ success: boolean }>('/api/local/play', {
    method: 'POST',
    body: JSON.stringify({ coordinatorIp, streamUrl }),
  });
}

export async function stopLocalStream(
  coordinatorIp: string
): Promise<{ data: { success: boolean } | null; error: string | null }> {
  return request<{ success: boolean }>('/api/local/stop', {
    method: 'POST',
    body: JSON.stringify({ coordinatorIp }),
  });
}

export async function getLocalVolume(
  speakerIp: string
): Promise<{ data: { volume: number } | null; error: string | null }> {
  return request<{ volume: number }>(`/api/local/volume/${encodeURIComponent(speakerIp)}`);
}

export async function setLocalVolume(
  speakerIp: string,
  volume: number
): Promise<{ data: { success: boolean } | null; error: string | null }> {
  return request<{ success: boolean }>(`/api/local/volume/${encodeURIComponent(speakerIp)}`, {
    method: 'POST',
    body: JSON.stringify({ volume }),
  });
}

export async function getServerLocalIp(): Promise<{
  data: { ip: string } | null;
  error: string | null;
}> {
  return request<{ ip: string }>('/api/local/server-ip');
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
