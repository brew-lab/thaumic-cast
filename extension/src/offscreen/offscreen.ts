import type {
  OffscreenStartMessage,
  OffscreenStopMessage,
  OffscreenPauseMessage,
  OffscreenResumeMessage,
  WsConnectMessage,
  WsCommandMessage,
  QualityPreset,
  AudioCodec,
  SonosStateSnapshot,
} from '@thaumic-cast/shared';
import { createMp3Encoder } from 'wasm-media-encoders';
import { createAacEncoder, isAacSupported, type AacCodec } from './aac-encoder';

// Unified encoder interface for both AAC and MP3
interface UnifiedEncoder {
  encode(samples: [Float32Array, Float32Array]): Uint8Array | null;
  finalize(): Uint8Array | null;
  close?(): void;
}

interface StreamSession {
  streamId: string;
  audioContext: AudioContext | null;
  mediaStream: MediaStream | null;
  workletNode: AudioWorkletNode | null;
  sourceNode: MediaStreamAudioSourceNode | null;
  encoder: UnifiedEncoder | null;
  codec: AudioCodec;
  frameBuffer: Uint8Array[];
  stopped: boolean;
  paused: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

// wasm-media-encoders expects specific CBR bitrate values
type Mp3Bitrate = 128 | 192 | 320;
type Channels = 1 | 2;

interface QualityConfig {
  preferredCodec: AacCodec | 'mp3';
  bitrate: number;
  sampleRate: 44100 | 48000;
  channels: Channels;
  mp3Fallback: { bitrate: Mp3Bitrate; sampleRate: 44100 | 48000 };
}

const QUALITY_SETTINGS: Record<QualityPreset, QualityConfig> = {
  'ultra-low': {
    preferredCodec: 'mp4a.40.5', // HE-AAC
    bitrate: 64000,
    sampleRate: 48000,
    channels: 2,
    mp3Fallback: { bitrate: 128, sampleRate: 44100 },
  },
  low: {
    preferredCodec: 'mp4a.40.5', // HE-AAC
    bitrate: 96000,
    sampleRate: 48000,
    channels: 2,
    mp3Fallback: { bitrate: 128, sampleRate: 44100 },
  },
  medium: {
    preferredCodec: 'mp4a.40.2', // AAC-LC
    bitrate: 128000,
    sampleRate: 48000,
    channels: 2,
    mp3Fallback: { bitrate: 192, sampleRate: 48000 },
  },
  high: {
    preferredCodec: 'mp4a.40.2', // AAC-LC
    bitrate: 192000, // WebCodecs AAC-LC max is 192kbps (still better quality than 320kbps MP3)
    sampleRate: 48000,
    channels: 2,
    mp3Fallback: { bitrate: 320, sampleRate: 48000 },
  },
};

const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_BUFFER_FRAMES = 60; // ~2 seconds

let currentSession: StreamSession | null = null;

// ============ Control WebSocket (for commands, separate from audio ingest) ============

interface ControlConnection {
  ws: WebSocket | null;
  url: string;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
}

let controlConnection: ControlConnection | null = null;

// Cache Sonos state so we can restore it when service worker wakes up
let cachedSonosState: SonosStateSnapshot | null = null;

function connectControlWebSocket(url: string): void {
  if (controlConnection?.ws?.readyState === WebSocket.OPEN) {
    console.log('[Offscreen] Control WS already connected');
    return;
  }

  console.log('[Offscreen] Connecting control WebSocket to:', url);

  const ws = new WebSocket(url);

  controlConnection = {
    ws,
    url,
    reconnectAttempts: 0,
    reconnectTimer: null,
  };

  ws.onopen = () => {
    console.log('[Offscreen] Control WebSocket connected');
    if (controlConnection) {
      controlConnection.reconnectAttempts = 0;
    }

    // Flush any buffered audio frames from current session
    if (currentSession && currentSession.frameBuffer.length > 0) {
      console.log(`[Offscreen] Flushing ${currentSession.frameBuffer.length} buffered frames`);
      for (const frame of currentSession.frameBuffer) {
        ws.send(frame);
      }
      currentSession.frameBuffer = [];
    }
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return;

    try {
      const message = JSON.parse(event.data);
      console.log('[Offscreen] Control WS received:', message);

      if (message.type === 'connected') {
        // Initial connection event with state - cache it for service worker recovery
        cachedSonosState = message.state as SonosStateSnapshot;
        chrome.runtime
          .sendMessage({
            type: 'WS_CONNECTED',
            state: cachedSonosState,
          })
          .catch(() => {
            // Background may be suspended - state is cached, will be recovered on wake
          });
      } else if (message.id !== undefined) {
        // Command response (has id field)
        chrome.runtime
          .sendMessage({
            type: 'WS_RESPONSE',
            id: message.id,
            success: message.success,
            data: message.data,
            error: message.error,
          })
          .catch(() => {
            // Background may be suspended
          });
      } else if (message.type) {
        // Sonos event (has type field but no id)
        chrome.runtime
          .sendMessage({
            type: 'SONOS_EVENT',
            payload: message,
          })
          .catch(() => {
            // Background may be suspended
          });
      }
    } catch (err) {
      console.error('[Offscreen] Failed to parse control WS message:', err);
    }
  };

  ws.onclose = () => {
    console.log('[Offscreen] Control WebSocket closed');
    attemptControlReconnect();
  };

  ws.onerror = (error) => {
    console.error('[Offscreen] Control WebSocket error:', error);
  };
}

function attemptControlReconnect(): void {
  if (!controlConnection) return;

  controlConnection.reconnectAttempts++;

  if (controlConnection.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error('[Offscreen] Control WS max reconnect attempts exceeded');
    // Notify background that connection permanently failed
    chrome.runtime.sendMessage({ type: 'WS_PERMANENTLY_DISCONNECTED' }).catch(() => {
      // Background may not be listening
    });
    controlConnection = null;
    return;
  }

  const delay = Math.min(500 * Math.pow(2, controlConnection.reconnectAttempts - 1), 5000);
  console.log(`[Offscreen] Reconnecting control WS in ${delay}ms...`);

  controlConnection.reconnectTimer = setTimeout(() => {
    if (controlConnection) {
      connectControlWebSocket(controlConnection.url);
    }
  }, delay);
}

function disconnectControlWebSocket(): void {
  if (!controlConnection) return;

  console.log('[Offscreen] Disconnecting control WebSocket');

  if (controlConnection.reconnectTimer) {
    clearTimeout(controlConnection.reconnectTimer);
  }

  controlConnection.ws?.close();
  controlConnection = null;
}

function sendControlCommand(id: string, action: string, payload?: Record<string, unknown>): void {
  if (!controlConnection?.ws || controlConnection.ws.readyState !== WebSocket.OPEN) {
    console.error('[Offscreen] Control WS not connected, cannot send command');
    chrome.runtime
      .sendMessage({
        type: 'WS_RESPONSE',
        id,
        success: false,
        error: 'WebSocket not connected',
      })
      .catch(() => {
        // Background may be suspended
      });
    return;
  }

  const command = { id, action, payload };
  console.log('[Offscreen] Sending control command:', command);
  controlConnection.ws.send(JSON.stringify(command));
}

// Listen for messages from background
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  console.log('[Offscreen] Received message:', message.type);

  if (message.type === 'OFFSCREEN_START') {
    console.log('[Offscreen] Starting capture...');
    handleStart(message as OffscreenStartMessage).then((result) => {
      console.log('[Offscreen] handleStart result:', result);
      sendResponse(result);
    });
    return true;
  }

  if (message.type === 'OFFSCREEN_STOP') {
    handleStop(message as OffscreenStopMessage).then(sendResponse);
    return true;
  }

  if (message.type === 'OFFSCREEN_PAUSE') {
    handlePause(message as OffscreenPauseMessage).then(sendResponse);
    return true;
  }

  if (message.type === 'OFFSCREEN_RESUME') {
    handleResume(message as OffscreenResumeMessage).then(sendResponse);
    return true;
  }

  if (message.type === 'OFFSCREEN_CHECK_CODEC') {
    detectBestCodec(message.quality as QualityPreset).then((codec) => {
      sendResponse({ codec });
    });
    return true;
  }

  // WebSocket control messages
  if (message.type === 'WS_CONNECT') {
    const { url } = message as WsConnectMessage;
    connectControlWebSocket(url);
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'WS_DISCONNECT') {
    disconnectControlWebSocket();
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'WS_COMMAND') {
    const { id, action, payload } = message as WsCommandMessage;
    sendControlCommand(id, action, payload);
    sendResponse({ success: true });
    return true;
  }

  // Allow background to trigger a reconnection attempt (resets attempt counter)
  if (message.type === 'WS_RECONNECT') {
    const { url } = message as { url?: string };
    if (url) {
      // New URL provided - disconnect and connect to new URL
      disconnectControlWebSocket();
      connectControlWebSocket(url);
    } else if (controlConnection) {
      // No URL - reset attempts and reconnect to existing URL
      controlConnection.reconnectAttempts = 0;
      if (controlConnection.reconnectTimer) {
        clearTimeout(controlConnection.reconnectTimer);
        controlConnection.reconnectTimer = null;
      }
      connectControlWebSocket(controlConnection.url);
    }
    sendResponse({ success: true });
    return true;
  }

  // Allow background to query current WebSocket state (including cached Sonos state for recovery)
  if (message.type === 'GET_WS_STATUS') {
    sendResponse({
      connected: controlConnection?.ws?.readyState === WebSocket.OPEN,
      url: controlConnection?.url,
      reconnectAttempts: controlConnection?.reconnectAttempts ?? 0,
      state: cachedSonosState,
    });
    return true;
  }

  // Allow background to sync state updates back to offscreen for caching
  if (message.type === 'SYNC_SONOS_STATE') {
    const { state } = message as { state: SonosStateSnapshot };
    cachedSonosState = state;
    sendResponse({ success: true });
    return true;
  }
});

// Signal to background that offscreen is ready to receive messages
console.log('[Offscreen] Ready');
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {
  // Background may be suspended during startup race
});

/**
 * Detect the best available codec for a given quality preset.
 * Returns the codec that will actually be used (AAC if supported, MP3 fallback).
 */
async function detectBestCodec(quality: QualityPreset): Promise<AudioCodec> {
  const settings = QUALITY_SETTINGS[quality];

  if (settings.preferredCodec === 'mp3') {
    return 'mp3';
  }

  const aacSupported = await isAacSupported({
    codec: settings.preferredCodec,
    sampleRate: settings.sampleRate,
    channels: settings.channels,
    bitrate: settings.bitrate,
  });

  if (aacSupported) {
    return settings.preferredCodec === 'mp4a.40.5' ? 'he-aac' : 'aac-lc';
  }

  return 'mp3';
}

async function handleStart(
  message: OffscreenStartMessage
): Promise<{ success: boolean; error?: string }> {
  const { streamId, mediaStreamId, quality } = message;

  console.log('[Offscreen] handleStart called with:', { streamId, mediaStreamId, quality });

  // Ensure control WebSocket is connected (audio frames go over the same connection)
  if (!controlConnection?.ws || controlConnection.ws.readyState !== WebSocket.OPEN) {
    console.error('[Offscreen] WebSocket not connected!', {
      hasControlConnection: !!controlConnection,
      hasWs: !!controlConnection?.ws,
      readyState: controlConnection?.ws?.readyState,
    });
    return { success: false, error: 'WebSocket not connected. Connect first with WS_CONNECT.' };
  }

  console.log('[Offscreen] WebSocket is connected, proceeding with audio setup');

  // Stop any existing session
  if (currentSession) {
    await stopSession(currentSession);
  }

  const settings = QUALITY_SETTINGS[quality];

  try {
    // Get media stream from tab capture
    const mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: mediaStreamId,
        },
      } as MediaTrackConstraints,
      video: false,
    });

    // Check AAC support and select encoder
    let encoder: UnifiedEncoder;
    let codec: AudioCodec;
    let sampleRate: number;

    if (settings.preferredCodec !== 'mp3') {
      const aacSupported = await isAacSupported({
        codec: settings.preferredCodec,
        sampleRate: settings.sampleRate,
        channels: settings.channels,
        bitrate: settings.bitrate,
      });

      if (aacSupported) {
        // Use native AAC encoding
        const aacEncoder = await createAacEncoder();
        aacEncoder.configure({
          codec: settings.preferredCodec,
          sampleRate: settings.sampleRate,
          channels: settings.channels,
          bitrate: settings.bitrate,
        });
        encoder = aacEncoder;
        codec = settings.preferredCodec === 'mp4a.40.5' ? 'he-aac' : 'aac-lc';
        sampleRate = settings.sampleRate;
        console.log(`[Offscreen] Using native ${codec} encoding at ${settings.bitrate / 1000}kbps`);
      } else {
        // Fallback to MP3
        console.log('[Offscreen] AAC not supported, falling back to MP3');
        const mp3Encoder = await createMp3Encoder();
        mp3Encoder.configure({
          channels: settings.channels,
          sampleRate: settings.mp3Fallback.sampleRate,
          bitrate: settings.mp3Fallback.bitrate,
        });
        encoder = mp3Encoder;
        codec = 'mp3';
        sampleRate = settings.mp3Fallback.sampleRate;
      }
    } else {
      // MP3 explicitly requested
      const mp3Encoder = await createMp3Encoder();
      mp3Encoder.configure({
        channels: settings.channels,
        sampleRate: settings.mp3Fallback.sampleRate,
        bitrate: settings.mp3Fallback.bitrate,
      });
      encoder = mp3Encoder;
      codec = 'mp3';
      sampleRate = settings.mp3Fallback.sampleRate;
    }

    // Create audio context with low latency hint for faster capture
    const audioContext = new AudioContext({ sampleRate, latencyHint: 'interactive' });

    // Load audio worklet from static file (blob URLs blocked by MV3 CSP)
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));

    // Create audio graph
    const source = audioContext.createMediaStreamSource(mediaStream);
    const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

    source.connect(workletNode);

    // Create session (audio frames sent via controlConnection)
    const session: StreamSession = {
      streamId,
      audioContext,
      mediaStream,
      workletNode,
      sourceNode: source,
      encoder,
      codec,
      frameBuffer: [],
      stopped: false,
      paused: false,
      heartbeatTimer: null,
    };

    currentSession = session;

    // Counter for PCM logging
    let pcmCounter = 0;

    // Handle PCM data from worklet
    workletNode.port.onmessage = (event) => {
      if (!currentSession || currentSession.stopped || currentSession.paused) return;

      pcmCounter++;
      if (pcmCounter === 1) {
        console.log('[Offscreen] First PCM data received from worklet');
      }

      const pcmData = event.data as { left: Float32Array; right: Float32Array };
      const encodedFrame = encodeFrame(currentSession, pcmData);

      if (encodedFrame && encodedFrame.length > 0) {
        sendFrame(currentSession, encodedFrame);
      } else if (pcmCounter <= 5) {
        console.log('[Offscreen] Encoder returned empty frame (normal during startup)');
      }
    };

    // Handle track ended (tab closed)
    mediaStream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (currentSession && !currentSession.stopped) {
        chrome.runtime
          .sendMessage({
            type: 'CAST_ENDED',
            reason: 'tab_closed',
            streamId: currentSession.streamId,
          })
          .catch(() => {
            // Background may be suspended
          });
        // Handle the promise to prevent unhandled rejection
        stopSession(currentSession).catch(() => {
          // Ignore stop errors during track ended cleanup
        });
      }
    });

    startHeartbeat(session);

    console.log('[Offscreen] Audio capture started successfully', {
      streamId,
      codec: session.codec,
      sampleRate: audioContext.sampleRate,
    });

    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
  }
}

async function handleStop(message: OffscreenStopMessage): Promise<{ success: boolean }> {
  if (currentSession && currentSession.streamId === message.streamId) {
    await stopSession(currentSession);
    currentSession = null;
  }
  return { success: true };
}

async function handlePause(message: OffscreenPauseMessage): Promise<{ success: boolean }> {
  if (!currentSession || currentSession.streamId !== message.streamId) {
    return { success: false };
  }

  if (currentSession.paused) {
    return { success: true }; // Already paused
  }

  currentSession.paused = true;

  // Disconnect source from worklet to stop processing audio
  // This stops encoding/sending but keeps everything else alive
  currentSession.sourceNode?.disconnect();

  console.log('[Offscreen] Session paused');
  return { success: true };
}

async function handleResume(message: OffscreenResumeMessage): Promise<{ success: boolean }> {
  if (!currentSession || currentSession.streamId !== message.streamId) {
    return { success: false };
  }

  if (!currentSession.paused) {
    return { success: true }; // Already running
  }

  // Reconnect source to worklet
  if (currentSession.sourceNode && currentSession.workletNode) {
    currentSession.sourceNode.connect(currentSession.workletNode);
  }

  currentSession.paused = false;

  console.log('[Offscreen] Session resumed');
  return { success: true };
}

async function stopSession(session: StreamSession): Promise<void> {
  session.stopped = true;
  stopHeartbeat(session);

  // Flush and close encoder
  if (session.encoder) {
    try {
      const finalFrame = session.encoder.finalize();
      if (
        finalFrame &&
        finalFrame.length > 0 &&
        controlConnection?.ws?.readyState === WebSocket.OPEN
      ) {
        controlConnection.ws.send(finalFrame);
      }
    } catch {
      // Ignore encoder finalization errors
    }
    // Close AAC encoder (MP3 encoder doesn't have close method)
    if (session.encoder.close) {
      try {
        session.encoder.close();
      } catch {
        // Ignore encoder close errors
      }
    }
  }

  // Note: Don't close controlConnection - it's shared and handles its own lifecycle

  // Disconnect audio nodes
  try {
    session.workletNode?.disconnect();
  } catch {
    // Already disconnected
  }

  // Close audio context - may throw AbortError if already closing
  try {
    await session.audioContext?.close();
  } catch {
    // Ignore AbortError or other close errors - context may already be closed
  }

  // Stop media tracks - always do this regardless of above errors
  session.mediaStream?.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      // Track may already be stopped
    }
  });
}

// Counter for logging - log every 100th frame to avoid spam
let frameCounter = 0;

function sendFrame(session: StreamSession, frame: Uint8Array): void {
  if (controlConnection?.ws?.readyState === WebSocket.OPEN) {
    frameCounter++;
    if (frameCounter === 1 || frameCounter % 100 === 0) {
      console.log(`[Offscreen] Sending frame #${frameCounter} (${frame.length} bytes)`);
    }
    controlConnection.ws.send(frame);
  } else {
    // Buffer frames during reconnection
    session.frameBuffer.push(frame);
    if (session.frameBuffer.length > MAX_BUFFER_FRAMES) {
      session.frameBuffer.shift();
    }
    console.warn('[Offscreen] WebSocket not open, buffering frame');
  }
}

function encodeFrame(
  session: StreamSession,
  pcmData: { left: Float32Array; right: Float32Array }
): Uint8Array | null {
  if (!session.encoder) return null;

  // wasm-media-encoders expects interleaved Float32Array samples
  return session.encoder.encode([pcmData.left, pcmData.right]);
}

function startHeartbeat(session: StreamSession): void {
  stopHeartbeat(session);
  session.heartbeatTimer = setInterval(() => {
    if (session.stopped) {
      stopHeartbeat(session);
      return;
    }

    chrome.runtime
      .sendMessage({
        type: 'OFFSCREEN_HEARTBEAT',
        streamId: session.streamId,
      })
      .catch(() => {
        // Background may be suspended - this is fine, heartbeat is just a keep-alive
      });
  }, 3000);
}

function stopHeartbeat(session: StreamSession): void {
  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }
}

// Fallback: close WebSocket gracefully when offscreen document is being destroyed
window.addEventListener('beforeunload', () => {
  disconnectControlWebSocket();
});
