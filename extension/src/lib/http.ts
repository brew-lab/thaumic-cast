import { API_TIMEOUT_MS } from '@thaumic-cast/shared';
import { getServerUrl } from './settings';
import { t } from './i18n';

export interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  // When true, `url` is treated as absolute and we skip prefixing with serverUrl
  absolute?: boolean;
}

export async function requestJson<T>(
  url: string,
  options: RequestOptions = {}
): Promise<{ data: T | null; error: string | null }> {
  const { timeoutMs = API_TIMEOUT_MS, absolute = false, ...fetchOptions } = options;
  const finalUrl = absolute ? url : `${await getServerUrl()}${url}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(finalUrl, {
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
      const errorData = (await response.json().catch(() => null)) as {
        message?: string;
      } | null;
      return { data: null, error: errorData?.message || `HTTP ${response.status}` };
    }

    const data = (await response.json()) as T;
    return { data, error: null };
  } catch (err) {
    clearTimeout(timeoutId);

    if (err instanceof Error && err.name === 'AbortError') {
      return { data: null, error: t('errors.requestTimedOut') };
    }

    if (err instanceof TypeError && err.message.includes('fetch')) {
      return { data: null, error: t('errors.cannotReachServer') };
    }

    return { data: null, error: err instanceof Error ? err.message : t('errors.networkError') };
  }
}

// Lightweight fetch helper for callers that want a raw Response
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs = API_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    return response;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error('Request timed out');
    }
    throw err;
  }
}
