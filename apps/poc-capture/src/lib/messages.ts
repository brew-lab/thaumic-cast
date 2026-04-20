/**
 * Typed message protocol for all PoC capture communication.
 *
 * Directions:
 * - Popup <-> Background (chrome.runtime.sendMessage)
 * - Background <-> Offscreen (chrome.runtime.sendMessage)
 * - Offscreen <-> Worker (postMessage)
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared Types
// ─────────────────────────────────────────────────────────────────────────────

/** Capture configuration set by the popup UI. */
export interface CaptureConfig {
  sampleRate: number | null;
  channelCount: 1 | 2;
  maxBufferSize: number;
}

/** Live stats from the capture worker, posted every ~1s. */
export interface CaptureStats {
  totalFrames: number;
  totalDurationSec: number;
  gapCount: number;
  totalGapMs: number;
  zeroBlockCount: number;
  frameDurationMinMs: number;
  frameDurationMaxMs: number;
  frameDurationAvgMs: number;
  frameSizeMin: number;
  frameSizeMax: number;
  processingTimeAvgUs: number;
  processingTimeMaxUs: number;
  actualSampleRate: number;
  actualChannels: number;
  accumulatedBytes: number;
  elapsedSec: number;
}

/** A single diagnostic event recorded during capture. */
export interface DiagnosticEvent {
  type: 'gap' | 'overlap' | 'zero_block';
  wallClockMs: number;
  frameIndex: number;
  sampleOffset: number;
  durationUs: number;
  expectedTimestamp: number;
  actualTimestamp: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Popup -> Background
// ─────────────────────────────────────────────────────────────────────────────

export interface StartCaptureMessage {
  type: 'START_CAPTURE';
  config: CaptureConfig;
}

export interface StopCaptureMessage {
  type: 'STOP_CAPTURE';
}

export type PopupToBackgroundMessage = StartCaptureMessage | StopCaptureMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Background -> Offscreen
// ─────────────────────────────────────────────────────────────────────────────

export interface OffscreenStartCaptureMessage {
  type: 'START_CAPTURE';
  mediaStreamId: string;
  config: CaptureConfig;
}

export interface OffscreenStopCaptureMessage {
  type: 'STOP_CAPTURE';
}

export type BackgroundToOffscreenMessage =
  | OffscreenStartCaptureMessage
  | OffscreenStopCaptureMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Offscreen -> Worker
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerInitMessage {
  type: 'INIT';
  readable: ReadableStream<AudioData>;
  config: CaptureConfig;
  actualSampleRate: number;
  actualChannels: number;
}

export interface WorkerStopMessage {
  type: 'STOP';
}

export type OffscreenToWorkerMessage = WorkerInitMessage | WorkerStopMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Worker -> Offscreen
// ─────────────────────────────────────────────────────────────────────────────

export interface WorkerReadyMessage {
  type: 'READY';
}

export interface WorkerStatsMessage {
  type: 'STATS';
  stats: CaptureStats;
}

export interface WorkerCaptureCompleteMessage {
  type: 'CAPTURE_COMPLETE';
  pcm: ArrayBuffer;
  events: DiagnosticEvent[];
  timingDeltas: ArrayBuffer;
  sampleRate: number;
  channels: number;
}

export type WorkerToOffscreenMessage =
  | WorkerReadyMessage
  | WorkerStatsMessage
  | WorkerCaptureCompleteMessage;

// ─────────────────────────────────────────────────────────────────────────────
// Offscreen / Background -> Popup (relayed)
// ─────────────────────────────────────────────────────────────────────────────

export interface CaptureStartedMessage {
  type: 'CAPTURE_STARTED';
  actualSampleRate: number;
  actualChannels: number;
}

export interface CaptureStoppedMessage {
  type: 'CAPTURE_STOPPED';
}

export interface CaptureStatsRelayMessage {
  type: 'CAPTURE_STATS';
  stats: CaptureStats;
}

export interface DownloadsCompleteMessage {
  type: 'DOWNLOADS_COMPLETE';
}

export interface CaptureErrorMessage {
  type: 'CAPTURE_ERROR';
  error: string;
}

export type RelayMessage =
  | CaptureStartedMessage
  | CaptureStoppedMessage
  | CaptureStatsRelayMessage
  | DownloadsCompleteMessage
  | CaptureErrorMessage;
