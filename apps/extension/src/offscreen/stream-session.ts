/**
 * Stream Session Module
 *
 * Manages audio capture sessions for both tab capture and browser-wide WASAPI capture.
 *
 * Tab capture mode:
 *   AudioWorklet → SharedArrayBuffer → Worker (drain + encode + WebSocket send)
 *
 * Browser capture mode:
 *   Worker manages WS lifecycle only — server captures audio via WASAPI.
 *   No AudioContext, AudioWorklet, or SharedArrayBuffer.
 *
 * Responsibilities:
 * - Audio pipeline setup (tab capture only)
 * - Worker lifecycle for encoding/streaming or WS-only control
 * - Session health tracking
 * - Playback coordination with Sonos
 *
 * Non-responsibilities:
 * - WebSocket control connection (handled by control-connection.ts)
 * - Message routing (handled by handlers.ts)
 */

import { createLogger } from '@thaumic-cast/shared';
import { createAudioRingBuffer, HEADER_SIZE } from './ring-buffer';
import type { EncoderConfig, StreamMetadata } from '@thaumic-cast/protocol';
import { FRAME_DURATION_MS_DEFAULT, isSupportedSampleRate } from '@thaumic-cast/protocol';
import type { WorkerInitMessage, WorkerOutboundMessage } from './worker-messages';
import { noop } from '../lib/noop';

const log = createLogger('Offscreen');

/** Maximum time for session initialization before timeout (ms). */
const INIT_TIMEOUT_MS = 15_000;

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
 * Manages an active capture session.
 *
 * In tab capture mode, the real-time audio path runs entirely in a Worker:
 *   AudioWorklet → SharedArrayBuffer → Worker (drain + encode + WebSocket send)
 *
 * In browser capture mode, the Worker only manages WS lifecycle:
 *   Worker (WebSocket control only) — server captures via WASAPI.
 *
 * Main thread only handles:
 *   - Audio pipeline setup (tab capture only)
 *   - Worker lifecycle management
 *   - Receiving status updates from Worker
 */
export class StreamSession {
  private audioContext: AudioContext | null = null;
  private consumerWorker: Worker | null = null;
  // Ring buffer is created in setupAudioContextPipeline() after sample rate is verified
  private ringBuffer: SharedArrayBuffer | null = null;
  private bufferSize = 0;
  private bufferMask = 0;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private outputGainNode: GainNode | null = null;

  // ─── MSTP path (PCM codec) ──────────────────────────────────────
  private trackProcessor: MediaStreamTrackProcessor | null = null;
  /** Audio element for keepTabAudible in MSTP mode (avoids AudioContext clock domain crossing). */
  private audibleAudio: HTMLAudioElement | null = null;

  /** Number of interleaved samples per frame (PCM encode path only). */
  private frameSizeInterleaved?: number;

  /** Pending worker terminate timer (deferred to allow METRICS_DUMP delivery). */
  private workerTerminateTimer: ReturnType<typeof setTimeout> | null = null;

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
  private totalFrameQueueDrops = 0;

  /** Last time we logged diagnostics (for rate-limiting when healthy). */
  private lastDiagLogTime = 0;

  /** Callback when worker disconnects (for cleanup coordination). */
  private onDisconnected?: () => void;

  /** Callback when server reports a capture error (browser capture mode only). */
  private onError?: (error: string, reason?: string) => void;

  /** Whether to play audio at low volume to prevent Chrome throttling. */
  private keepTabAudible: boolean;

  /** Capture mode: 'tab' for tab audio, 'browser' for WASAPI browser-wide capture. */
  private captureMode: 'tab' | 'browser';

  /** Media stream for tab capture (null in browser capture mode). */
  private mediaStream: MediaStream | null;

  /** Encoder config passed to the Worker. */
  private encoderConfig: EncoderConfig;

  /** Desktop app base URL. */
  private baseUrl: string;

  /** Browser executable name for PID lookup (browser capture mode only). */
  private browserName?: string;

  /**
   * Creates a StreamSession for tab audio capture.
   * @param mediaStream - The captured media stream from chrome.tabCapture
   * @param encoderConfig - Audio encoder configuration
   * @param baseUrl - Desktop app base URL
   * @param onDisconnected - Optional callback when worker WebSocket disconnects
   * @param options - Additional session options
   * @param options.keepTabAudible - Play audio at low volume to prevent Chrome throttling
   * @returns A new StreamSession configured for tab audio capture
   */
  static forTabCapture(
    mediaStream: MediaStream,
    encoderConfig: EncoderConfig,
    baseUrl: string,
    onDisconnected?: () => void,
    options?: { keepTabAudible?: boolean },
  ): StreamSession {
    return new StreamSession({
      captureMode: 'tab',
      mediaStream,
      encoderConfig,
      baseUrl,
      onDisconnected,
      keepTabAudible: options?.keepTabAudible,
    });
  }

  /**
   * Creates a StreamSession for browser-wide WASAPI capture.
   * The Worker manages WS lifecycle only — no local audio pipeline.
   * @param encoderConfig - Audio encoder configuration
   * @param baseUrl - Desktop app base URL
   * @param onDisconnected - Optional callback when worker WebSocket disconnects
   * @param onError - Optional callback when server reports a capture error
   * @param browserName - Optional browser executable name for PID lookup
   * @returns A new StreamSession configured for browser-wide WASAPI capture
   */
  static forBrowserCapture(
    encoderConfig: EncoderConfig,
    baseUrl: string,
    onDisconnected?: () => void,
    onError?: (error: string, reason?: string) => void,
    browserName?: string,
  ): StreamSession {
    return new StreamSession({
      captureMode: 'browser',
      mediaStream: null,
      encoderConfig,
      baseUrl,
      onDisconnected,
      onError,
      browserName,
    });
  }

  /**
   * Constructs a StreamSession. Use the static {@link forTabCapture} or
   * {@link forBrowserCapture} factories instead of calling this directly.
   * @param config - Session configuration
   * @param config.captureMode - 'tab' for per-tab capture, 'browser' for WASAPI browser-wide capture
   * @param config.mediaStream - MediaStream for tab capture (null in browser capture mode)
   * @param config.encoderConfig - Audio encoder configuration
   * @param config.baseUrl - Desktop app base URL
   * @param config.onDisconnected - Optional callback when worker WebSocket disconnects
   * @param config.onError - Optional callback when server reports a capture error
   * @param config.keepTabAudible - Play audio at low volume to prevent Chrome throttling (tab capture only)
   * @param config.browserName - Browser executable name for PID lookup (browser capture only)
   */
  private constructor(config: {
    captureMode: 'tab' | 'browser';
    mediaStream: MediaStream | null;
    encoderConfig: EncoderConfig;
    baseUrl: string;
    onDisconnected?: () => void;
    onError?: (error: string, reason?: string) => void;
    keepTabAudible?: boolean;
    browserName?: string;
  }) {
    this.captureMode = config.captureMode;
    this.mediaStream = config.mediaStream;
    this.encoderConfig = config.encoderConfig;
    this.baseUrl = config.baseUrl;
    this.onDisconnected = config.onDisconnected;
    this.onError = config.onError;
    this.keepTabAudible = config.keepTabAudible ?? false;
    this.browserName = config.browserName;

    this.streamReadyPromise = new Promise<void>((resolve) => {
      this.streamReadyResolve = resolve;
    });
  }

  /**
   * Initializes the session: sets up audio pipeline (tab only) and starts the Worker.
   */
  async init(): Promise<void> {
    const initWork = async (): Promise<void> => {
      if (this.captureMode === 'tab') {
        await this.setupAudioPipeline();
      }
      await this.startWorker();
    };

    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('Session init timed out')), INIT_TIMEOUT_MS);
    });

    try {
      await Promise.race([initWork(), timeoutPromise]);
    } catch (err) {
      log.error('Failed to initialize session', err);
      this.stop();
      throw err;
    }
  }

  /**
   * Sets up the audio capture pipeline.
   * Routes to MSTP (PCM codec) or AudioContext (compressed codecs) path.
   */
  private async setupAudioPipeline(): Promise<void> {
    // Set up MediaStream track monitoring (shared by both paths)
    this.setupTrackMonitoring();

    if (this.encoderConfig.codec === 'pcm') {
      this.setupMSTPPipeline();
    } else {
      await this.setupAudioContextPipeline();
    }
  }

  /**
   * Sets up MediaStream track event listeners for monitoring mute/unmute/ended states.
   */
  private setupTrackMonitoring(): void {
    const audioTracks = this.mediaStream!.getAudioTracks();
    log.info(`MediaStream has ${audioTracks.length} audio track(s)`);

    for (const track of audioTracks) {
      log.info(
        `Audio track: ${track.label}, enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`,
      );

      // Log track settings
      const settings = track.getSettings();
      log.info(
        `Track settings: sampleRate=${settings.sampleRate} channels=${settings.channelCount}`,
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
  }

  /**
   * Sets up the MSTP (MediaStreamTrackProcessor) pipeline for PCM codec.
   * Bypasses AudioContext entirely — reads raw AudioData frames from the track.
   */
  private setupMSTPPipeline(): void {
    const audioTrack = this.mediaStream!.getAudioTracks()[0];
    if (!audioTrack) throw new Error('No audio track available in MediaStream');

    // Override sample rate to track's native rate (MSTP bypasses AudioContext resampling)
    const trackSampleRate = audioTrack.getSettings().sampleRate;
    if (
      trackSampleRate &&
      isSupportedSampleRate(trackSampleRate) &&
      trackSampleRate !== this.encoderConfig.sampleRate
    ) {
      log.info(
        `MSTP: overriding sample rate ${this.encoderConfig.sampleRate}Hz → ${trackSampleRate}Hz (capture native rate)`,
      );
      this.encoderConfig = { ...this.encoderConfig, sampleRate: trackSampleRate };
    }

    // Compute frame size
    const frameDurationMs = this.encoderConfig.frameDurationMs ?? FRAME_DURATION_MS_DEFAULT;
    const perChannelSamples = Math.round(this.encoderConfig.sampleRate * (frameDurationMs / 1000));
    this.frameSizeInterleaved = perChannelSamples * this.encoderConfig.channels;

    // Create MediaStreamTrackProcessor
    const maxBufferSize = 1000;
    this.trackProcessor = new MediaStreamTrackProcessor({ track: audioTrack, maxBufferSize });
    log.info(
      `MSTP pipeline: maxBufferSize=${maxBufferSize}, frameSizeInterleaved=${this.frameSizeInterleaved}`,
    );

    // keepTabAudible: use <audio> element at near-zero volume (avoids AudioContext clock domain crossing)
    if (this.keepTabAudible) {
      this.audibleAudio = document.createElement('audio');
      this.audibleAudio.srcObject = this.mediaStream;
      this.audibleAudio.volume = KEEP_AUDIBLE_GAIN;
      this.audibleAudio.play().catch((err) => {
        log.warn('Keep tab audible: audio.play() failed:', err);
      });
      log.info('Keep tab audible enabled (MSTP) - audio element at low volume');
    }
  }

  /**
   * Sets up the Web Audio graph and loads the AudioWorklet (compressed codecs path).
   */
  private async setupAudioContextPipeline(): Promise<void> {
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

    this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream!);
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
      buffer: this.ringBuffer!,
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
   * In browser capture mode, the Worker only manages WS lifecycle (no audio encoding).
   */
  private async startWorker(): Promise<void> {
    const wsUrl = this.baseUrl.replace(/^http/, 'ws') + '/ws';

    // Spawn codec-appropriate worker. The MSTP relay only applies to tab
    // capture — browser/WASAPI capture has no MediaStream and must use the
    // audio-consumer worker, which handles INIT_BROWSER_CAPTURE.
    if (this.captureMode === 'tab' && this.encoderConfig.codec === 'pcm') {
      this.consumerWorker = new Worker(new URL('./audio-relay.worker.ts', import.meta.url), {
        type: 'module',
      });
    } else {
      this.consumerWorker = new Worker(new URL('./audio-consumer.worker.ts', import.meta.url), {
        type: 'module',
      });
    }

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

        case 'BROWSER_CAPTURE_ERROR':
          log.error(`Browser capture error: ${msg.error} (${msg.reason})`);
          this.onError?.(msg.error, msg.reason);
          this.stop();
          break;

        case 'METRICS_DUMP':
          log.info('Pipeline metrics timeline', { timeline: JSON.stringify(msg.timeline) });
          this.terminateWorkerNow();
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

    // Initialize the Worker based on capture mode and codec
    if (this.captureMode === 'browser') {
      // Browser capture path (unchanged — worker manages WS lifecycle only)
      this.consumerWorker.postMessage({
        type: 'INIT_BROWSER_CAPTURE',
        wsUrl,
        encoderConfig: this.encoderConfig,
        browserName: this.browserName,
      });
    } else if (this.encoderConfig.codec === 'pcm' && this.trackProcessor) {
      // MSTP path: transfer ReadableStream to worker
      const readable = this.trackProcessor.readable;
      const initMsg: WorkerInitMessage = {
        type: 'INIT',
        sampleRate: this.encoderConfig.sampleRate,
        encoderConfig: this.encoderConfig,
        wsUrl,
        mode: 'encode',
        frameSizeInterleaved: this.frameSizeInterleaved,
        readable,
        channels: this.encoderConfig.channels,
      };
      this.consumerWorker.postMessage(initMsg, {
        transfer: [readable as unknown as Transferable],
      });
    } else {
      // SAB path: compressed codecs
      this.consumerWorker.postMessage({
        type: 'INIT',
        sab: this.ringBuffer!,
        bufferSize: this.bufferSize,
        bufferMask: this.bufferMask,
        headerSize: HEADER_SIZE,
        sampleRate: this.encoderConfig.sampleRate,
        encoderConfig: this.encoderConfig,
        wsUrl,
      });
    }

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
      // Defer terminate to allow worker to post METRICS_DUMP back
      this.workerTerminateTimer = setTimeout(() => this.terminateWorkerNow(), 500);
    }

    // Audio pipeline cleanup (tab capture only)
    if (this.captureMode === 'tab' && this.mediaStream) {
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

      // Tear down AudioContext path (compressed codecs)
      this.sourceNode?.disconnect();
      this.workletNode?.disconnect();
      this.outputGainNode?.disconnect();
      this.audioContext?.close().catch(noop);

      // Tear down MSTP path resources
      this.trackProcessor = null; // ReadableStream was transferred to worker
      if (this.audibleAudio) {
        this.audibleAudio.pause();
        this.audibleAudio.srcObject = null;
        this.audibleAudio = null;
      }

      this.mediaStream.getTracks().forEach((t) => t.stop());
    }
  }

  /**
   * Terminates the worker immediately and clears the deferred-terminate timer.
   */
  private terminateWorkerNow(): void {
    if (this.workerTerminateTimer) {
      clearTimeout(this.workerTerminateTimer);
      this.workerTerminateTimer = null;
    }
    if (this.consumerWorker) {
      this.consumerWorker.terminate();
      this.consumerWorker = null;
    }
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
   * @param syncSpeakers - Whether to synchronize multi-speaker playback
   * @param videoSyncEnabled - Whether client has video sync enabled (gates server-side latency monitoring)
   * @param timeoutMs - Timeout in milliseconds
   * @returns Promise resolving with per-speaker playback results
   * @throws Error if all playback attempts fail or timeout
   */
  public async startPlayback(
    speakerIps: string[],
    metadata?: StreamMetadata,
    syncSpeakers: boolean = false,
    videoSyncEnabled: boolean = false,
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
      syncSpeakers,
      videoSyncEnabled,
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
