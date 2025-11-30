import type { CastStatus, QualityPreset, SonosMode } from '@thaumic-cast/shared';
import type { CreateStreamResponse } from '@thaumic-cast/shared';
import { fetchWithTimeout } from '../lib/http';
import { getServerUrl } from '../lib/settings';
import { ensureOffscreen } from './offscreen-manager';

let activeStream: CastStatus = { isActive: false };

interface StartStreamParams {
  tabId: number;
  groupId: string;
  groupName?: string;
  quality: QualityPreset;
  mediaStreamId: string;
  mode: SonosMode;
  coordinatorIp?: string;
}

export async function startStream(params: StartStreamParams): Promise<{
  success: boolean;
  streamId?: string;
  warning?: string;
  error?: string;
}> {
  const { tabId, groupId, groupName, quality, mediaStreamId, mode, coordinatorIp } = params;

  await stopCurrentStream();

  try {
    const serverUrl = await getServerUrl();
    const isLocalMode = mode === 'local';

    const response = await fetchWithTimeout(`${serverUrl}/api/streams`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        groupId,
        quality,
        mode: isLocalMode ? 'local' : 'cloud',
        coordinatorIp: isLocalMode ? coordinatorIp : undefined,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
      return { success: false, error: error.message || 'Failed to create stream' };
    }

    const { streamId, ingestUrl, playbackUrl } = (await response.json()) as CreateStreamResponse;

    await ensureOffscreen();

    const offscreenResult = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START',
      streamId,
      mediaStreamId,
      quality,
      ingestUrl,
    });

    if (offscreenResult?.error) {
      return { success: false, error: offscreenResult.error };
    }

    let localPlayError: string | null = null;
    if (isLocalMode && coordinatorIp) {
      await new Promise((resolve) => setTimeout(resolve, 500));

      try {
        const playResponse = await fetchWithTimeout(`${serverUrl}/api/local/play`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            coordinatorIp,
            streamUrl: playbackUrl,
          }),
        });

        if (!playResponse.ok) {
          const error = await playResponse.json().catch(() => ({ message: 'Unknown error' }));
          localPlayError = error.message || 'Failed to start playback on speaker';
          console.error('[StreamManager] Local play failed:', localPlayError);
        }
      } catch (err) {
        localPlayError = err instanceof Error ? err.message : 'Failed to connect to speaker';
        console.error('[StreamManager] Local play error:', localPlayError);
      }
    }

    activeStream = {
      isActive: true,
      streamId,
      tabId,
      groupId,
      groupName,
      quality,
      mode: isLocalMode ? 'local' : 'cloud',
      coordinatorIp: isLocalMode ? coordinatorIp : undefined,
    };

    if (localPlayError) {
      return {
        success: true,
        streamId,
        warning: `Streaming started but speaker may not be playing: ${localPlayError}`,
      };
    }

    return { success: true, streamId };
  } catch (err) {
    const errorMessage =
      err instanceof Error
        ? err.message.includes('timed out')
          ? 'Server connection timed out. Check server URL in settings.'
          : err.message
        : 'Unknown error';
    return { success: false, error: errorMessage };
  }
}

export async function stopCurrentStream(mode?: SonosMode, coordinatorIp?: string): Promise<void> {
  if (!activeStream.isActive || !activeStream.streamId) return;

  try {
    await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_STOP',
      streamId: activeStream.streamId,
    });
  } catch {
    // Offscreen might not exist
  }

  const serverUrl = await getServerUrl();
  const effectiveMode = mode || activeStream.mode;
  const effectiveIp = coordinatorIp || activeStream.coordinatorIp;

  if (effectiveMode === 'local' && effectiveIp) {
    try {
      await fetchWithTimeout(
        `${serverUrl}/api/local/stop`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ coordinatorIp: effectiveIp }),
        },
        5000
      );
    } catch {
      console.warn('[StreamManager] Failed to stop playback on speaker');
    }
  }

  try {
    await fetchWithTimeout(
      `${serverUrl}/api/streams/${activeStream.streamId}/stop`,
      {
        method: 'POST',
        credentials: 'include',
      },
      5000
    );
  } catch {
    console.warn('[StreamManager] Failed to notify server of stream stop');
  }

  activeStream = { isActive: false };
}

export function getActiveStream(): CastStatus {
  return activeStream;
}

export function clearActiveStream(): void {
  activeStream = { isActive: false };
}
