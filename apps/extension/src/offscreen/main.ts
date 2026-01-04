import { createLogger } from '@thaumic-cast/shared';
import {
  createAudioRingBuffer,
  HEADER_SIZE,
  RING_BUFFER_SIZE,
  RING_BUFFER_MASK,
} from './ring-buffer';
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
  StreamMetadata,
  SonosStateSnapshot,
  WsControlCommand,
  isSupportedSampleRate,
  getNearestSupportedSampleRate,
} from '@thaumic-cast/protocol';
import i18n from '../lib/i18n';

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
      // Network broadcast events (separate category)
      else if (message.category === 'network') {
        chrome.runtime
          .sendMessage({
            type: 'NETWORK_EVENT',
            payload: message,
          })
          .catch(() => {
            // Background may be suspended
          });
      }
      // Topology broadcast events (discovery results)
      else if (message.category === 'topology') {
        chrome.runtime
          .sendMessage({
            type: 'TOPOLOGY_EVENT',
            payload: message,
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

/** Interval for checking worklet heartbeat (ms). */
const WORKLET_HEARTBEAT_CHECK_INTERVAL = 2000;

/** Maximum time without worklet heartbeat before logging warning (ms). */
const WORKLET_HEARTBEAT_TIMEOUT = 3000;

/** Interval between repeated stall warnings during prolonged stalls (ms). */
const STALL_LOG_BACKOFF_INTERVAL = 5000;

/**
 * Manages an active capture session from a browser tab.
 *
 * The real-time audio path runs entirely in a Worker:
 *   AudioWorklet → SharedArrayBuffer → Worker (drain + encode + WebSocket send)
 *
 * Main thread only handles:
 *   - Audio pipeline setup (AudioContext, Worklet)
 *   - Worker lifecycle management
 *   - Receiving status updates from Worker
 */
class StreamSession {
  private audioContext: AudioContext;
  private consumerWorker: Worker | null = null;
  private ringBuffer: SharedArrayBuffer;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private silentGainNode: GainNode | null = null;

  /** Last time we received a heartbeat from the worklet. */
  private lastWorkletHeartbeat = 0;

  /** Timer for checking worklet heartbeat. */
  private heartbeatCheckTimer: ReturnType<typeof setInterval> | null = null;

  /** Time when the current stall started (0 if not stalled). */
  private stallStartTime = 0;

  /** Time of last stall warning log (for backoff). */
  private lastStallLogTime = 0;

  /** Unique ID assigned by the server for this stream. */
  public streamId: string | null = null;

  /** Whether the stream has received STREAM_READY from the server. */
  private isReady = false;

  /** Resolver for the stream ready promise. */
  private streamReadyResolve: (() => void) | null = null;

  /** Promise that resolves when STREAM_READY is received. */
  private streamReadyPromise: Promise<void>;

  /** Resolver for the connection promise. */
  private connectionResolver: {
    resolve: (streamId: string) => void;
    reject: (error: Error) => void;
  } | null = null;

  /** Pending playback request resolver for multi-group results. */
  private playbackResultsResolver: {
    resolve: (
      results: Array<{
        speakerIp: string;
        success: boolean;
        streamUrl?: string;
        error?: string;
      }>,
    ) => void;
    reject: (error: Error) => void;
  } | null = null;

  // Cumulative session stats for health reporting
  private totalProducerDrops = 0;
  private totalCatchUpDrops = 0;
  private totalConsumerDrops = 0;
  private totalUnderflows = 0;

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
    this.audioContext = new AudioContext({
      sampleRate: encoderConfig.sampleRate,
      latencyHint: 'playback',
    });

    // Check if browser honored our sample rate request
    const actualSampleRate = this.audioContext.sampleRate;
    if (actualSampleRate !== encoderConfig.sampleRate) {
      if (isSupportedSampleRate(actualSampleRate)) {
        // Browser gave us a different but supported rate
        log.warn(
          `Sample rate mismatch: requested ${encoderConfig.sampleRate}Hz, got ${actualSampleRate}Hz.`,
        );
        this.encoderConfig = {
          ...encoderConfig,
          sampleRate: actualSampleRate,
        };
      } else {
        // Non-supported rate (e.g., 96kHz from pro audio interface)
        // TODO: Implement resampling to nearest supported rate
        const targetRate = getNearestSupportedSampleRate(actualSampleRate);
        log.warn(
          `Non-standard sample rate: ${actualSampleRate}Hz. ` +
            `Would need resampling to ${targetRate}Hz (not yet implemented).`,
        );
        // For now, proceed with the target rate and hope AudioContext resamples
        this.encoderConfig = {
          ...encoderConfig,
          sampleRate: targetRate,
        };
      }
    }

    this.ringBuffer = createAudioRingBuffer();

    this.streamReadyPromise = new Promise<void>((resolve) => {
      this.streamReadyResolve = resolve;
    });
  }

  /**
   * Initializes the session: sets up audio pipeline and starts the Worker.
   */
  async init(): Promise<void> {
    try {
      await this.setupAudioPipeline();
      await this.startWorker();
    } catch (err) {
      log.error('Failed to initialize session', err);
      this.stop();
      throw err;
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

    this.workletNode.port.postMessage({
      type: 'INIT_BUFFER',
      buffer: this.ringBuffer,
      bufferSize: RING_BUFFER_SIZE,
      bufferMask: RING_BUFFER_MASK,
      headerSize: HEADER_SIZE,
      sampleRate: this.encoderConfig.sampleRate,
      channels: this.encoderConfig.channels,
    });

    // Listen for heartbeat messages from the worklet
    this.workletNode.port.onmessage = (event) => {
      if (event.data.type === 'HEARTBEAT') {
        const now = performance.now();
        this.lastWorkletHeartbeat = now;

        // Log recovery if we were stalled
        if (this.stallStartTime > 0) {
          const stallDuration = (now - this.stallStartTime) / 1000;
          log.info(`⚡ AudioWorklet resumed after ${stallDuration.toFixed(1)}s stall`);
          this.stallStartTime = 0;
          this.lastStallLogTime = 0;
        }
      }
    };

    this.sourceNode.connect(this.workletNode);

    // Connect to destination through a silent gain node to ensure audio processing
    this.silentGainNode = this.audioContext.createGain();
    this.silentGainNode.gain.value = 0;
    this.workletNode.connect(this.silentGainNode);
    this.silentGainNode.connect(this.audioContext.destination);

    // Monitor AudioContext state changes (suspension, interruption, etc.)
    this.audioContext.onstatechange = () => {
      const state = this.audioContext.state;
      log.warn(`🔊 AudioContext state changed: ${state}`);

      if (state === 'suspended') {
        log.warn('⚠️ AudioContext suspended - attempting auto-resume...');
        this.audioContext
          .resume()
          .then(() => {
            log.info(`✅ AudioContext resumed, new state: ${this.audioContext.state}`);
          })
          .catch((err) => {
            log.error('❌ Failed to resume AudioContext:', err);
          });
      } else if (state === 'closed') {
        log.error('❌ AudioContext closed unexpectedly');
      }
    };

    if (this.audioContext.state === 'suspended') {
      log.info('AudioContext suspended, resuming...');
      await this.audioContext.resume();
    }
    log.info(`AudioContext state: ${this.audioContext.state}`);

    // Set up MediaStream track monitoring
    const audioTracks = this.mediaStream.getAudioTracks();
    log.info(`MediaStream has ${audioTracks.length} audio track(s)`);

    for (const track of audioTracks) {
      log.info(
        `Audio track: ${track.label}, enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`,
      );

      // Monitor track mute state changes
      track.onmute = () => {
        log.warn(`🔇 Audio track MUTED: ${track.label || 'unnamed'}`);
      };

      track.onunmute = () => {
        log.info(`🔊 Audio track UNMUTED: ${track.label || 'unnamed'}`);
      };

      // Monitor track ending (tab closed, permission revoked, etc.)
      track.onended = () => {
        log.warn(
          `⏹️ Audio track ENDED: ${track.label || 'unnamed'}, readyState=${track.readyState}`,
        );
      };
    }

    // Initialize heartbeat tracking and start checker
    this.lastWorkletHeartbeat = performance.now();
    this.startHeartbeatChecker();
  }

  /**
   * Starts the periodic heartbeat checker for the AudioWorklet.
   */
  private startHeartbeatChecker(): void {
    this.stopHeartbeatChecker();

    this.heartbeatCheckTimer = setInterval(() => {
      const now = performance.now();
      const timeSinceHeartbeat = now - this.lastWorkletHeartbeat;

      if (timeSinceHeartbeat > WORKLET_HEARTBEAT_TIMEOUT) {
        // Start tracking stall if not already
        if (this.stallStartTime === 0) {
          this.stallStartTime = now - timeSinceHeartbeat;
        }

        const stallDuration = (now - this.stallStartTime) / 1000;
        const timeSinceLastLog = now - this.lastStallLogTime;

        // Log on first detection, then periodically with backoff
        if (this.lastStallLogTime === 0 || timeSinceLastLog >= STALL_LOG_BACKOFF_INTERVAL) {
          log.warn(
            `⚠️ AudioWorklet stall: no heartbeat for ${stallDuration.toFixed(1)}s. ` +
              `AudioContext state: ${this.audioContext.state}`,
          );
          this.lastStallLogTime = now;

          // Try to resume if suspended
          if (this.audioContext.state === 'suspended') {
            log.info('Attempting to resume suspended AudioContext...');
            this.audioContext.resume().catch((err) => {
              log.error('Failed to resume AudioContext:', err);
            });
          }
        }
      }
    }, WORKLET_HEARTBEAT_CHECK_INTERVAL);
  }

  /**
   * Stops the heartbeat checker timer.
   */
  private stopHeartbeatChecker(): void {
    if (this.heartbeatCheckTimer) {
      clearInterval(this.heartbeatCheckTimer);
      this.heartbeatCheckTimer = null;
    }
  }

  /**
   * Starts the consumer Worker which handles encoding and WebSocket communication.
   */
  private async startWorker(): Promise<void> {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';

    this.consumerWorker = new Worker(new URL('./audio-consumer.worker.ts', import.meta.url), {
      type: 'module',
    });

    // Create promise for connection
    const connectionPromise = new Promise<string>((resolve, reject) => {
      this.connectionResolver = { resolve, reject };
    });

    // Handle messages from the Worker
    this.consumerWorker.onmessage = (event) => {
      const msg = event.data;

      switch (msg.type) {
        case 'CONNECTED':
          log.info(`Worker connected, streamId: ${msg.streamId}`);
          this.streamId = msg.streamId;
          this.connectionResolver?.resolve(msg.streamId);
          this.connectionResolver = null;
          break;

        case 'DISCONNECTED':
          log.warn(`Worker disconnected: ${msg.reason}`);
          break;

        case 'ERROR':
          log.error(`Worker error: ${msg.message}`);
          this.connectionResolver?.reject(new Error(msg.message));
          this.connectionResolver = null;
          this.playbackResultsResolver?.reject(new Error(msg.message));
          this.playbackResultsResolver = null;
          break;

        case 'STREAM_READY':
          log.info(`Stream ready with ${msg.bufferSize} frames buffered`);
          this.isReady = true;
          this.streamReadyResolve?.();
          break;

        case 'PLAYBACK_STARTED':
          // Legacy single-speaker response - convert to array format
          log.info(`Playback started on ${msg.speakerIp}`);
          this.playbackResultsResolver?.resolve([
            {
              speakerIp: msg.speakerIp,
              success: true,
              streamUrl: msg.streamUrl,
            },
          ]);
          this.playbackResultsResolver = null;
          break;

        case 'PLAYBACK_RESULTS':
          // Multi-speaker results
          log.info(
            `Playback results: ${msg.results.filter((r: { success: boolean }) => r.success).length}/${msg.results.length} speakers started`,
          );
          this.playbackResultsResolver?.resolve(msg.results);
          this.playbackResultsResolver = null;
          break;

        case 'PLAYBACK_ERROR':
          log.error(`Playback error: ${msg.message}`);
          this.playbackResultsResolver?.reject(new Error(msg.message));
          this.playbackResultsResolver = null;
          break;

        case 'STATS':
          // Accumulate drops for session health reporting
          this.totalProducerDrops += msg.producerDroppedSamples ?? 0;
          this.totalCatchUpDrops += msg.catchUpDroppedSamples ?? 0;
          this.totalConsumerDrops += msg.consumerDroppedFrames ?? 0;
          this.totalUnderflows += msg.underflows ?? 0;

          if (msg.producerDroppedSamples > 0) {
            log.warn(
              `Audio ring buffer overflow (${msg.producerDroppedSamples} samples)! Encoder or network too slow.`,
            );
          }
          if (msg.consumerDroppedFrames > 0) {
            log.warn(`Dropped ${msg.consumerDroppedFrames} frame(s) due to backpressure`);
          }
          if (msg.catchUpDroppedSamples > 0) {
            log.warn(`Catch-up dropped ${msg.catchUpDroppedSamples} samples to bound latency`);
          }
          // Underflows indicate source starvation (worklet not producing data)
          if (msg.underflows > 0) {
            log.warn(
              `⚠️ ${msg.underflows} underflow(s) detected - audio source may be stalled or throttled`,
            );
          }
          log.info(
            `[DIAG] wakeups=${msg.wakeups} avgSamples=${msg.avgSamplesPerWake.toFixed(0)} ` +
              `encodeQueue=${msg.encodeQueueSize} wsBuffer=${msg.wsBufferedAmount} ` +
              `underflows=${msg.underflows} producerDrops=${msg.producerDroppedSamples} ` +
              `catchUpDrops=${msg.catchUpDroppedSamples} consumerDrops=${msg.consumerDroppedFrames}`,
          );
          break;
      }
    };

    this.consumerWorker.onerror = (error) => {
      log.error('Audio consumer worker error:', error);
      this.connectionResolver?.reject(new Error('Worker error'));
      this.connectionResolver = null;
    };

    // Initialize the Worker with all config
    this.consumerWorker.postMessage({
      type: 'INIT',
      sab: this.ringBuffer,
      bufferSize: RING_BUFFER_SIZE,
      bufferMask: RING_BUFFER_MASK,
      headerSize: HEADER_SIZE,
      sampleRate: this.encoderConfig.sampleRate,
      encoderConfig: this.encoderConfig,
      wsUrl,
    });

    // Wait for connection
    await connectionPromise;
  }

  /**
   * Returns session health data for reporting.
   * @returns Health data including drop stats and encoder config
   */
  public getHealthData(): {
    encoderConfig: EncoderConfig;
    hadDrops: boolean;
    totalProducerDrops: number;
    totalCatchUpDrops: number;
    totalConsumerDrops: number;
    totalUnderflows: number;
  } {
    // Include underflows in hadDrops - they indicate audio source issues
    const hadDrops =
      this.totalProducerDrops > 0 ||
      this.totalCatchUpDrops > 0 ||
      this.totalConsumerDrops > 0 ||
      this.totalUnderflows > 0;

    return {
      encoderConfig: this.encoderConfig,
      hadDrops,
      totalProducerDrops: this.totalProducerDrops,
      totalCatchUpDrops: this.totalCatchUpDrops,
      totalConsumerDrops: this.totalConsumerDrops,
      totalUnderflows: this.totalUnderflows,
    };
  }

  /**
   * Stops the session and releases all resources.
   */
  public stop(): void {
    this.stopHeartbeatChecker();

    if (this.consumerWorker) {
      this.consumerWorker.postMessage({ type: 'STOP' });
      this.consumerWorker.terminate();
      this.consumerWorker = null;
    }

    // Remove event listeners before disconnecting
    if (this.audioContext) {
      this.audioContext.onstatechange = null;
    }

    // Remove track event listeners
    for (const track of this.mediaStream.getAudioTracks()) {
      track.onmute = null;
      track.onunmute = null;
      track.onended = null;
    }

    this.sourceNode?.disconnect();
    this.workletNode?.disconnect();
    this.silentGainNode?.disconnect();
    this.audioContext.close().catch(() => {});
    this.mediaStream.getTracks().forEach((t) => t.stop());
  }

  /**
   * Updates metadata for the active stream.
   * @param metadata - The track metadata to send to the server
   */
  public updateMetadata(metadata: StreamMetadata): void {
    this.consumerWorker?.postMessage({
      type: 'METADATA_UPDATE',
      metadata,
    });
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
   * Starts playback on multiple Sonos speakers.
   * Must be called after the stream is ready (waitForReady resolved).
   *
   * @param speakerIps - IP addresses of the Sonos speakers
   * @param metadata - Optional initial metadata to display on Sonos
   * @param timeoutMs - Timeout in milliseconds
   * @returns Promise resolving with per-speaker playback results
   * @throws Error if all playback attempts fail or timeout
   */
  public async startPlayback(
    speakerIps: string[],
    metadata?: StreamMetadata,
    timeoutMs = 15000,
  ): Promise<
    Array<{
      speakerIp: string;
      success: boolean;
      streamUrl?: string;
      error?: string;
    }>
  > {
    if (!this.consumerWorker) {
      throw new Error('Worker not running');
    }

    if (!this.isReady) {
      throw new Error('Stream not ready - call waitForReady() first');
    }

    const responsePromise = new Promise<
      Array<{
        speakerIp: string;
        success: boolean;
        streamUrl?: string;
        error?: string;
      }>
    >((resolve, reject) => {
      this.playbackResultsResolver = { resolve, reject };
    });

    this.consumerWorker.postMessage({
      type: 'START_PLAYBACK',
      speakerIps,
      metadata,
    });

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        this.playbackResultsResolver = null;
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
      sendResponse({ success: false, error: i18n.t('error_max_sessions') });
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
      // Get health data before stopping
      const healthData = session.getHealthData();

      // Send session health to background for config learning
      chrome.runtime
        .sendMessage({
          type: 'SESSION_HEALTH',
          payload: {
            tabId,
            ...healthData,
          },
        })
        .catch((err) => {
          log.warn('Failed to send SESSION_HEALTH:', err);
        });

      session.stop();
      activeSessions.delete(tabId);
    }
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'START_PLAYBACK') {
    const { tabId, speakerIps, metadata } = (msg as StartPlaybackMessage).payload;
    const session = activeSessions.get(tabId);

    if (!session) {
      const response: StartPlaybackResponse = {
        success: false,
        results: [],
        error: `No active session for tab ${tabId}`,
      };
      sendResponse(response);
      return true;
    }

    // Wait for stream to be ready, then start playback with initial metadata
    session
      .waitForReady()
      .then(() => session.startPlayback(speakerIps, metadata))
      .then((results) => {
        // Consider success if at least one speaker started
        const anySuccess = results.some((r) => r.success);
        const response: StartPlaybackResponse = {
          success: anySuccess,
          results,
        };
        sendResponse(response);
      })
      .catch((err) => {
        const response: StartPlaybackResponse = {
          success: false,
          results: [],
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
