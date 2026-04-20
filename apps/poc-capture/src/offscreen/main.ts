/**
 * Offscreen Document
 *
 * Handles getUserMedia tab capture, MSTP setup, worker management,
 * and WAV/JSON file downloads via anchor click.
 */

import type {
  BackgroundToOffscreenMessage,
  WorkerToOffscreenMessage,
  WorkerInitMessage,
  CaptureConfig,
} from '../lib/messages';
import { createWavBlob } from '../lib/wav';

/** Minimum gain to keep Chrome's audio detection active without audible sound. */
const KEEP_AUDIBLE_GAIN = 0.0001;

let worker: Worker | null = null;
let mediaStream: MediaStream | null = null;
let trackProcessor: MediaStreamTrackProcessor | null = null;
let audibleAudio: HTMLAudioElement | null = null;
let keepalivePort: chrome.runtime.Port | null = null;

// ─────────────────────────────────────────────────────────────────────────────
// Download Helpers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Triggers a file download via anchor click in the offscreen DOM.
 * @param blob - The Blob to download
 * @param filename - The download filename
 */
function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Capture Lifecycle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts audio capture: getUserMedia → MSTP → Worker.
 * @param mediaStreamId - The stream ID from chrome.tabCapture
 * @param config - Capture configuration
 */
async function startCapture(mediaStreamId: string, config: CaptureConfig): Promise<void> {
  // Open keepalive port to prevent SW idle timeout
  keepalivePort = chrome.runtime.connect({ name: 'capture-keepalive' });

  // Chrome's tab capture uses the non-standard `mandatory` constraint format.
  // Standard constraints (echoCancellation, etc.) CANNOT be mixed at the same
  // level as `mandatory` — Chrome throws "Malformed constraint". Instead, get
  // the stream first with only `mandatory`, then apply processing constraints
  // via applyConstraints() on the track.
  const constraints = {
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: mediaStreamId,
      },
    },
    video: false,
  };

  // Capture
  mediaStream = await navigator.mediaDevices.getUserMedia(
    constraints as unknown as MediaStreamConstraints,
  );

  const audioTrack = mediaStream.getAudioTracks()[0];
  if (!audioTrack) throw new Error('No audio track in captured stream');

  // Disable all audio processing — critical for clean capture & low-end perf.
  // voiceIsolation: Chrome 130+ ML voice model runs on the audio thread.
  await audioTrack.applyConstraints({
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
    voiceIsolation: false,
    ...(config.sampleRate !== null ? { sampleRate: config.sampleRate } : {}),
    channelCount: config.channelCount,
  } as MediaTrackConstraints);

  // Log actual track settings
  const settings = audioTrack.getSettings();
  const actualSampleRate = settings.sampleRate ?? 48000;
  const actualChannels = settings.channelCount ?? config.channelCount;
  console.log(
    `[Offscreen] Track settings: sampleRate=${actualSampleRate} channels=${actualChannels} ` +
      `echoCancellation=${settings.echoCancellation} noiseSuppression=${settings.noiseSuppression} ` +
      `autoGainControl=${settings.autoGainControl}`,
  );

  // Create MediaStreamTrackProcessor
  trackProcessor = new MediaStreamTrackProcessor({
    track: audioTrack,
    maxBufferSize: config.maxBufferSize,
  });
  console.log(`[Offscreen] MSTP created: maxBufferSize=${config.maxBufferSize}`);

  // Keep tab audible via <audio> element at near-zero volume
  audibleAudio = document.createElement('audio');
  audibleAudio.srcObject = mediaStream;
  audibleAudio.volume = KEEP_AUDIBLE_GAIN;
  audibleAudio.play().catch((err) => {
    console.warn('[Offscreen] audio.play() failed:', err);
  });

  // Create and initialize worker
  worker = new Worker(new URL('./capture-worker.ts', import.meta.url), {
    type: 'module',
  });

  worker.onmessage = (event: MessageEvent<WorkerToOffscreenMessage>) => {
    handleWorkerMessage(event.data);
  };

  worker.onerror = (err) => {
    console.error('[Offscreen] Worker error:', err);
    // Relay error to background → popup
    chrome.runtime
      .sendMessage({
        type: 'CAPTURE_ERROR',
        error: err.message || 'Worker error',
      })
      .catch(() => {});
    cleanup();
  };

  // Transfer ReadableStream to worker
  const readable = trackProcessor.readable;
  const initMsg: WorkerInitMessage = {
    type: 'INIT',
    readable,
    config,
    actualSampleRate,
    actualChannels,
  };
  worker.postMessage(initMsg, { transfer: [readable as unknown as Transferable] });

  // Notify background that capture started
  chrome.runtime
    .sendMessage({
      type: 'CAPTURE_STARTED',
      actualSampleRate,
      actualChannels,
    })
    .catch(() => {});
}

/**
 * Handles messages from the capture worker.
 * @param msg - The worker message
 */
function handleWorkerMessage(msg: WorkerToOffscreenMessage): void {
  if (msg.type === 'READY') {
    console.log('[Offscreen] Worker ready');
    return;
  }

  if (msg.type === 'STATS') {
    // Relay to background → popup
    chrome.runtime
      .sendMessage({
        type: 'CAPTURE_STATS',
        stats: msg.stats,
      })
      .catch(() => {});
    return;
  }

  if (msg.type === 'CAPTURE_COMPLETE') {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

    // 1. WAV file
    const wavBlob = createWavBlob(msg.pcm, msg.sampleRate, msg.channels);
    triggerDownload(wavBlob, `capture-${timestamp}.wav`);

    // 2. Events JSON
    const eventsBlob = new Blob([JSON.stringify(msg.events, null, 2)], {
      type: 'application/json',
    });
    triggerDownload(eventsBlob, `capture-${timestamp}-events.json`);

    // 3. Timing data (raw Float32 binary)
    const timingBlob = new Blob([msg.timingDeltas], {
      type: 'application/octet-stream',
    });
    triggerDownload(timingBlob, `capture-${timestamp}-timing.bin`);

    console.log(
      `[Offscreen] Downloads triggered: WAV=${(msg.pcm.byteLength / 1024 / 1024).toFixed(1)}MB, ` +
        `events=${msg.events.length}, timing=${(msg.timingDeltas.byteLength / 1024).toFixed(1)}KB`,
    );

    // Notify background
    chrome.runtime.sendMessage({ type: 'DOWNLOADS_COMPLETE' }).catch(() => {});

    cleanup();
  }
}

/**
 * Stops the active capture session.
 */
function stopCapture(): void {
  if (worker) {
    worker.postMessage({ type: 'STOP' });
    // Don't terminate — let the worker finish and send CAPTURE_COMPLETE
  }

  // Notify background
  chrome.runtime.sendMessage({ type: 'CAPTURE_STOPPED' }).catch(() => {});
}

/**
 * Cleans up all resources after capture is complete.
 */
function cleanup(): void {
  // Stop media tracks
  if (mediaStream) {
    mediaStream.getTracks().forEach((t) => t.stop());
    mediaStream = null;
  }

  trackProcessor = null;

  if (audibleAudio) {
    audibleAudio.pause();
    audibleAudio.srcObject = null;
    audibleAudio = null;
  }

  // Terminate worker
  if (worker) {
    worker.terminate();
    worker = null;
  }

  // Disconnect keepalive
  if (keepalivePort) {
    keepalivePort.disconnect();
    keepalivePort = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Message Handler
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: BackgroundToOffscreenMessage, _sender, sendResponse) => {
  if (msg.type === 'START_CAPTURE') {
    startCapture(msg.mediaStreamId, msg.config)
      .then(() => sendResponse({ success: true }))
      .catch((err) => {
        console.error('[Offscreen] startCapture failed:', err);
        cleanup();
        sendResponse({
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    return true; // async response
  }

  if (msg.type === 'STOP_CAPTURE') {
    stopCapture();
    sendResponse({ success: true });
    return true;
  }

  return false;
});

console.log('[Offscreen] PCM Capture offscreen document loaded');
