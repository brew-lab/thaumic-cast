import type {
  MeResponse,
  SonosGroupsResponse,
  SonosStatusResponse,
  CreateStreamRequest,
  CreateStreamResponse,
  ApiError,
} from '@thaumic-cast/shared';

async function getServerUrl(): Promise<string> {
  const result = (await chrome.storage.sync.get('serverUrl')) as { serverUrl?: string };
  return result.serverUrl || 'http://localhost:3000';
}

async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<{ data: T | null; error: string | null }> {
  const serverUrl = await getServerUrl();

  try {
    const response = await fetch(`${serverUrl}${endpoint}`, {
      ...options,
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...options.headers,
      },
    });

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
    return {
      data: null,
      error: err instanceof Error ? err.message : 'Network error',
    };
  }
}

export async function getMe(): Promise<{ data: MeResponse | null; error: string | null }> {
  return request<MeResponse>('/api/me');
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
