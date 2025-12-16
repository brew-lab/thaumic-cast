import type {
  AudioCodec,
  CastStatus,
  QualityPreset,
  SonosMode,
  StreamMetadata,
  WsAction,
} from '@thaumic-cast/shared';
import { fetchWithTimeout } from '../lib/http';
import { getServerUrl } from '../lib/settings';
import { ensureOffscreen } from './offscreen-manager';
import { sendWsCommand, isWsConnected } from './ws-client';

let activeStream: CastStatus = { isActive: false };
let lastHeartbeatAt = 0;
let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
let metadataDebounceTimer: ReturnType<typeof setTimeout> | null = null;
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

    // Ensure offscreen is ready before querying codec
    await ensureOffscreen();

    // Check WebSocket is connected
    if (!isWsConnected()) {
      logError('WebSocket not connected');
      return { success: false, error: 'WebSocket not connected. Please reconnect.' };
    }

    // Query offscreen for the best available codec for this quality
    let codec: AudioCodec = 'mp3';
    try {
      const codecResult = (await chrome.runtime.sendMessage({
        type: 'OFFSCREEN_CHECK_CODEC',
        quality,
      })) as { codec: AudioCodec } | undefined;
      if (codecResult?.codec) {
        codec = codecResult.codec;
      }
    } catch {
      logEvent('codec detection failed, defaulting to mp3');
    }
    logEvent('detected codec', { codec, quality });

    // Create stream via WebSocket command (this associates the WS connection with the stream)
    const createResult = await sendWsCommand('createStream' as WsAction, {
      groupId,
      quality,
      mode: isLocalMode ? 'local' : 'cloud',
      coordinatorIp: isLocalMode ? coordinatorIp : undefined,
      metadata,
      codec,
    });

    if (!createResult?.streamId || !createResult?.playbackUrl) {
      logError('failed to create stream via WebSocket');
      return { success: false, error: 'Failed to create stream' };
    }

    const streamId = createResult.streamId as string;
    const playbackUrl = createResult.playbackUrl as string;

    const offscreenResult = await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_START',
      streamId,
      mediaStreamId,
      quality,
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
      playbackUrl,
      metadata,
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
  clearMetadataDebounce();

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
  clearMetadataDebounce();
  activeStream = { isActive: false };
  broadcastStatusUpdate();
}

/**
 * Pause the active stream (Sonos stopped but keep infrastructure alive).
 * Audio capture stops, but WebSocket stays open for resume.
 * Also pauses the media in the source tab.
 */
export async function pauseActiveStream(): Promise<void> {
  if (!activeStream.isActive || !activeStream.streamId || activeStream.isPaused) {
    return;
  }

  try {
    const result = (await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_PAUSE',
      streamId: activeStream.streamId,
    })) as { success: boolean } | undefined;

    if (!result?.success) {
      throw new Error('Offscreen failed to pause');
    }

    // Pause media in the source tab
    if (activeStream.tabId) {
      try {
        await chrome.tabs.sendMessage(activeStream.tabId, {
          type: 'CONTROL_MEDIA',
          action: 'pause',
        });
        logEvent('media paused in tab', { tabId: activeStream.tabId });
      } catch {
        // Tab might not have content script or media
        logEvent('could not pause media in tab (no media or content script)');
      }
    }

    activeStream = {
      ...activeStream,
      isPaused: true,
    };

    broadcastStatusUpdate();
    logEvent('stream paused', { streamId: activeStream.streamId });
  } catch (err) {
    logError('failed to pause stream', {
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * Resume the active stream after pause.
 * Reconnects audio capture and resumes sending frames.
 * Also resumes the media in the source tab.
 */
export async function resumeActiveStream(): Promise<void> {
  if (!activeStream.isActive || !activeStream.streamId || !activeStream.isPaused) {
    return;
  }

  try {
    const result = (await chrome.runtime.sendMessage({
      type: 'OFFSCREEN_RESUME',
      streamId: activeStream.streamId,
    })) as { success: boolean } | undefined;

    if (!result?.success) {
      throw new Error('Offscreen failed to resume');
    }

    // Resume media in the source tab
    if (activeStream.tabId) {
      try {
        await chrome.tabs.sendMessage(activeStream.tabId, {
          type: 'CONTROL_MEDIA',
          action: 'play',
        });
        logEvent('media resumed in tab', { tabId: activeStream.tabId });
      } catch {
        // Tab might not have content script or media
        logEvent('could not resume media in tab (no media or content script)');
      }
    }

    activeStream = {
      ...activeStream,
      isPaused: false,
    };

    broadcastStatusUpdate();
    logEvent('stream resumed', { streamId: activeStream.streamId });
  } catch (err) {
    logError('failed to resume stream', {
      error: err instanceof Error ? err.message : 'unknown',
    });
  }
}

/**
 * Broadcast current status to any open popup/UI.
 * Uses chrome.runtime.sendMessage which will be received by any listeners.
 */
export function broadcastStatusUpdate(): void {
  chrome.runtime
    .sendMessage({
      type: 'STATUS_UPDATE',
      status: activeStream,
    })
    .catch(() => {
      // Ignore errors - popup may not be open
    });
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

function clearMetadataDebounce(): void {
  if (metadataDebounceTimer) {
    clearTimeout(metadataDebounceTimer);
    metadataDebounceTimer = null;
  }
}

/**
 * Update stream metadata for ICY injection.
 * Works for both local and cloud modes - metadata is embedded in the MP3 stream.
 * Debounced to avoid flooding the server with updates.
 */
export async function updateStreamMetadata(tabId: number, metadata: StreamMetadata): Promise<void> {
  // Guard: only if active and from casting tab
  if (!activeStream.isActive || !activeStream.streamId) return;
  if (activeStream.tabId !== tabId) return;

  // Skip if unchanged (compare title, artist, album)
  const prev = activeStream.metadata;
  if (
    prev?.title === metadata.title &&
    prev?.artist === metadata.artist &&
    prev?.album === metadata.album
  ) {
    return;
  }

  // Debounce 1s to avoid flooding server
  clearMetadataDebounce();
  metadataDebounceTimer = setTimeout(async () => {
    try {
      const serverUrl = await getServerUrl();
      await fetchWithTimeout(`${serverUrl}/api/streams/${activeStream.streamId}/metadata`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(metadata),
      });
      activeStream.metadata = metadata;
      logEvent('metadata updated', { title: metadata.title });
    } catch (err) {
      logError('metadata update failed', {
        error: err instanceof Error ? err.message : 'unknown',
      });
    }
  }, 1000);
}
