/**
 * Video Sync (ISOLATED world)
 *
 * Handles video delay compensation for A/V sync with Sonos speakers.
 * Implements a state machine that responds to latency measurements from desktop.
 *
 * State machine:
 * - NoData: No latency measurements yet
 * - Acquiring: Collecting samples for stability gate
 * - Locked: Actively syncing video to audio
 * - Stale: Lost sync, frozen until measurements resume
 *
 * @see packages/protocol/index.ts for VideoSyncState types
 */

import type {
  VideoSyncState,
  LatencySample,
  SampleWindow,
  LatencyBroadcastEvent,
  LatencyUpdatedBroadcastEvent,
  LatencyStaleBroadcastEvent,
} from '@thaumic-cast/protocol';
import { VIDEO_SYNC_CONSTANTS as C } from '@thaumic-cast/protocol';

// ─────────────────────────────────────────────────────────────────────────────
// State Management
// ─────────────────────────────────────────────────────────────────────────────

/** Current sync state per (streamId, speakerIp) */
const syncStates = new Map<string, VideoSyncState>();

/** Currently targeted video element */
let targetVideo: HTMLVideoElement | null = null;

/** Animation frame ID for sync loop */
let syncLoopId: number | null = null;

/** Last sync loop timestamp for slew calculation */
let lastSlewTime = 0;

/**
 * Creates a key for the sync state map.
 * @param streamId
 * @param speakerIp
 */
function stateKey(streamId: string, speakerIp: string): string {
  return `${streamId}:${speakerIp}`;
}

/**
 * Gets or creates initial state for a stream/speaker pair.
 * @param streamId
 * @param speakerIp
 */
function getState(streamId: string, speakerIp: string): VideoSyncState {
  const key = stateKey(streamId, speakerIp);
  let state = syncStates.get(key);
  if (!state) {
    state = { kind: 'NoData' };
    syncStates.set(key, state);
  }
  return state;
}

/**
 * Updates state for a stream/speaker pair.
 * @param streamId
 * @param speakerIp
 * @param state
 */
function setState(streamId: string, speakerIp: string, state: VideoSyncState): void {
  syncStates.set(stateKey(streamId, speakerIp), state);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample Window & Stability Gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new sample window.
 * @param max
 */
function createSampleWindow(max: number = C.REQUIRED_SAMPLES + 2): SampleWindow {
  return { buf: [], max };
}

/**
 * Adds a sample to the window, maintaining max size.
 * @param window
 * @param sample
 */
function addSample(window: SampleWindow, sample: LatencySample): void {
  window.buf.push(sample);
  if (window.buf.length > window.max) {
    window.buf.shift();
  }
}

/**
 * Calculates median of latency values in the window.
 * @param window
 */
function medianLatency(window: SampleWindow): number {
  if (window.buf.length === 0) return 0;
  const sorted = [...window.buf].map((s) => s.latencyMs).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Checks if the sample window passes the stability gate.
 * Requires:
 * - At least N samples
 * - All recent samples have confidence >= threshold
 * - All recent samples have jitter <= threshold
 * - All recent samples within median deviation threshold
 * @param window
 */
function passesStabilityGate(window: SampleWindow): boolean {
  if (window.buf.length < C.REQUIRED_SAMPLES) {
    return false;
  }

  const recent = window.buf.slice(-C.REQUIRED_SAMPLES);
  const median = medianLatency(window);

  return recent.every(
    (s) =>
      s.confidence >= C.MIN_CONFIDENCE &&
      s.jitterMs <= C.MAX_JITTER_MS &&
      Math.abs(s.latencyMs - median) <= C.MAX_MEDIAN_DEVIATION_MS,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Video Element Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds the best video element to sync.
 * Prioritizes: playing > paused, larger > smaller, visible > hidden
 */
function findBestVideo(): HTMLVideoElement | null {
  const videos = Array.from(document.querySelectorAll('video'));

  if (videos.length === 0) return null;

  // Score each video
  const scored = videos
    .map((video) => {
      let score = 0;

      // Playing videos get priority
      if (!video.paused && !video.ended) score += 1000;

      // Larger videos get priority (likely main content)
      const rect = video.getBoundingClientRect();
      score += (rect.width * rect.height) / 1000;

      // Visible videos get priority
      if (rect.width > 0 && rect.height > 0) score += 100;

      // Videos with audio get priority
      if (!video.muted && video.volume > 0) score += 500;

      // Exclude very small videos (likely ads/thumbnails)
      if (rect.width < 200 || rect.height < 100) score -= 2000;

      // Exclude videos in iframes with different origins (can't control them)
      // Note: We can still detect them, just can't manipulate

      return { video, score };
    })
    .filter((v) => v.score > 0)
    .sort((a, b) => b.score - a.score);

  return scored[0]?.video ?? null;
}

/**
 * Updates the target video element.
 * Returns true if target changed.
 */
function updateTargetVideo(): boolean {
  const best = findBestVideo();
  if (best !== targetVideo) {
    targetVideo = best;
    return true;
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coarse Alignment (Lock Transition)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performs coarse alignment: pause -> wait delay -> play
 * Called only when transitioning to Locked state.
 * @param video
 * @param delayMs
 */
async function performCoarseAlignment(
  video: HTMLVideoElement,
  delayMs: number,
): Promise<{ lockNowMs: number; lockVideoTime: number }> {
  // Pause video
  video.pause();

  // Wait for the delay
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  // Record anchors before playing
  const lockNowMs = performance.now();
  const lockVideoTime = video.currentTime;

  // Resume playback
  video.play().catch(() => {
    // Play may be rejected if user hasn't interacted yet
  });

  return { lockNowMs, lockVideoTime };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Loop (Locked State)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Starts the sync control loop.
 */
function startSyncLoop(): void {
  if (syncLoopId !== null) return;

  lastSlewTime = performance.now();

  const loop = (): void => {
    syncLoopId = requestAnimationFrame(loop);
    runSyncIteration();
  };

  syncLoopId = requestAnimationFrame(loop);
}

/**
 * Stops the sync control loop.
 */
function stopSyncLoop(): void {
  if (syncLoopId !== null) {
    cancelAnimationFrame(syncLoopId);
    syncLoopId = null;
  }
}

/**
 * Runs one iteration of the sync control loop.
 * Only operates in Locked state with a valid target video.
 */
function runSyncIteration(): void {
  if (!targetVideo) return;

  // Find the first Locked state (multi-speaker: use first for sync)
  let lockedState: Extract<VideoSyncState, { kind: 'Locked' }> | null = null;
  for (const state of syncStates.values()) {
    if (state.kind === 'Locked') {
      lockedState = state;
      break;
    }
  }

  if (!lockedState) {
    stopSyncLoop();
    return;
  }

  const { lockedLatencyMs, userTrimMs, lockNowMs, lockVideoTime, rateMode } = lockedState;
  const video = targetVideo;

  // Calculate target video time
  const now = performance.now();
  const delaySec = (lockedLatencyMs + userTrimMs) / 1000;
  const elapsedSec = (now - lockNowMs) / 1000;
  const target = lockVideoTime + elapsedSec - delaySec;

  // Calculate error (positive = video ahead)
  const error = video.currentTime - target;

  // Apply correction based on error magnitude
  if (Math.abs(error) < C.ERROR_DEADBAND_SEC) {
    // Within deadband - no correction needed
    if (video.playbackRate !== 1.0) {
      video.playbackRate = 1.0;
    }
  } else if (Math.abs(error) > C.HARD_ERROR_THRESHOLD_SEC) {
    // Hard error - use seek or pause
    if (error < 0) {
      // Video behind - seek forward
      video.currentTime = target;
    } else {
      // Video ahead - micro-pause
      const pauseMs = Math.min(C.MAX_MICRO_PAUSE_MS, error * 1000);
      video.pause();
      setTimeout(() => {
        video.play().catch(() => {});
      }, pauseMs);
    }
  } else {
    // Soft error - use playbackRate or micro-pause
    if (rateMode === 'rate') {
      // Proportional rate adjustment
      const adjustment = Math.max(-C.MAX_RATE_ADJUSTMENT, Math.min(C.MAX_RATE_ADJUSTMENT, -error));
      video.playbackRate = 1.0 + adjustment;
    } else {
      // Micro-pause mode (fallback when rate is fought)
      if (error > C.ERROR_DEADBAND_SEC) {
        const pauseMs = Math.min(C.MAX_MICRO_PAUSE_MS, (error - C.ERROR_DEADBAND_SEC) * 1000);
        video.pause();
        setTimeout(() => {
          video.play().catch(() => {});
        }, pauseMs);
      }
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event Handling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles a latency updated event.
 * @param event
 */
async function handleLatencyUpdated(event: LatencyUpdatedBroadcastEvent): Promise<void> {
  const { streamId, speakerIp, epochId, latencyMs, jitterMs, confidence } = event;
  const state = getState(streamId, speakerIp);
  const now = performance.now();

  const sample: LatencySample = {
    latencyMs,
    jitterMs,
    confidence,
    tMs: now,
  };

  // State transitions based on current state
  switch (state.kind) {
    case 'NoData': {
      // First measurement - start acquiring
      const samples = createSampleWindow();
      addSample(samples, sample);
      setState(streamId, speakerIp, { kind: 'Acquiring', epochId, samples });
      break;
    }

    case 'Acquiring': {
      // Check for epoch change
      if (epochId !== state.epochId) {
        // New epoch - restart acquisition
        const samples = createSampleWindow();
        addSample(samples, sample);
        setState(streamId, speakerIp, { kind: 'Acquiring', epochId, samples });
        break;
      }

      // Add sample and check stability gate
      addSample(state.samples, sample);

      if (passesStabilityGate(state.samples)) {
        // Gate passed - transition to Locked
        updateTargetVideo();

        if (targetVideo) {
          const { lockNowMs, lockVideoTime } = await performCoarseAlignment(
            targetVideo,
            medianLatency(state.samples),
          );

          setState(streamId, speakerIp, {
            kind: 'Locked',
            epochId,
            lockedLatencyMs: medianLatency(state.samples),
            userTrimMs: 0,
            lockNowMs,
            lockVideoTime,
            rateMode: 'rate',
          });

          startSyncLoop();
        }
      }
      break;
    }

    case 'Locked': {
      // Check for epoch change
      if (epochId !== state.epochId) {
        // New epoch - go back to acquiring
        const samples = createSampleWindow();
        addSample(samples, sample);
        setState(streamId, speakerIp, { kind: 'Acquiring', epochId, samples });
        stopSyncLoop();
        break;
      }

      // Apply slew policy - don't chase small changes
      const diff = latencyMs - state.lockedLatencyMs;
      if (Math.abs(diff) >= C.LOCK_DEADBAND_MS) {
        // Calculate time since last slew
        const dt = (now - lastSlewTime) / 1000; // seconds
        lastSlewTime = now;

        // Clamp slew rate
        const maxSlew = C.SLEW_RATE_MS_PER_SEC * dt;
        const slew = Math.max(-maxSlew, Math.min(maxSlew, diff));

        setState(streamId, speakerIp, {
          ...state,
          lockedLatencyMs: state.lockedLatencyMs + slew,
        });
      }
      break;
    }

    case 'Stale': {
      // Recovery - go to Acquiring (same or different epoch)
      const samples = createSampleWindow();
      addSample(samples, sample);
      setState(streamId, speakerIp, { kind: 'Acquiring', epochId, samples });
      break;
    }
  }
}

/**
 * Handles a latency stale event.
 * @param event
 */
function handleLatencyStale(event: LatencyStaleBroadcastEvent): void {
  const { streamId, speakerIp, epochId } = event;
  const state = getState(streamId, speakerIp);

  // Only transition to Stale from Locked or Acquiring with matching epoch
  if ((state.kind === 'Locked' || state.kind === 'Acquiring') && state.epochId === epochId) {
    const lockedLatencyMs = state.kind === 'Locked' ? state.lockedLatencyMs : 0;
    const userTrimMs = state.kind === 'Locked' ? state.userTrimMs : 0;

    setState(streamId, speakerIp, {
      kind: 'Stale',
      epochId,
      lockedLatencyMs,
      userTrimMs,
      sinceMs: performance.now(),
    });

    stopSyncLoop();
  }
}

/**
 * Handles incoming latency events from background.
 * @param event
 */
function handleLatencyEvent(event: LatencyBroadcastEvent): void {
  if (event.type === 'updated') {
    handleLatencyUpdated(event as LatencyUpdatedBroadcastEvent);
  } else if (event.type === 'stale') {
    handleLatencyStale(event as LatencyStaleBroadcastEvent);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Initialization
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Initialize video sync module.
 */
function init(): void {
  // Listen for latency events from background
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'LATENCY_EVENT' && message.payload) {
      handleLatencyEvent(message.payload as LatencyBroadcastEvent);
      sendResponse({ success: true });
      return true;
    }
    return false;
  });

  // Periodically check for video element changes
  setInterval(() => {
    const changed = updateTargetVideo();
    if (changed && targetVideo) {
      // Video element changed - if we're locked, need to re-acquire
      for (const [key, state] of syncStates.entries()) {
        if (state.kind === 'Locked') {
          const [streamId, speakerIp] = key.split(':');
          const samples = createSampleWindow();
          setState(streamId, speakerIp, {
            kind: 'Acquiring',
            epochId: state.epochId,
            samples,
          });
        }
      }
      stopSyncLoop();
    }
  }, 2000);

  // Initial video detection
  updateTargetVideo();
}

// Run initialization
init();
