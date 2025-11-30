import type {
  OffscreenStartMessage,
  OffscreenStopMessage,
  QualityPreset,
} from '@thaumic-cast/shared';
import { createMp3Encoder } from 'wasm-media-encoders';

// Use the actual encoder type from the library
type WasmEncoder = Awaited<ReturnType<typeof createMp3Encoder>>;

interface StreamSession {
  streamId: string;
  audioContext: AudioContext | null;
  mediaStream: MediaStream | null;
  workletNode: AudioWorkletNode | null;
  websocket: WebSocket | null;
  encoder: WasmEncoder | null;
  reconnectAttempts: number;
  frameBuffer: Uint8Array[];
  stopped: boolean;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

// wasm-media-encoders expects specific CBR bitrate values
type Mp3Bitrate = 128 | 192 | 320;
type Channels = 1 | 2;

const QUALITY_SETTINGS: Record<
  QualityPreset,
  { bitrate: Mp3Bitrate; sampleRate: 44100 | 48000; channels: Channels }
> = {
  low: { bitrate: 128, sampleRate: 44100, channels: 2 },
  medium: { bitrate: 192, sampleRate: 48000, channels: 2 },
  high: { bitrate: 320, sampleRate: 48000, channels: 2 },
};

const MAX_RECONNECT_ATTEMPTS = 10;
const MAX_BUFFER_FRAMES = 60; // ~2 seconds

let currentSession: StreamSession | null = null;

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
});

// Signal to background that offscreen is ready to receive messages
console.log('[Offscreen] Ready');
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });

async function handleStart(
  message: OffscreenStartMessage
): Promise<{ success: boolean; error?: string }> {
  const { streamId, mediaStreamId, quality, ingestUrl } = message;

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

    // Create audio context
    const audioContext = new AudioContext({ sampleRate: settings.sampleRate });

    // Load audio worklet from static file (blob URLs blocked by MV3 CSP)
    await audioContext.audioWorklet.addModule(chrome.runtime.getURL('audio-worklet.js'));

    // Create audio graph
    const source = audioContext.createMediaStreamSource(mediaStream);
    const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

    source.connect(workletNode);

    // Initialize encoder
    const encoder = await createMp3Encoder();
    encoder.configure({
      channels: settings.channels,
      sampleRate: settings.sampleRate,
      bitrate: settings.bitrate,
    });

    // Create session
    const session: StreamSession = {
      streamId,
      audioContext,
      mediaStream,
      workletNode,
      websocket: null,
      encoder,
      reconnectAttempts: 0,
      frameBuffer: [],
      stopped: false,
      heartbeatTimer: null,
    };

    currentSession = session;

    // Connect WebSocket
    connectWebSocket(session, ingestUrl);

    // Handle PCM data from worklet
    workletNode.port.onmessage = (event) => {
      if (!currentSession || currentSession.stopped) return;

      const pcmData = event.data as { left: Float32Array; right: Float32Array };
      const mp3Frame = encodeFrame(currentSession, pcmData);

      if (mp3Frame && mp3Frame.length > 0) {
        sendFrame(currentSession, mp3Frame);
      }
    };

    // Handle track ended (tab closed)
    mediaStream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (currentSession && !currentSession.stopped) {
        chrome.runtime.sendMessage({
          type: 'CAST_ENDED',
          reason: 'tab_closed',
          streamId: currentSession.streamId,
        });
        stopSession(currentSession);
      }
    });

    startHeartbeat(session);

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

async function stopSession(session: StreamSession): Promise<void> {
  session.stopped = true;
  stopHeartbeat(session);

  // Flush encoder
  if (session.encoder) {
    const finalFrame = session.encoder.finalize();
    if (finalFrame && finalFrame.length > 0 && session.websocket?.readyState === WebSocket.OPEN) {
      session.websocket.send(finalFrame);
    }
  }

  // Close WebSocket
  session.websocket?.close();

  // Stop audio
  session.workletNode?.disconnect();
  await session.audioContext?.close();

  // Stop media tracks
  session.mediaStream?.getTracks().forEach((track) => track.stop());
}

function connectWebSocket(session: StreamSession, url: string): void {
  if (session.stopped) return;

  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';

  ws.onopen = () => {
    console.log('[Offscreen] WebSocket connected');
    session.reconnectAttempts = 0;

    // Send buffered frames
    for (const frame of session.frameBuffer) {
      ws.send(frame);
    }
    session.frameBuffer = [];
  };

  ws.onclose = () => {
    if (session.stopped) return;

    console.log('[Offscreen] WebSocket closed, attempting reconnect...');
    attemptReconnect(session, url);
  };

  ws.onerror = (error) => {
    console.error('[Offscreen] WebSocket error:', error);
  };

  session.websocket = ws;
}

function attemptReconnect(session: StreamSession, url: string): void {
  if (session.stopped) return;

  session.reconnectAttempts++;

  if (session.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.error('[Offscreen] Max reconnect attempts exceeded');
    chrome.runtime.sendMessage({
      type: 'CAST_ERROR',
      reason: 'connection_lost',
    });
    stopSession(session);
    return;
  }

  const delay = Math.min(500 * Math.pow(2, session.reconnectAttempts - 1), 5000);
  setTimeout(() => connectWebSocket(session, url), delay);
}

function sendFrame(session: StreamSession, frame: Uint8Array): void {
  if (session.websocket?.readyState === WebSocket.OPEN) {
    session.websocket.send(frame);
  } else {
    // Buffer frames during reconnection
    session.frameBuffer.push(frame);
    if (session.frameBuffer.length > MAX_BUFFER_FRAMES) {
      session.frameBuffer.shift();
    }
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

    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_HEARTBEAT',
      streamId: session.streamId,
    });
  }, 3000);
}

function stopHeartbeat(session: StreamSession): void {
  if (session.heartbeatTimer) {
    clearInterval(session.heartbeatTimer);
    session.heartbeatTimer = null;
  }
}
