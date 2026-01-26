/**
 * Stream Session Module
 *
 * Manages audio capture sessions from browser tabs.
 *
 * Responsibilities:
 * - Audio pipeline setup (AudioContext, Worklet)
 * - Worker lifecycle for encoding/streaming
 * - Session health tracking
 * - Playback coordination with Sonos
 *
 * Non-responsibilities:
 * - WebSocket control connection (handled by control-connection.ts)
 * - Message routing (handled by handlers.ts)
 */

import { createLogger } from '@thaumic-cast/shared';
import { createAudioRingBuffer, HEADER_SIZE } from './ring-buffer';
import type { EncoderConfig, OriginalGroup, StreamMetadata } from '@thaumic-cast/protocol';
import { isSupportedSampleRate } from '@thaumic-cast/protocol';
import { noop } from '../lib/noop';
import type { WorkerOutboundMessage } from './worker-messages';

const log = createLogger('Offscreen');

/** Interval for checking worklet heartbeat (ms). */
const WORKLET_HEARTBEAT_CHECK_INTERVAL = 2000;

/** Maximum time without worklet heartbeat before logging warning (ms). */
const WORKLET_HEARTBEAT_TIMEOUT = 3000;

/** Interval between repeated stall warnings during prolonged stalls (ms). */
const STALL_LOG_BACKOFF_INTERVAL = 5000;

/** Interval for logging healthy stats as a heartbeat (ms). */
const HEALTHY_STATS_LOG_INTERVAL = 30000;

/** Minimum gain value to keep Chrome's audio detection active without audible sound. */
const KEEP_AUDIBLE_GAIN = 0.0001;

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
export class StreamSession {
  private audioContext: AudioContext | null = null;
  private consumerWorker: Worker | null = null;
  // Ring buffer is created in setupAudioPipeline() after sample rate is verified
  private ringBuffer!: SharedArrayBuffer;
  private bufferSize!: number;
  private bufferMask!: number;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private outputGainNode: GainNode | null = null;

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
    resolve: (result: {
      results: Array<{
        speakerIp: string;
        success: boolean;
        streamUrl?: string;
        error?: string;
      }>;
      originalGroups?: OriginalGroup[];
    }) => void;
    reject: (error: Error) => void;
  } | null = null;

  // Cumulative session stats for health reporting
  private totalProducerDrops = 0;
  private totalCatchUpDrops = 0;
  private totalConsumerDrops = 0;
  private totalUnderflows = 0;
  private totalFrameQueueDrops = 0;

  /** Last time we logged diagnostics (for rate-limiting when healthy). */
  private lastDiagLogTime = 0;

  /** Callback when worker disconnects (for cleanup coordination). */
  private onDisconnected?: () => void;

  /** Whether to play audio at low volume to prevent Chrome throttling. */
  private keepTabAudible: boolean;

  /**
   * Creates a new StreamSession.
   * @param mediaStream - The captured media stream
   * @param encoderConfig - Audio encoder configuration
   * @param baseUrl - Desktop app base URL
   * @param onDisconnected - Optional callback when worker WebSocket disconnects
   * @param options - Additional session options
   * @param options.keepTabAudible - Play audio at low volume to prevent Chrome throttling
   */
  constructor(
    private mediaStream: MediaStream,
    private encoderConfig: EncoderConfig,
    private baseUrl: string,
    onDisconnected?: () => void,
    options?: { keepTabAudible?: boolean },
  ) {
    this.onDisconnected = onDisconnected;
    this.keepTabAudible = options?.keepTabAudible ?? false;

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
    // Create AudioContext - browser may give us a different sample rate than requested
    // Use 'interactive' for realtime mode to minimize latency on capable devices
    // Use 'playback' for quality mode to prioritize power efficiency
    this.audioContext = new AudioContext({
      sampleRate: this.encoderConfig.sampleRate,
      latencyHint: this.encoderConfig.latencyMode === 'realtime' ? 'interactive' : 'playback',
    });

    // Log actual latency for diagnostics - browser may not honor latencyHint
    const baseLatencyMs = (this.audioContext.baseLatency * 1000).toFixed(1);
    const outputLatencyMs = (this.audioContext.outputLatency * 1000).toFixed(1);
    log.info(
      `AudioContext created: baseLatency=${baseLatencyMs}ms, outputLatency=${outputLatencyMs}ms, state=${this.audioContext.state}`,
    );

    // Validate sample rate - browser may not honor our request
    const actualSampleRate = this.audioContext.sampleRate;
    if (actualSampleRate !== this.encoderConfig.sampleRate) {
      if (isSupportedSampleRate(actualSampleRate)) {
        // Browser gave us a different but supported rate - adjust config
        log.warn(
          `Sample rate: requested ${this.encoderConfig.sampleRate}Hz, got ${actualSampleRate}Hz`,
        );
        this.encoderConfig = { ...this.encoderConfig, sampleRate: actualSampleRate };
      } else {
        // Unsupported rate (e.g., 96kHz from pro audio interface) - reject
        log.error(
          `Unsupported sample rate: ${actualSampleRate}Hz. ` +
            `Supported rates: 48000, 44100, 32000, 24000, 22050, 16000, 11025, 8000`,
        );
        throw new Error('error_unsupported_sample_rate');
      }
    }

    // Create ring buffer now that we know the actual sample rate
    const ringBufferConfig = createAudioRingBuffer(
      this.encoderConfig.sampleRate,
      this.encoderConfig.channels,
      this.encoderConfig.latencyMode,
    );
    this.ringBuffer = ringBufferConfig.sab;
    this.bufferSize = ringBufferConfig.size;
    this.bufferMask = ringBufferConfig.mask;

    const workletUrl = chrome.runtime.getURL('pcm-processor.js');
    await this.audioContext.audioWorklet.addModule(workletUrl);

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
    // Always receive stereo input - the processor handles mono downmixing.
    // Using channelCount: 1 with 'discrete' interpretation would drop the right
    // channel before it reaches the processor, resulting in left-only output.
    this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor', {
      channelCount: 2,
      channelCountMode: 'explicit',
      channelInterpretation: 'discrete',
    });

    this.workletNode.port.postMessage({
      type: 'INIT_BUFFER',
      buffer: this.ringBuffer,
      bufferSize: this.bufferSize,
      bufferMask: this.bufferMask,
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
          log.info(`AudioWorklet resumed after ${stallDuration.toFixed(1)}s stall`);
          this.stallStartTime = 0;
          this.lastStallLogTime = 0;
        }
      }
    };

    this.sourceNode.connect(this.workletNode);

    // Only connect to destination when keepTabAudible is enabled
    // This plays audio at very low volume to prevent Chrome from throttling the tab
    // When disabled, the worklet is a dead-end (no output) which is fine for capture-only
    if (this.keepTabAudible) {
      this.outputGainNode = this.audioContext.createGain();
      this.outputGainNode.gain.value = KEEP_AUDIBLE_GAIN;
      this.workletNode.connect(this.outputGainNode);
      this.outputGainNode.connect(this.audioContext.destination);
      log.info('Keep tab audible enabled - playing audio at low volume to prevent throttling');
    }

    // Monitor AudioContext state changes (suspension, interruption, etc.)
    this.audioContext.onstatechange = () => {
      // Guard for TypeScript - audioContext is always set when this callback fires
      if (!this.audioContext) return;

      const state = this.audioContext.state;
      log.warn(`AudioContext state changed: ${state}`);

      if (state === 'suspended') {
        log.warn('AudioContext suspended - attempting auto-resume...');
        this.audioContext
          .resume()
          .then(() => {
            log.info(`AudioContext resumed, new state: ${this.audioContext?.state}`);
          })
          .catch((err) => {
            log.error('Failed to resume AudioContext:', err);
          });
      } else if (state === 'closed') {
        log.error('AudioContext closed unexpectedly');
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
        log.warn(`Audio track MUTED: ${track.label || 'unnamed'}`);
      };

      track.onunmute = () => {
        log.info(`Audio track UNMUTED: ${track.label || 'unnamed'}`);
      };

      // Monitor track ending (tab closed, permission revoked, etc.)
      track.onended = () => {
        log.warn(`Audio track ENDED: ${track.label || 'unnamed'}, readyState=${track.readyState}`);
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
      // Guard for TypeScript - audioContext is always set when heartbeat checker runs
      if (!this.audioContext) return;

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
            `AudioWorklet stall: no heartbeat for ${stallDuration.toFixed(1)}s. ` +
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
    this.consumerWorker.onmessage = (event: MessageEvent<WorkerOutboundMessage>) => {
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
          this.onDisconnected?.();
          this.stop();
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
          // Legacy single-speaker response - convert to new format
          log.info(`Playback started on ${msg.speakerIp}`);
          this.playbackResultsResolver?.resolve({
            results: [
              {
                speakerIp: msg.speakerIp,
                success: true,
                streamUrl: msg.streamUrl,
              },
            ],
          });
          this.playbackResultsResolver = null;
          break;

        case 'PLAYBACK_RESULTS':
          // Multi-speaker results
          log.info(
            `Playback results: ${msg.results.filter((r: { success: boolean }) => r.success).length}/${msg.results.length} speakers started`,
          );
          this.playbackResultsResolver?.resolve({
            results: msg.results,
            originalGroups: msg.originalGroups,
          });
          this.playbackResultsResolver = null;
          break;

        case 'PLAYBACK_ERROR':
          log.error(`Playback error: ${msg.message}`);
          this.playbackResultsResolver?.reject(new Error(msg.message));
          this.playbackResultsResolver = null;
          break;

        case 'STATS': {
          // Accumulate drops for session health reporting
          this.totalProducerDrops += msg.producerDroppedSamples ?? 0;
          this.totalCatchUpDrops += msg.catchUpDroppedSamples ?? 0;
          this.totalConsumerDrops += msg.consumerDroppedFrames ?? 0;
          this.totalUnderflows += msg.underflows ?? 0;
          this.totalFrameQueueDrops += msg.frameQueueOverflowDrops ?? 0;

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
              `${msg.underflows} underflow(s) detected - audio source may be stalled or throttled`,
            );
          }
          // Frame queue overflow indicates prolonged WebSocket backpressure in quality mode
          if (msg.frameQueueOverflowDrops > 0) {
            log.warn(
              `Frame queue overflow: dropped ${msg.frameQueueOverflowDrops} frame(s) - network too slow`,
            );
          }

          // Rate-limit diagnostic logs: log immediately on issues, otherwise every 30s
          const hasIssues =
            msg.underflows > 0 ||
            msg.producerDroppedSamples > 0 ||
            msg.catchUpDroppedSamples > 0 ||
            msg.consumerDroppedFrames > 0 ||
            msg.frameQueueOverflowDrops > 0;
          const now = performance.now();
          const timeSinceLastLog = now - this.lastDiagLogTime;

          if (hasIssues || timeSinceLastLog >= HEALTHY_STATS_LOG_INTERVAL) {
            log.info(
              `[DIAG] wakeups=${msg.wakeups} avgSamples=${msg.avgSamplesPerWake.toFixed(0)} ` +
                `encodeQueue=${msg.encodeQueueSize} wsBuffer=${msg.wsBufferedAmount} ` +
                `frameQueue=${msg.frameQueueSize ?? 0}/${((msg.frameQueueBytes ?? 0) / 1024).toFixed(0)}KB ` +
                `underflows=${msg.underflows} producerDrops=${msg.producerDroppedSamples} ` +
                `catchUpDrops=${msg.catchUpDroppedSamples} consumerDrops=${msg.consumerDroppedFrames} ` +
                `frameQueueDrops=${msg.frameQueueOverflowDrops ?? 0}`,
            );
            this.lastDiagLogTime = now;
          }
          break;
        }
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
      bufferSize: this.bufferSize,
      bufferMask: this.bufferMask,
      headerSize: HEADER_SIZE,
      sampleRate: this.encoderConfig.sampleRate,
      encoderConfig: this.encoderConfig,
      wsUrl,
    });

    // Wait for connection
    await connectionPromise;
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
    this.outputGainNode?.disconnect();
    this.audioContext?.close().catch(noop);
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
   * @param syncSpeakers
   * @param timeoutMs - Timeout in milliseconds
   * @returns Promise resolving with per-speaker playback results
   * @throws Error if all playback attempts fail or timeout
   */
  public async startPlayback(
    speakerIps: string[],
    metadata?: StreamMetadata,
    syncSpeakers: boolean = false,
    timeoutMs = 15000,
  ): Promise<{
    results: Array<{
      speakerIp: string;
      success: boolean;
      streamUrl?: string;
      error?: string;
    }>;
    originalGroups?: OriginalGroup[];
  }> {
    if (!this.consumerWorker) {
      throw new Error('Worker not running');
    }

    if (!this.isReady) {
      throw new Error('Stream not ready - call waitForReady() first');
    }

    const responsePromise = new Promise<{
      results: Array<{
        speakerIp: string;
        success: boolean;
        streamUrl?: string;
        error?: string;
      }>;
      originalGroups?: OriginalGroup[];
    }>((resolve, reject) => {
      this.playbackResultsResolver = { resolve, reject };
    });

    this.consumerWorker.postMessage({
      type: 'START_PLAYBACK',
      speakerIps,
      metadata,
      syncSpeakers,
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
export const MAX_OFFSCREEN_SESSIONS = 10;

/** Registry of active sessions by tab ID. */
export const activeSessions = new Map<number, StreamSession>();

/**
 * Stops all active sessions and clears the registry.
 * Called when the control WebSocket permanently disconnects.
 */
export function stopAllSessions(): void {
  if (activeSessions.size === 0) return;

  log.info(`Stopping all ${activeSessions.size} active session(s)`);
  for (const [tabId, session] of activeSessions) {
    log.info(`Stopping session for tab ${tabId}`);
    session.stop();
  }
  activeSessions.clear();
}
