import { createLogger } from '@thaumic-cast/shared';
import { createAudioRingBuffer, HEADER_SIZE, RING_BUFFER_SIZE } from './ring-buffer';
import {
  ExtensionMessage,
  StartCaptureMessage,
  StopCaptureMessage,
  StartPlaybackMessage,
  StartPlaybackResponse,
  OffscreenMetadataMessage,
  WsConnectMessage,
  WsStatusResponse,
  SyncSonosStateMessage,
} from '../lib/messages';
import {
  EncoderConfig,
  WsMessageSchema,
  StreamMetadata,
  SonosStateSnapshot,
  WsControlCommand,
  WsMessage,
} from '@thaumic-cast/protocol';
import { createEncoder, type AudioEncoder } from './encoders';

const log = createLogger('Offscreen');

// ─────────────────────────────────────────────────────────────────────────────
// Control WebSocket (for state monitoring, events, and commands)
// ─────────────────────────────────────────────────────────────────────────────

const MAX_RECONNECT_ATTEMPTS = 10;
/** Heartbeat interval (5 seconds - server timeout is 10s) */
const CONTROL_HEARTBEAT_INTERVAL = 5000;

interface ControlConnection {
  ws: WebSocket | null;
  url: string;
  reconnectAttempts: number;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  heartbeatTimer: ReturnType<typeof setInterval> | null;
}

/** Control WebSocket connection state. */
let controlConnection: ControlConnection | null = null;

/** Cached Sonos state for service worker recovery. */
let cachedSonosState: SonosStateSnapshot | null = null;

/**
 * Connects the control WebSocket to the desktop app.
 * @param url - The WebSocket URL to connect to
 */
function connectControlWebSocket(url: string): void {
  if (controlConnection?.ws?.readyState === WebSocket.OPEN) {
    log.info('Control WS already connected');
    return;
  }

  log.info(`Connecting control WebSocket to: ${url}`);

  const ws = new WebSocket(url);

  controlConnection = {
    ws,
    url,
    reconnectAttempts: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
  };

  ws.onopen = () => {
    log.info('Control WebSocket connected');
    if (controlConnection) {
      controlConnection.reconnectAttempts = 0;
      // Start heartbeat to keep connection alive
      startControlHeartbeat();
    }
  };

  ws.onmessage = (event) => {
    if (typeof event.data !== 'string') return;

    try {
      const message = JSON.parse(event.data);
      log.debug('Control WS received:', message.type || message.category);

      // INITIAL_STATE on connect
      if (message.type === 'INITIAL_STATE') {
        cachedSonosState = message.payload as SonosStateSnapshot;
        chrome.runtime
          .sendMessage({
            type: 'WS_CONNECTED',
            state: cachedSonosState,
          })
          .catch(() => {
            // Background may be suspended
          });
      }
      // Broadcast events (sonos/stream)
      else if (message.category) {
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
      log.warn('Failed to parse control WS message:', err);
    }
  };

  ws.onclose = () => {
    log.warn('Control WebSocket closed');
    // Stop heartbeat
    stopControlHeartbeat();
    // Notify background immediately so UI updates
    chrome.runtime.sendMessage({ type: 'WS_DISCONNECTED' }).catch(() => {});
    attemptControlReconnect();
  };

  ws.onerror = (error) => {
    log.error('Control WebSocket error:', error);
  };
}

/**
 * Attempts to reconnect the control WebSocket with exponential backoff.
 */
function attemptControlReconnect(): void {
  if (!controlConnection) return;

  controlConnection.reconnectAttempts++;

  if (controlConnection.reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    log.error('Control WS max reconnect attempts exceeded');
    chrome.runtime.sendMessage({ type: 'WS_PERMANENTLY_DISCONNECTED' }).catch(() => {});
    controlConnection = null;
    return;
  }

  const delay = Math.min(500 * Math.pow(2, controlConnection.reconnectAttempts - 1), 5000);
  log.info(
    `Reconnecting control WS in ${delay}ms (attempt ${controlConnection.reconnectAttempts})...`,
  );

  controlConnection.reconnectTimer = setTimeout(() => {
    if (controlConnection) {
      connectControlWebSocket(controlConnection.url);
    }
  }, delay);
}

/**
 * Starts the control WebSocket heartbeat timer.
 */
function startControlHeartbeat(): void {
  stopControlHeartbeat(); // Clear any existing timer
  if (!controlConnection) return;

  controlConnection.heartbeatTimer = setInterval(() => {
    if (controlConnection?.ws?.readyState === WebSocket.OPEN) {
      controlConnection.ws.send(JSON.stringify({ type: 'HEARTBEAT' }));
    }
  }, CONTROL_HEARTBEAT_INTERVAL);
}

/**
 * Stops the control WebSocket heartbeat timer.
 */
function stopControlHeartbeat(): void {
  if (controlConnection?.heartbeatTimer) {
    clearInterval(controlConnection.heartbeatTimer);
    controlConnection.heartbeatTimer = null;
  }
}

/**
 * Disconnects the control WebSocket.
 */
function disconnectControlWebSocket(): void {
  if (!controlConnection) return;

  log.info('Disconnecting control WebSocket');

  stopControlHeartbeat();

  if (controlConnection.reconnectTimer) {
    clearTimeout(controlConnection.reconnectTimer);
  }

  controlConnection.ws?.close();
  controlConnection = null;
}

/**
 * Sends a control command via WebSocket.
 * @param command - The typed command to send (from @thaumic-cast/protocol)
 * @returns True if the command was sent successfully
 */
function sendControlCommand(command: WsControlCommand): boolean {
  if (!controlConnection?.ws || controlConnection.ws.readyState !== WebSocket.OPEN) {
    log.warn('Control WS not connected, cannot send command');
    return false;
  }

  controlConnection.ws.send(JSON.stringify(command));
  return true;
}

/**
 * Returns current WebSocket status for background queries.
 * @returns The current WebSocket status
 */
function getWsStatus(): WsStatusResponse {
  return {
    connected: controlConnection?.ws?.readyState === WebSocket.OPEN,
    url: controlConnection?.url,
    reconnectAttempts: controlConnection?.reconnectAttempts ?? 0,
    state: cachedSonosState ?? undefined,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio Streaming (StreamSession)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Chrome-specific constraints for tab audio capture.
 * Standard MediaStreamConstraints doesn't include these Chrome-specific properties.
 */
interface ChromeTabCaptureConstraints {
  audio: {
    mandatory: {
      chromeMediaSource: 'tab';
      chromeMediaSourceId: string;
    };
  };
  video: false;
}

/**
 * Connection states for the WebSocket.
 */
enum ConnectionState {
  IDLE = 'IDLE',
  CONNECTING = 'CONNECTING',
  CONNECTED = 'CONNECTED',
  DISCONNECTED = 'DISCONNECTED',
}

/**
 * Manages an active capture session from a browser tab using zero-copy shared memory.
 */
class StreamSession {
  private audioContext: AudioContext;
  private socket: WebSocket | null = null;
  private encoder: AudioEncoder | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readInterval: number | null = null;
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  private sharedBuffer: Int16Array;
  private control: Int32Array;
  private isStopping = false;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private silentGainNode: GainNode | null = null;
  private connectionState: ConnectionState = ConnectionState.IDLE;

  /** Unique ID assigned by the server for this stream. */
  public streamId: string | null = null;

  /** Whether the stream has received STREAM_READY from the server. */
  private isReady = false;

  /** Resolver for the stream ready promise. */
  private streamReadyResolve: (() => void) | null = null;

  /** Promise that resolves when STREAM_READY is received. */
  private streamReadyPromise: Promise<void>;

  /** Pending playback request resolver. */
  private playbackResolver: {
    resolve: (result: { speakerIp: string; streamUrl: string }) => void;
    reject: (error: Error) => void;
  } | null = null;

  /**
   * Creates a new StreamSession.
   * @param mediaStream - The captured media stream
   * @param encoderConfig - Audio encoder configuration
   * @param baseUrl - Desktop app base URL
   */
  constructor(
    private mediaStream: MediaStream,
    private encoderConfig: EncoderConfig,
    private baseUrl: string,
  ) {
    this.audioContext = new AudioContext({ sampleRate: encoderConfig.sampleRate });

    const sab = createAudioRingBuffer();
    this.sharedBuffer = new Int16Array(sab, HEADER_SIZE * 4);
    this.control = new Int32Array(sab, 0, HEADER_SIZE);

    // Create a promise that resolves when STREAM_READY is received
    this.streamReadyPromise = new Promise<void>((resolve) => {
      this.streamReadyResolve = resolve;
    });
  }

  /**
   * Initializes the session, establishes WebSocket connection, and starts capture.
   */
  async init(): Promise<void> {
    if (this.connectionState !== ConnectionState.IDLE) {
      log.warn('Session already initializing or connected');
      return;
    }

    try {
      await this.connect();
      await this.setupAudioPipeline();
      this.startReading();
      this.startHeartbeat();
    } catch (err) {
      log.error('Failed to initialize session', err);
      this.stop();
      throw err;
    }
  }

  /**
   * Establishes or re-establishes the WebSocket connection.
   */
  private async connect(): Promise<void> {
    if (this.isStopping) return;
    if (this.connectionState === ConnectionState.CONNECTED) return;

    this.connectionState = ConnectionState.CONNECTING;
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';
    log.info(`Connecting to WebSocket: ${wsUrl}`);

    const socket = new WebSocket(wsUrl);
    this.socket = socket;
    socket.binaryType = 'arraybuffer';

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        this.connectionState = ConnectionState.DISCONNECTED;
        reject(new Error('WebSocket connection timeout'));
      }, 5000);

      socket.onopen = () => {
        clearTimeout(timeout);
        this.connectionState = ConnectionState.CONNECTED;
        resolve();
      };
      socket.onerror = (e) => {
        clearTimeout(timeout);
        this.connectionState = ConnectionState.DISCONNECTED;
        log.error('WebSocket connection error', e);
        reject(e);
      };
    });

    // Handshake
    socket.send(
      JSON.stringify({
        type: 'HANDSHAKE',
        payload: { encoderConfig: this.encoderConfig },
      }),
    );

    this.streamId = await new Promise<string>((resolve, reject) => {
      const handshakeTimeout = setTimeout(() => {
        reject(new Error('Handshake timeout'));
      }, 5000);

      const messageHandler = (msg: MessageEvent) => {
        try {
          const raw = JSON.parse(msg.data);

          // Skip messages not meant for stream protocol:
          // - Broadcast events (have a 'category' field)
          // - INITIAL_STATE (sent to all connections on connect, handled by control WS)
          if ('category' in raw || raw.type === 'INITIAL_STATE') {
            return;
          }

          const parsed = WsMessageSchema.safeParse(raw);
          if (!parsed.success) {
            log.warn('Received malformed handshake response', parsed.error);
            return;
          }
          const data = parsed.data;
          if (data.type === 'HANDSHAKE_ACK') {
            clearTimeout(handshakeTimeout);
            socket.removeEventListener('message', messageHandler);
            // Discriminated union narrows payload type automatically
            resolve(data.payload.streamId);
          } else if (data.type === 'ERROR') {
            clearTimeout(handshakeTimeout);
            socket.removeEventListener('message', messageHandler);
            // Discriminated union narrows payload type automatically
            reject(new Error(data.payload.message || 'Server error during handshake'));
          }
        } catch (e) {
          log.warn('Failed to parse handshake response', e);
        }
      };

      socket.addEventListener('message', messageHandler);
    });

    this.reconnectAttempts = 0;
    log.info(`Session ${this.streamId} initialized`);

    // Register persistent message handler
    socket.onmessage = (msg) => {
      try {
        const raw = JSON.parse(msg.data);

        // Skip messages not meant for stream protocol:
        // - Broadcast events (have a 'category' field)
        // - INITIAL_STATE (sent to all connections on connect, handled by control WS)
        if ('category' in raw || raw.type === 'INITIAL_STATE') {
          return;
        }

        const parsed = WsMessageSchema.safeParse(raw);
        if (!parsed.success) {
          log.warn('Received malformed WebSocket message', parsed.error);
          return;
        }
        const data = parsed.data;
        this.handleWsMessage(data);
      } catch {
        // Not a JSON message or malformed
      }
    };

    socket.onclose = (event) => {
      this.connectionState = ConnectionState.DISCONNECTED;
      if (!this.isStopping) {
        log.warn(`WebSocket closed: ${event.code} ${event.reason}`);
        this.handleDisconnect();
      }
    };
  }

  /**
   * Handles unexpected WebSocket disconnections with retry logic.
   */
  private handleDisconnect(): void {
    if (this.isStopping) return;

    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 10000);
      log.info(`Attempting reconnection ${this.reconnectAttempts} in ${delay}ms...`);
      this.reconnectTimeout = setTimeout(() => this.connect(), delay);
    } else {
      log.error('Max reconnection attempts reached. Stopping session.');
      this.stop();
    }
  }

  /**
   * Sets up the Web Audio graph and loads the AudioWorklet.
   */
  private async setupAudioPipeline(): Promise<void> {
    const workletUrl = chrome.runtime.getURL('pcm-processor.js');
    await this.audioContext.audioWorklet.addModule(workletUrl);

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor');

    this.workletNode.port.postMessage({ type: 'INIT_BUFFER', buffer: this.control.buffer });
    this.sourceNode.connect(this.workletNode);

    // Connect to destination through a silent gain node to ensure audio processing.
    // Without this connection, Chrome may not drive audio through the worklet.
    this.silentGainNode = this.audioContext.createGain();
    this.silentGainNode.gain.value = 0;
    this.workletNode.connect(this.silentGainNode);
    this.silentGainNode.connect(this.audioContext.destination);

    // Ensure AudioContext is running (may be suspended by browser policy)
    if (this.audioContext.state === 'suspended') {
      log.info('AudioContext suspended, resuming...');
      await this.audioContext.resume();
    }
    log.info(`AudioContext state: ${this.audioContext.state}`);

    // Log media stream info for debugging
    const audioTracks = this.mediaStream.getAudioTracks();
    log.info(`MediaStream has ${audioTracks.length} audio track(s)`);
    if (audioTracks.length > 0) {
      const track = audioTracks[0];
      log.info(
        `Audio track: ${track.label}, enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`,
      );
    }

    this.encoder = await createEncoder(this.encoderConfig);
    log.info(`Using encoder: ${this.encoder.config.codec} @ ${this.encoder.config.bitrate}kbps`);
  }

  /**
   * Starts the high-performance reading loop using requestAnimationFrame.
   * Monitors the shared ring buffer for new samples and checks for overflows.
   */
  private startReading(): void {
    let totalSamplesRead = 0;
    let lastLogTime = Date.now();
    let frameCount = 0;

    const poll = () => {
      if (!this.streamId || this.isStopping) return;

      frameCount++;
      const writeIdx = Atomics.load(this.control, 0);
      const readIdx = Atomics.load(this.control, 1);

      // Check for overflow flag
      if (Atomics.load(this.control, 2) === 1) {
        log.warn('Audio ring buffer overflow! Network or Encoder is too slow.');
        Atomics.store(this.control, 2, 0);
      }

      if (readIdx !== writeIdx) {
        let samplesToRead = 0;
        if (writeIdx > readIdx) {
          samplesToRead = writeIdx - readIdx;
        } else {
          samplesToRead = RING_BUFFER_SIZE - readIdx + writeIdx;
        }

        if (samplesToRead > 0) {
          totalSamplesRead += samplesToRead;
          const data = new Int16Array(samplesToRead);

          if (readIdx + samplesToRead <= RING_BUFFER_SIZE) {
            data.set(this.sharedBuffer.subarray(readIdx, readIdx + samplesToRead));
          } else {
            const firstPart = RING_BUFFER_SIZE - readIdx;
            data.set(this.sharedBuffer.subarray(readIdx, RING_BUFFER_SIZE));
            data.set(this.sharedBuffer.subarray(0, samplesToRead - firstPart), firstPart);
          }

          if (this.encoder && this.socket?.readyState === WebSocket.OPEN) {
            const encoded = this.encoder.encode(data);
            if (encoded && this.socket.bufferedAmount < 1024 * 1024) {
              this.socket.send(encoded);
            }
          }

          Atomics.store(this.control, 1, (readIdx + samplesToRead) % RING_BUFFER_SIZE);
        }
      }

      // Log stats every 5 seconds
      const now = Date.now();
      if (now - lastLogTime >= 5000) {
        log.debug(
          `Audio stats: ${totalSamplesRead} samples read, ${frameCount} frames, writeIdx=${writeIdx}, readIdx=${readIdx}`,
        );
        lastLogTime = now;
      }

      this.readInterval = requestAnimationFrame(poll);
    };

    this.readInterval = requestAnimationFrame(poll);
  }

  /**
   * Starts the periodic heartbeat.
   */
  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'HEARTBEAT' }));
      }
    }, 5000);
  }

  /**
   * Stops the session and releases all hardware resources.
   */
  public stop(): void {
    this.isStopping = true;
    if (this.readInterval !== null) cancelAnimationFrame(this.readInterval);
    if (this.heartbeatInterval !== null) clearInterval(this.heartbeatInterval);
    if (this.reconnectTimeout !== null) clearTimeout(this.reconnectTimeout);

    // Flush and close encoder
    if (this.encoder) {
      const final = this.encoder.flush();
      if (final && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(final);
      }
      this.encoder.close();
      this.encoder = null;
    }

    if (this.socket) {
      this.socket.onopen = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      this.socket.close();
      this.socket = null;
    }

    this.sourceNode?.disconnect();
    this.workletNode?.disconnect();
    this.silentGainNode?.disconnect();
    this.audioContext.close().catch(() => {});
    this.mediaStream.getTracks().forEach((t) => t.stop());
  }

  /**
   * Updates metadata for the active stream.
   *
   * @param metadata - The track metadata to send to the server.
   */
  public updateMetadata(metadata: StreamMetadata): void {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(
        JSON.stringify({
          type: 'METADATA_UPDATE',
          payload: metadata,
        }),
      );
    }
  }

  /**
   * Handles incoming WebSocket messages from the server.
   * @param message - The parsed WebSocket message
   */
  private handleWsMessage(message: WsMessage): void {
    switch (message.type) {
      case 'HEARTBEAT_ACK':
        log.debug('Heartbeat acknowledged');
        break;

      case 'STREAM_READY':
        log.info(`Stream ready with ${message.payload.bufferSize} frames buffered`);
        this.isReady = true;
        this.streamReadyResolve?.();
        break;

      case 'PLAYBACK_STARTED':
        log.info(`Playback started on ${message.payload.speakerIp}`);
        this.playbackResolver?.resolve({
          speakerIp: message.payload.speakerIp,
          streamUrl: message.payload.streamUrl,
        });
        this.playbackResolver = null;
        break;

      case 'PLAYBACK_ERROR':
        log.error(`Playback failed: ${message.payload.message}`);
        this.playbackResolver?.reject(new Error(message.payload.message));
        this.playbackResolver = null;
        break;

      default:
        // Ignore other message types (HANDSHAKE_ACK, ERROR handled elsewhere)
        break;
    }
  }

  /**
   * Waits for the stream to be ready (first frame received by server).
   * @param timeoutMs - Maximum time to wait in milliseconds
   * @returns Promise that resolves when stream is ready
   * @throws Error if timeout expires before stream is ready
   */
  public async waitForReady(timeoutMs = 10000): Promise<void> {
    if (this.isReady) return;

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Timeout waiting for stream to be ready')), timeoutMs);
    });

    await Promise.race([this.streamReadyPromise, timeoutPromise]);
  }

  /**
   * Starts playback on a Sonos speaker via WebSocket.
   * Must be called after the stream is ready (waitForReady resolved).
   *
   * @param speakerIp - IP address of the Sonos speaker
   * @param timeoutMs
   * @returns Promise resolving with playback details
   * @throws Error if playback fails or times out
   */
  public async startPlayback(
    speakerIp: string,
    timeoutMs = 15000,
  ): Promise<{ speakerIp: string; streamUrl: string }> {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      throw new Error('WebSocket not connected');
    }

    if (!this.isReady) {
      throw new Error('Stream not ready - call waitForReady() first');
    }

    // Create promise for the response
    const responsePromise = new Promise<{ speakerIp: string; streamUrl: string }>(
      (resolve, reject) => {
        this.playbackResolver = { resolve, reject };
      },
    );

    // Send START_PLAYBACK command
    this.socket.send(
      JSON.stringify({
        type: 'START_PLAYBACK',
        payload: { speakerIp },
      }),
    );

    // Wait with timeout
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        this.playbackResolver = null;
        reject(new Error('Timeout waiting for playback to start'));
      }, timeoutMs);
    });

    return Promise.race([responsePromise, timeoutPromise]);
  }
}

/** Maximum number of parallel capture sessions allowed in offscreen. */
const MAX_OFFSCREEN_SESSIONS = 10;

/** Registry of active sessions by tab ID. */
const activeSessions = new Map<number, StreamSession>();

/**
 * Global message listener for offscreen document control.
 */
chrome.runtime.onMessage.addListener((msg: ExtensionMessage, _sender, sendResponse) => {
  // ─────────────────────────────────────────────────────────────────────────
  // WebSocket Control Messages
  // ─────────────────────────────────────────────────────────────────────────

  if (msg.type === 'WS_CONNECT') {
    const { url } = msg as WsConnectMessage;
    connectControlWebSocket(url);
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'WS_DISCONNECT') {
    disconnectControlWebSocket();
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'WS_RECONNECT') {
    const { url } = msg as { url?: string };
    if (url) {
      disconnectControlWebSocket();
      connectControlWebSocket(url);
    } else if (controlConnection) {
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

  if (msg.type === 'GET_WS_STATUS') {
    sendResponse(getWsStatus());
    return true;
  }

  if (msg.type === 'SYNC_SONOS_STATE') {
    const { state } = msg as SyncSonosStateMessage;
    cachedSonosState = state;
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'SET_VOLUME') {
    const { speakerIp, volume } = msg as { speakerIp: string; volume: number };
    // Desktop expects: { type: "SET_VOLUME", payload: { ip, volume } }
    const success = sendControlCommand({ type: 'SET_VOLUME', payload: { ip: speakerIp, volume } });
    sendResponse({ success });
    return true;
  }

  if (msg.type === 'SET_MUTE') {
    const { speakerIp, muted } = msg as { speakerIp: string; muted: boolean };
    // Desktop expects: { type: "SET_MUTE", payload: { ip, mute } }
    const success = sendControlCommand({
      type: 'SET_MUTE',
      payload: { ip: speakerIp, mute: muted },
    });
    sendResponse({ success });
    return true;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Audio Capture Messages
  // ─────────────────────────────────────────────────────────────────────────

  if (msg.type === 'START_CAPTURE') {
    const { tabId, mediaStreamId, encoderConfig, baseUrl } =
      msg.payload as StartCaptureMessage['payload'];

    // Prevent duplicate sessions for the same tab
    const existing = activeSessions.get(tabId);
    if (existing) {
      log.info(`Stopping existing session for tab ${tabId} before restart`);
      existing.stop();
      activeSessions.delete(tabId);
    }

    // Enforce global offscreen limit
    if (activeSessions.size >= MAX_OFFSCREEN_SESSIONS) {
      sendResponse({ success: false, error: 'Maximum offscreen session limit reached' });
      return true;
    }

    const constraints: ChromeTabCaptureConstraints = {
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: mediaStreamId,
        },
      },
      video: false,
    };

    // Chrome's getUserMedia accepts these non-standard constraints for tab capture
    navigator.mediaDevices
      .getUserMedia(constraints as MediaStreamConstraints)
      .then(async (stream) => {
        const session = new StreamSession(stream, encoderConfig, baseUrl);
        try {
          await session.init();
          activeSessions.set(tabId, session);
          sendResponse({ success: true, streamId: session.streamId });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          sendResponse({ success: false, error: message });
        }
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Capture failed: ${message}`);
        sendResponse({ success: false, error: message });
      });
    return true;
  }

  if (msg.type === 'STOP_CAPTURE') {
    const tabId = (msg as StopCaptureMessage).payload.tabId;
    const session = activeSessions.get(tabId);
    if (session) {
      session.stop();
      activeSessions.delete(tabId);
    }
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'START_PLAYBACK') {
    const { tabId, speakerIp } = (msg as StartPlaybackMessage).payload;
    const session = activeSessions.get(tabId);

    if (!session) {
      const response: StartPlaybackResponse = {
        success: false,
        error: `No active session for tab ${tabId}`,
      };
      sendResponse(response);
      return true;
    }

    // Wait for stream to be ready, then start playback
    session
      .waitForReady()
      .then(() => session.startPlayback(speakerIp))
      .then((result) => {
        const response: StartPlaybackResponse = {
          success: true,
          speakerIp: result.speakerIp,
          streamUrl: result.streamUrl,
        };
        sendResponse(response);
      })
      .catch((err) => {
        const response: StartPlaybackResponse = {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
        sendResponse(response);
      });
    return true;
  }

  if (msg.type === 'METADATA_UPDATE') {
    const { tabId, metadata } = (msg as OffscreenMetadataMessage).payload;
    const session = activeSessions.get(tabId);
    if (session) {
      session.updateMetadata(metadata);
    }
    sendResponse({ success: true });
    return true;
  }

  return false;
});

// Signal to background that offscreen is ready
log.info('Offscreen document ready');
chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' }).catch(() => {
  // Background may be suspended during startup
});

// Gracefully close WebSocket on document unload
globalThis.addEventListener('beforeunload', () => {
  disconnectControlWebSocket();
});
