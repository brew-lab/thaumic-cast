import type { CastStatus, QualityPreset, SonosMode, StreamMetadata } from '@thaumic-cast/shared';
import type { CreateStreamResponse } from '@thaumic-cast/shared';
import { fetchWithTimeout } from '../lib/http';
import { getServerUrl } from '../lib/settings';
import { ensureOffscreen } from './offscreen-manager';

let activeStream: CastStatus = { isActive: false };
let lastHeartbeatAt = 0;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
const HEARTBEAT_TIMEOUT_MS = 10000;

interface StartStreamParams {
  tabId: number;
  groupId: string;
  groupName?: string;
  quality: QualityPreset;
  mediaStreamId: string;
  mode: SonosMode;
  coordinatorIp?: string;
  metadata?: StreamMetadata;
}

function logEvent(message: string, context?: Record<string, unknown>) {
  const payload = context ? ` ${JSON.stringify(context)}` : '';
  console.log(`[StreamManager] ${message}${payload}`);
}

function logError(message: string, context?: Record<string, unknown>) {
  const payload = context ? ` ${JSON.stringify(context)}` : '';
  console.error(`[StreamManager] ${message}${payload}`);
}

export async function startStream(params: StartStreamParams): Promise<{
  success: boolean;
  streamId?: string;
  warning?: string;
  error?: string;
}> {
  const { tabId, groupId, groupName, quality, mediaStreamId, mode, coordinatorIp, metadata } =
    params;

  await stopCurrentStream();

  try {
    logEvent('start requested', { mode, groupId, tabId });
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
        metadata,
      }),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({ message: `HTTP ${response.status}` }));
      logError('failed to create stream', { status: response.status, groupId });
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
      logError('offscreen failed to start', { error: offscreenResult.error });
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
            metadata,
          }),
        });

        if (!playResponse.ok) {
          const error = await playResponse.json().catch(() => ({ message: 'Unknown error' }));
          localPlayError = error.message || 'Failed to start playback on speaker';
          logError('local play failed', { coordinatorIp, message: localPlayError });
        }
      } catch (err) {
        localPlayError = err instanceof Error ? err.message : 'Failed to connect to speaker';
        logError('local play error', { coordinatorIp, message: localPlayError });
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
    lastHeartbeatAt = Date.now();
    startHeartbeatMonitor();

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
    logError('start failed', { message: errorMessage });
    return { success: false, error: errorMessage };
  }
}

export async function stopCurrentStream(mode?: SonosMode, coordinatorIp?: string): Promise<void> {
  if (!activeStream.isActive || !activeStream.streamId) return;

  stopHeartbeatMonitor();

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
    const stopPayload = {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include' as const,
      body: JSON.stringify({ coordinatorIp: effectiveIp }),
    };

    let stopError: unknown = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetchWithTimeout(`${serverUrl}/api/local/stop`, stopPayload, 5000);
        if (res.ok) {
          stopError = null;
          break;
        }
        stopError = `HTTP ${res.status}`;
      } catch (err) {
        stopError = err;
      }

      if (stopError && attempt < 2) {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    if (stopError) {
      logError('failed to stop playback on speaker', {
        coordinatorIp: effectiveIp,
        message: stopError instanceof Error ? stopError.message : String(stopError),
      });
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
    logError('failed to notify server of stream stop');
  }

  activeStream = { isActive: false };
}

export function getActiveStream(): CastStatus {
  return activeStream;
}

export function clearActiveStream(): void {
  stopHeartbeatMonitor();
  activeStream = { isActive: false };
}

export function recordHeartbeat(streamId: string): void {
  if (activeStream.streamId !== streamId) return;
  lastHeartbeatAt = Date.now();
}

function startHeartbeatMonitor() {
  stopHeartbeatMonitor();
  heartbeatInterval = setInterval(() => {
    if (!activeStream.isActive || !activeStream.streamId) {
      stopHeartbeatMonitor();
      return;
    }

    const elapsed = Date.now() - lastHeartbeatAt;
    if (elapsed > HEARTBEAT_TIMEOUT_MS) {
      logError('heartbeat timeout, stopping stream', { streamId: activeStream.streamId });
      stopCurrentStream(activeStream.mode, activeStream.coordinatorIp);
      clearActiveStream();
    }
  }, 3000);
}

function stopHeartbeatMonitor() {
  if (heartbeatInterval) {
    clearInterval(heartbeatInterval);
    heartbeatInterval = null;
  }
}
