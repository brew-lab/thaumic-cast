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
  VideoSyncStatus,
  LatencySample,
  SampleWindow,
  LatencyBroadcastEvent,
  LatencyUpdatedBroadcastEvent,
  LatencyStaleBroadcastEvent,
} from '@thaumic-cast/protocol';
import { VIDEO_SYNC_CONSTANTS as C } from '@thaumic-cast/protocol';
import { createLogger } from '@thaumic-cast/shared';
import { noop } from '../lib/noop';

const log = createLogger('VideoSync');

// ─────────────────────────────────────────────────────────────────────────────
// Per-Cast State (ephemeral, not persisted)
// ─────────────────────────────────────────────────────────────────────────────

/** Whether video sync is enabled for this cast (per-cast toggle) */
let videoSyncEnabled = false;

/** User trim adjustment in milliseconds (per-cast) */
let currentTrimMs = 0;

/**
 * Whether a coarse alignment (pause → wait → play) is currently in flight.
 * Latency samples that arrive during the wait must not start another alignment.
 */
let coarseAlignmentInProgress = false;

/** Video events the sync code itself provokes and must therefore not react to. */
type SelfEventType = 'pause' | 'play';

/**
 * Pending self-inflicted pause/play events as expiry timestamps (performance.now()).
 * Every programmatic pause()/play() registers the event it is expected to fire;
 * the matching handler consumes one entry and ignores the event. Entries expire so
 * a call that produced no event (e.g. a rejected play()) cannot swallow a later
 * user action.
 */
const expectedSelfEvents: Record<SelfEventType, number[]> = { pause: [], play: [] };

/** How long a self-inflicted pause/play event may take to arrive */
const SELF_EVENT_TTL_MS = 1000;

/**
 * Registers that the sync code is about to provoke a pause or play event.
 * @param type - The event type the upcoming call will fire
 */
function expectSelfEvent(type: SelfEventType): void {
  expectedSelfEvents[type].push(performance.now() + SELF_EVENT_TTL_MS);
}

/**
 * Consumes one pending self-inflicted expectation for the given event type.
 * @param type - The event type that just fired
 * @returns True if the event was self-inflicted and should be ignored
 */
function consumeSelfEvent(type: SelfEventType): boolean {
  const now = performance.now();
  const pending = expectedSelfEvents[type].filter((expiresAt) => expiresAt > now);
  const selfInflicted = pending.length > 0;
  if (selfInflicted) pending.shift();
  expectedSelfEvents[type] = pending;
  return selfInflicted;
}

/**
 * The corrective seek currently in flight: when the expectation lapses and the
 * video time we asked for. At most one is outstanding at a time.
 */
let pendingSelfSeek: { expiresAtMs: number; targetSec: number } | null = null;

/**
 * How long to wait for a corrective seek to land before allowing another one.
 * Long enough for a seek that has to buffer, short enough that a page which
 * silently ignores currentTime writes does not block corrections for long.
 */
const SELF_SEEK_TTL_MS = 2000;

/**
 * How far from the requested time a seek may land and still count as ours (seconds).
 * Covers keyframe snapping; a user seek, or one the page clamps or reverts, lands
 * much further away than this.
 */
const SELF_SEEK_TOLERANCE_SEC = 0.5;

/**
 * Checks whether a corrective seek issued by the sync code is still outstanding.
 * @returns True if a self-inflicted seek has neither landed nor lapsed
 */
function hasPendingSelfSeek(): boolean {
  return pendingSelfSeek !== null && performance.now() < pendingSelfSeek.expiresAtMs;
}

/**
 * Decides whether a `seeked` event belongs to the corrective seek we issued.
 * The expectation is consumed only when the video landed near the time we asked
 * for, so a user seek during the window - or our own seek clamped or reverted by
 * the page - still falls through to the normal re-acquire.
 * @param landedSec - The video time the seek landed on
 * @returns True if the event was self-inflicted and should be ignored
 */
function consumeSelfSeek(landedSec: number): boolean {
  const pending = pendingSelfSeek;
  pendingSelfSeek = null;
  if (!pending || performance.now() >= pending.expiresAtMs) return false;
  return Math.abs(landedSec - pending.targetSec) <= SELF_SEEK_TOLERANCE_SEC;
}

/**
 * When a pause performed by the sync code itself is expected to end
 * (performance.now() basis; 0 = the video is not paused by us).
 * Unlike the event expectations above this stays set for the whole pause, so a
 * stall check landing mid-pause knows `video.paused` is our own doing.
 */
let selfPauseUntilMs = 0;

/** Slack added to a self-inflicted pause window to cover the resume */
const SELF_PAUSE_MARGIN_MS = 250;

/**
 * Checks whether the video is currently paused by the sync code itself.
 * @returns True if a self-inflicted pause is in flight
 */
function isSelfPauseActive(): boolean {
  return performance.now() < selfPauseUntilMs;
}

/**
 * Drops all pending self-inflicted event expectations and pause bookkeeping.
 */
function clearSelfEvents(): void {
  expectedSelfEvents.pause = [];
  expectedSelfEvents.play = [];
  pendingSelfSeek = null;
  selfPauseUntilMs = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// State Management
// ─────────────────────────────────────────────────────────────────────────────

/** Current sync state per (streamId, speakerIp) */
const syncStates = new Map<string, VideoSyncState>();

/** Currently targeted video element */
let targetVideo: HTMLVideoElement | null = null;

/** Animation frame ID for sync loop (rAF fallback) */
let syncLoopId: number | null = null;

/** Flag to stop RVFC-driven loop (RVFC has no cancellable handle) */
let syncLoopRunning = false;

/** Last time we logged sync status */
let lastSyncLogTime = 0;

/** Expected playbackRate we last set (for fighting detection) */
let expectedPlaybackRate = 1.0;

/** Counter for consecutive rate fights (site snapping rate back to 1.0) */
let rateFightCount = 0;

/** Threshold for switching to pause mode */
const RATE_FIGHT_THRESHOLD = 3;

/** Video element currently being monitored for events */
let monitoredVideo: HTMLVideoElement | null = null;

/** AbortController for video event listeners (for cleanup) */
let videoEventController: AbortController | null = null;

/** Last sync error for jump detection */
let lastSyncErrorMs = 0;

/** Timer for "persisted stall" check */
let stallDebounceTimer: ReturnType<typeof setTimeout> | null = null;

/** Interval ID for video element polling (only runs when sync enabled) */
let videoCheckInterval: ReturnType<typeof setInterval> | null = null;

/**
 * Creates a key for the sync state map.
 * @param streamId
 * @param speakerIp
 * @returns The state key
 */
function stateKey(streamId: string, speakerIp: string): string {
  return `${streamId}:${speakerIp}`;
}

/**
 * Gets or creates initial state for a stream/speaker pair.
 * @param streamId
 * @param speakerIp
 * @returns The video sync state
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
  const prevState = syncStates.get(stateKey(streamId, speakerIp));
  syncStates.set(stateKey(streamId, speakerIp), state);

  if (prevState?.kind !== state.kind) {
    log.info(`State transition: ${prevState?.kind ?? 'none'} → ${state.kind}`);
    broadcastSyncState();
  }
}

/**
 * Resets all sync states to initial.
 */
function resetAllStates(): void {
  syncStates.clear();
  lastSyncErrorMs = 0;
  clearSelfEvents();
}

/**
 * Gets the current sync status for popup display.
 * @returns The current video sync status
 */
function getCurrentSyncStatus(): VideoSyncStatus {
  if (!videoSyncEnabled) {
    return { enabled: false, trimMs: 0, state: 'off' };
  }

  // Find first non-NoData state
  for (const state of syncStates.values()) {
    if (state.kind === 'Locked') {
      return {
        enabled: true,
        trimMs: currentTrimMs,
        state: 'locked',
        lockedLatencyMs: state.lockedLatencyMs,
      };
    }
    if (state.kind === 'Acquiring') {
      return { enabled: true, trimMs: currentTrimMs, state: 'acquiring' };
    }
    if (state.kind === 'Stale') {
      return { enabled: true, trimMs: currentTrimMs, state: 'stale' };
    }
  }
  return { enabled: true, trimMs: currentTrimMs, state: 'off' };
}

/**
 * Broadcasts the current sync state to the popup.
 */
function broadcastSyncState(): void {
  const status = getCurrentSyncStatus();
  chrome.runtime
    .sendMessage({
      type: 'VIDEO_SYNC_STATE_CHANGED',
      ...status,
    })
    .catch(noop);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sample Window & Stability Gate
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new sample window.
 * Larger window (25) allows SE to converge despite RelTime quantization.
 * @param max
 * @returns The sample window
 */
function createSampleWindow(max: number = 25): SampleWindow {
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
 * Calculates median of an array of numbers.
 * @param xs
 * @returns The median value
 */
function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const n = sorted.length;
  return n % 2 !== 0 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
}

/**
 * Calculates mean of an array of numbers.
 * @param xs
 * @returns The mean value
 */
function mean(xs: number[]): number {
  if (xs.length === 0) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

/**
 * Calculates standard deviation of an array of numbers.
 * @param xs
 * @returns The standard deviation
 */
function stdev(xs: number[]): number {
  if (xs.length < 2) return Infinity;
  const m = mean(xs);
  const variance = mean(xs.map((x) => (x - m) * (x - m)));
  return Math.sqrt(variance);
}

/**
 * Calculates standard error of the mean.
 * SE = stdev / sqrt(N)
 *
 * This is the right metric under quantization noise because:
 * - Per-sample stdev is fixed (~289ms for 1s RelTime quantization)
 * - But SE decreases as we collect more samples
 * - With N=15, SE ≈ 75ms even with ~289ms stdev
 * @param xs
 * @returns The standard error
 */
function stderr(xs: number[]): number {
  if (xs.length < 2) return Infinity;
  return stdev(xs) / Math.sqrt(xs.length);
}

/**
 * Calculates median of absolute deltas between consecutive samples.
 * This measures "wiggle" without being affected by uniform quantization noise.
 * @param xs
 * @returns The median absolute delta
 */
function medianAbsDelta(xs: number[]): number {
  if (xs.length < 2) return Infinity;
  const deltas: number[] = [];
  for (let i = 1; i < xs.length; i++) {
    deltas.push(Math.abs(xs[i] - xs[i - 1]));
  }
  return median(deltas);
}

/**
 * Calculates median of latency values in the window.
 * @param window
 * @returns The median latency in ms
 */
function medianLatency(window: SampleWindow): number {
  return median(window.buf.map((s) => s.latencyMs));
}

/**
 * Calculates percentile of an array of numbers.
 * @param xs - Array of numbers
 * @param p - Percentile (0-1, e.g., 0.1 for p10)
 * @returns The percentile value
 */
function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const t = idx - lo;
  return sorted[lo] * (1 - t) + sorted[hi] * t;
}

/**
 * Calculates lock latency estimate using the 10th percentile with an adaptive floor.
 *
 * Why p10 instead of mean-500:
 * - Backend sends EMA-smoothed latency, not raw RelTime
 * - EMA dampens the 1s quantization sawtooth (observed sd ~120ms, not ~289ms)
 * - So "mean - 500ms" over-corrects massively (can go negative!)
 *
 * Since quantization adds a positive term, the lower tail (p10) is our best
 * proxy for true latency when we don't have raw second-boundary timing.
 *
 * The adaptive floor guards against unusually low samples:
 * - Uses min(250ms, spread * 0.5) as the clamp distance from median
 * - When spread is tight (~120ms), clamp is loose (effectively no-op)
 * - When spread is wide (~700ms), clamp is capped at 250ms
 *
 * @param window
 * @returns Chosen latency and diagnostic stats
 */
function lockLatencyWithStats(window: SampleWindow): {
  chosen: number;
  p10: number;
  med: number;
  floor: number;
  min: number;
  max: number;
} {
  const lat = window.buf.map((s) => s.latencyMs);
  const p10 = percentile(lat, 0.1);
  const med = median(lat);
  const min = Math.min(...lat);
  const max = Math.max(...lat);
  const spread = max - min;

  // Adaptive floor: proportional to spread, capped at 250ms
  const clamp = Math.min(250, spread * 0.5);
  const floor = med - clamp;
  const chosen = Math.round(Math.max(p10, floor));

  return { chosen, p10: Math.round(p10), med: Math.round(med), floor: Math.round(floor), min, max };
}

/** Minimum samples for SE to be meaningful under quantization */
const MIN_SAMPLES_FOR_LOCK = 15;

/**
 * Checks if the sample window passes the stability gate.
 *
 * Uses **standard error** (SE = stdev/√N) instead of raw stdev.
 * This is the correct metric under RelTime quantization because:
 * - Per-sample stdev is fixed at ~289ms (1s/√12 uniform noise)
 * - Raw stdev will NEVER drop below ~289ms no matter how stable
 * - But SE decreases with more samples: SE = 289/√15 ≈ 75ms
 *
 * Gate passes when:
 * - At least 15 samples (enough for SE to converge)
 * - SE <= 80ms (mean estimate is reliable)
 * - MAD <= 400ms (not going completely haywire - allows sawtooth jumps)
 *
 * @param window
 * @returns True if stability gate passes
 */
function passesStabilityGate(window: SampleWindow): boolean {
  const n = window.buf.length;
  if (n < MIN_SAMPLES_FOR_LOCK) {
    return false;
  }

  const latencies = window.buf.map((s) => s.latencyMs);
  const sd = stdev(latencies);
  const se = stderr(latencies);
  const mad = medianAbsDelta(latencies);

  // SE gate handles quantization noise (converges with more samples)
  // MAD is just a secondary "is it going nuts" guard (allows sawtooth)
  const seOk = se <= 80;
  const notCrazy = mad <= 400;
  const stable = seOk && notCrazy;

  log.debug(
    `Gate: n=${n}, sd=${sd.toFixed(0)}ms, se=${se.toFixed(0)}ms, mad=${mad.toFixed(0)}ms, pass=${stable}`,
  );

  return stable;
}

// ─────────────────────────────────────────────────────────────────────────────
// Video Element Detection
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Finds the best video element to sync.
 * Prioritizes: playing > paused, larger > smaller, visible > hidden
 * @returns The best video element or null
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
 * @returns True if target changed
 */
function updateTargetVideo(): boolean {
  const best = findBestVideo();
  if (best !== targetVideo) {
    targetVideo = best;
    return true;
  }
  return false;
}

/**
 * Starts periodic video element checking.
 * Only runs when video sync is enabled to avoid unnecessary DOM polling.
 */
function startVideoChecking(): void {
  if (videoCheckInterval) return;

  // Initial check
  updateTargetVideo();
  if (targetVideo) {
    log.info(`Initial video found: ${targetVideo.src || targetVideo.currentSrc || 'blob/stream'}`);
  }

  videoCheckInterval = setInterval(() => {
    const changed = updateTargetVideo();
    if (changed) {
      if (targetVideo) {
        log.info(
          `Target video changed: ${targetVideo.src || targetVideo.currentSrc || 'blob/stream'}`,
        );
        // Video element changed - clean up old listeners and re-acquire
        detachVideoEventListeners();
        // If we're locked, need to re-acquire
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
      } else {
        log.debug('No video element found on page');
        detachVideoEventListeners();
      }
    }
  }, 2000);
}

/**
 * Stops periodic video element checking.
 */
function stopVideoChecking(): void {
  if (videoCheckInterval) {
    clearInterval(videoCheckInterval);
    videoCheckInterval = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Coarse Alignment (Lock Transition)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Performs coarse alignment: pause -> wait delay -> play
 * Called only when transitioning to Locked state.
 *
 * CRITICAL: Anchors are recorded at PAUSE START, not after the wait.
 * This ensures that when we resume:
 *   elapsed = now - lockNowMs ≈ delayMs
 *   target = lockVideoTime + elapsed - delay ≈ lockVideoTime
 *   error = video.currentTime - target ≈ 0
 *
 * If we recorded anchors after the wait, error would immediately equal
 * the delay and we'd "double-delay" by trying to correct it.
 *
 * @param video
 * @param delayMs
 * @returns Lock anchors (timestamp and video time at pause)
 */
async function performCoarseAlignment(
  video: HTMLVideoElement,
  delayMs: number,
): Promise<{ lockNowMs: number; lockVideoTime: number }> {
  log.info(`Coarse alignment: pausing video for ${delayMs.toFixed(0)}ms`);

  // Record anchors at PAUSE START so the wait time is "counted" in elapsedSec
  const lockNowMs = performance.now();
  const lockVideoTime = video.currentTime;

  // Pause video (self-inflicted: must not stop the loop or trigger re-acquire)
  expectSelfEvent('pause');
  selfPauseUntilMs = performance.now() + delayMs + SELF_PAUSE_MARGIN_MS;
  video.pause();

  // Wait for the delay (this time is accounted for in elapsed calculation)
  await new Promise((resolve) => setTimeout(resolve, delayMs));

  log.info(`Coarse alignment: resuming at videoTime=${lockVideoTime.toFixed(2)}s`);

  // Resume playback (self-inflicted: the play event must not trigger re-acquire)
  expectSelfEvent('play');
  selfPauseUntilMs = 0;
  video.play().catch((err) => {
    log.warn('Play rejected (user interaction may be required):', err.message);
  });

  return { lockNowMs, lockVideoTime };
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Loop (Locked State)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Checks if any stream/speaker is in Locked state.
 * @returns True if any state is Locked
 */
function hasAnyLockedState(): boolean {
  for (const state of syncStates.values()) {
    if (state.kind === 'Locked') return true;
  }
  return false;
}

/**
 * Schedules the next sync loop tick.
 * Prefers requestVideoFrameCallback when available for frame-accurate timing.
 * @param video - The video element to schedule against
 * @param tick - The tick function to call
 */
function scheduleNextTick(video: HTMLVideoElement, tick: () => void): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyVideo = video as any;
  if (typeof anyVideo.requestVideoFrameCallback === 'function') {
    // RVFC: runs in sync with video frame presentation
    anyVideo.requestVideoFrameCallback(() => tick());
  } else {
    // Fallback: standard animation frame
    syncLoopId = requestAnimationFrame(tick);
  }
}

/**
 * Starts the sync control loop.
 *
 * Uses requestVideoFrameCallback when available for frame-accurate sync,
 * with requestAnimationFrame as fallback. RVFC runs in sync with actual
 * video frame presentation, reducing jitter and over-correction.
 */
function startSyncLoop(): void {
  if (syncLoopRunning) return;
  if (!targetVideo) return;

  syncLoopRunning = true;
  const loopVideo = targetVideo; // Capture for change detection

  const tick = (): void => {
    if (!syncLoopRunning) return;

    // If target changed or no Locked states remain, stop (caller can restart)
    if (!targetVideo || targetVideo !== loopVideo || !hasAnyLockedState()) {
      stopSyncLoop();
      return;
    }

    runSyncIteration();
    scheduleNextTick(loopVideo, tick);
  };

  scheduleNextTick(loopVideo, tick);
}

/**
 * Stops the sync control loop.
 */
function stopSyncLoop(): void {
  syncLoopRunning = false;
  if (syncLoopId !== null) {
    cancelAnimationFrame(syncLoopId);
    syncLoopId = null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Video Event Monitoring (Re-acquire on stall/seek/pause)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Transitions all Locked states to Acquiring (same epoch).
 * Used when video stalls, seeks, or otherwise loses sync anchor.
 * @param reason - Why we're re-acquiring (for logging)
 */
function triggerReAcquire(reason: string): void {
  log.info(`Re-acquiring sync: ${reason}`);

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

/**
 * Handles video seeking/seeked events.
 * Re-acquires sync since the anchor is now invalid - unless this is the
 * corrective seek we issued and the video landed where we asked it to.
 */
function handleVideoSeeking(): void {
  const video = targetVideo;
  if (video && consumeSelfSeek(video.currentTime)) {
    log.debug('Ignoring self-inflicted seeked event');
    return;
  }
  triggerReAcquire('video seeking');
}

/** How long to wait before deciding a waiting/stalled event has persisted */
const STALL_DEBOUNCE_MS = 400;

/** How often the stall check may be deferred while our own correction is in flight */
const MAX_STALL_CHECK_DEFERRALS = 3;

/**
 * Handles video waiting/stalled events.
 * Uses a "persisted" check: waits a short time and only re-acquires if still in trouble.
 * This avoids unnecessary relocks on one-frame hiccups from adaptive streaming.
 */
function handleVideoStalled(): void {
  // Only re-acquire if we're actually locked
  if (!hasAnyLockedState()) return;

  // Already have a pending check
  if (stallDebounceTimer) return;

  // Capture video at event time to detect target changes during wait
  scheduleStallCheck(targetVideo, 0);
}

/**
 * Schedules the debounced "is the video still in trouble?" check.
 * @param v0 - The video captured when the stall event fired (detects target changes)
 * @param deferrals - How many times this check has already been deferred
 */
function scheduleStallCheck(v0: HTMLVideoElement | null, deferrals: number): void {
  stallDebounceTimer = setTimeout(() => {
    stallDebounceTimer = null;
    const video = targetVideo;

    // Target changed during wait, or no target - let normal logic handle it
    if (!video || video !== v0) return;

    // Lock already gone - nothing to re-acquire
    if (!hasAnyLockedState()) return;

    // Track ended - let target-change logic handle it (not a real stall)
    if (video.ended) {
      log.debug('Ignoring waiting/stalled on ended video');
      return;
    }

    // Our own micro-pause or hard seek makes the video look paused/seeking/
    // under-buffered. That is not a stall, so re-check once the correction has
    // finished rather than dropping the lock (and give up after a few tries -
    // a real stall keeps firing waiting/stalled events).
    if (isSelfPauseActive() || hasPendingSelfSeek()) {
      if (deferrals < MAX_STALL_CHECK_DEFERRALS) {
        scheduleStallCheck(v0, deferrals + 1);
      } else {
        log.debug('Ignoring waiting/stalled: sync correction still in flight');
      }
      return;
    }

    // Still in trouble? (seeking, paused, or buffer empty)
    if (video.seeking || video.paused || video.readyState < 3) {
      triggerReAcquire(
        `video stalled/waiting (persisted: readyState=${video.readyState}, seeking=${video.seeking})`,
      );
    } else {
      log.debug('Ignoring transient waiting/stalled event');
    }
  }, STALL_DEBOUNCE_MS);
}

/**
 * Handles video pause event.
 * Stops sync loop (we're paused, nothing to sync).
 * Logs diagnostic info to distinguish user pause from autoplay/ads/track end.
 */
function handleVideoPause(): void {
  if (consumeSelfEvent('pause')) {
    log.debug('Ignoring self-inflicted pause event');
    return;
  }
  const video = targetVideo;
  if (video) {
    log.info(
      `Video paused: ended=${video.ended}, readyState=${video.readyState}, ` +
        `networkState=${video.networkState}, stopping sync loop`,
    );
  } else {
    log.info('Video paused, stopping sync loop');
  }
  stopSyncLoop();
}

/**
 * Handles video play event.
 * Re-acquires sync since we don't know how long we were paused.
 */
function handleVideoPlay(): void {
  // Skip if this is our own resume (coarse alignment or micro-pause)
  if (consumeSelfEvent('play')) {
    log.debug('Ignoring self-inflicted play event');
    // Make sure the loop is running again if we are locked (idempotent)
    if (hasAnyLockedState()) startSyncLoop();
    return;
  }

  // Only re-acquire if we were in Locked state
  let wasLocked = false;
  for (const state of syncStates.values()) {
    if (state.kind === 'Locked') {
      wasLocked = true;
      break;
    }
  }

  if (wasLocked) {
    triggerReAcquire('video resumed from pause');
  }
}

/**
 * Attaches event listeners to the target video for re-acquire triggers.
 * Uses AbortController for easy cleanup.
 * @param video - The video element to monitor
 */
function attachVideoEventListeners(video: HTMLVideoElement): void {
  // Skip if already monitoring this video
  if (monitoredVideo === video && videoEventController) {
    return;
  }

  // Clean up previous listeners
  detachVideoEventListeners();

  // Create new controller
  videoEventController = new AbortController();
  const { signal } = videoEventController;

  // Seeked: anchor is invalid (only listen to seeked, not seeking, to avoid spam)
  video.addEventListener('seeked', handleVideoSeeking, { signal });

  // Waiting/stalled: video fell behind, buffer empty
  video.addEventListener('waiting', handleVideoStalled, { signal });
  video.addEventListener('stalled', handleVideoStalled, { signal });

  // Pause/play: user control
  video.addEventListener('pause', handleVideoPause, { signal });
  video.addEventListener('play', handleVideoPlay, { signal });

  monitoredVideo = video;
  log.debug('Attached video event listeners');
}

/**
 * Detaches event listeners from the monitored video.
 */
function detachVideoEventListeners(): void {
  if (videoEventController) {
    videoEventController.abort();
    videoEventController = null;
  }
  monitoredVideo = null;

  // Clear debounce timer
  if (stallDebounceTimer) {
    clearTimeout(stallDebounceTimer);
    stallDebounceTimer = null;
  }
}

/**
 * Seeks the video forward to the sync target.
 *
 * Only one seek is in flight at a time: while it is outstanding the correction
 * is left to land rather than being re-issued on every frame. The `seeked` event
 * is ignored only if the video lands near `target`, so a page that clamps,
 * reverts or redirects the seek (ads, live edge, some MSE/DRM players) still
 * drops the lock and re-acquires, as it did before self-inflicted events were
 * filtered out.
 *
 * @param video - The video to seek
 * @param target - The video time the sync schedule wants
 */
function seekToTarget(video: HTMLVideoElement, target: number): void {
  // Previous seek has not landed yet - give it time instead of re-issuing it
  if (hasPendingSelfSeek()) return;

  log.info(`Seek correction: advancing by ${((target - video.currentTime) * 1000).toFixed(0)}ms`);
  pendingSelfSeek = { expiresAtMs: performance.now() + SELF_SEEK_TTL_MS, targetSec: target };
  video.currentTime = target;
}

/**
 * Pauses the video briefly to let audio catch up, then resumes.
 * Both events are self-inflicted and ignored by the re-acquire handlers.
 * @param video - The video to pause
 * @param pauseMs - How long to pause for
 */
function microPause(video: HTMLVideoElement, pauseMs: number): void {
  expectSelfEvent('pause');
  selfPauseUntilMs = performance.now() + pauseMs + SELF_PAUSE_MARGIN_MS;
  video.pause();
  setTimeout(() => {
    expectSelfEvent('play');
    selfPauseUntilMs = 0;
    video.play().catch(noop);
  }, pauseMs);
}

/**
 * Runs one iteration of the sync control loop.
 * Only operates in Locked state with a valid target video.
 */
function runSyncIteration(): void {
  if (!targetVideo) return;

  // Find the Locked state with the newest sample (handles multi-speaker/stale entries)
  let lockedState: Extract<VideoSyncState, { kind: 'Locked' }> | null = null;
  let newestSampleTime = 0;

  for (const state of syncStates.values()) {
    if (state.kind === 'Locked' && state.samples.buf.length > 0) {
      const lastSample = state.samples.buf[state.samples.buf.length - 1];
      if (lastSample.tMs > newestSampleTime) {
        newestSampleTime = lastSample.tMs;
        lockedState = state;
      }
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

  // Calculate error (positive = video ahead of target)
  const error = video.currentTime - target;

  // PlaybackRate fighting detection:
  // If we set a non-1.0 rate and the site snapped it back to 1.0, that's a fight.
  // After RATE_FIGHT_THRESHOLD consecutive fights, switch to pause mode.
  let currentRateMode = rateMode;
  if (rateMode === 'rate' && expectedPlaybackRate !== 1.0) {
    // We expected non-1.0, check if site snapped it back
    if (Math.abs(video.playbackRate - 1.0) < 0.001) {
      rateFightCount++;
      if (rateFightCount >= RATE_FIGHT_THRESHOLD) {
        log.warn(`PlaybackRate fighting detected (${rateFightCount}x), switching to pause mode`);
        currentRateMode = 'pause';
        // Update state to persist pause mode
        for (const [key, state] of syncStates.entries()) {
          if (state.kind === 'Locked' && state === lockedState) {
            syncStates.set(key, { ...state, rateMode: 'pause' });
          }
        }
      }
    } else {
      // Rate stuck, reset counter
      rateFightCount = 0;
    }
  }

  const errorMs = error * 1000;

  // Sync jump detection: log video state when error changes drastically
  // Only log when locked (we're actually syncing) and use 80ms threshold to reduce noise
  const JUMP_THRESHOLD_MS = 80;
  if (lockedState && Math.abs(errorMs - lastSyncErrorMs) > JUMP_THRESHOLD_MS) {
    log.warn(
      `Sync jump: ${lastSyncErrorMs.toFixed(0)}ms → ${errorMs.toFixed(0)}ms | ` +
        `readyState=${video.readyState}, networkState=${video.networkState}, ` +
        `seeking=${video.seeking}, paused=${video.paused}`,
    );
  }
  lastSyncErrorMs = errorMs;

  // Periodic logging (every ~2 seconds)
  if (now - lastSyncLogTime > 2000) {
    lastSyncLogTime = now;
    log.debug(
      `Sync: error=${errorMs.toFixed(1)}ms, rate=${video.playbackRate.toFixed(3)}, ` +
        `latency=${lockedLatencyMs.toFixed(0)}ms, mode=${currentRateMode}`,
    );
  }

  // Nothing to correct while paused (our own micro-pause is in progress,
  // or the site paused without an event). Resuming re-enters here.
  if (video.paused) return;

  // Apply correction based on error magnitude
  if (Math.abs(error) < C.ERROR_DEADBAND_SEC) {
    // Within deadband - no correction needed
    if (video.playbackRate !== 1.0) {
      video.playbackRate = 1.0;
      expectedPlaybackRate = 1.0;
    }
  } else if (Math.abs(error) > C.HARD_ERROR_THRESHOLD_SEC) {
    // Hard error - use seek or pause
    if (error < 0) {
      // Video behind - seek forward (bounded: one seek at a time, and a page
      // that clamps or reverts it re-acquires instead of being seeked again)
      seekToTarget(video, target);
    } else {
      // Video ahead - micro-pause
      const pauseMs = Math.min(C.MAX_MICRO_PAUSE_MS, error * 1000);
      log.info(`Hard correction: micro-pause for ${pauseMs.toFixed(0)}ms`);
      microPause(video, pauseMs);
    }
    expectedPlaybackRate = 1.0;
  } else {
    // Soft error - use playbackRate or micro-pause
    if (currentRateMode === 'rate') {
      // Proportional rate adjustment
      const adjustment = Math.max(-C.MAX_RATE_ADJUSTMENT, Math.min(C.MAX_RATE_ADJUSTMENT, -error));
      const newRate = 1.0 + adjustment;
      video.playbackRate = newRate;
      expectedPlaybackRate = newRate;
    } else {
      // Micro-pause mode (fallback when rate is fought)
      expectedPlaybackRate = 1.0;
      if (error > C.ERROR_DEADBAND_SEC) {
        const pauseMs = Math.min(C.MAX_MICRO_PAUSE_MS, (error - C.ERROR_DEADBAND_SEC) * 1000);
        microPause(video, pauseMs);
      }
      // Video behind by less than the hard threshold: nothing safe to do here.
      // playbackRate is unusable (the site fights it) and a seek takes longer to
      // land than the error is large, so it would leave the same error behind and
      // seek again forever. Real drift still crosses HARD_ERROR_THRESHOLD_SEC and
      // is corrected by the single seek above.
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
  // Guard: only process if video sync is enabled
  if (!videoSyncEnabled) return;

  const { streamId, speakerIp, epochId, latencyMs, jitterMs, confidence } = event;
  const state = getState(streamId, speakerIp);
  const now = performance.now();

  log.debug(
    `Latency event: ${latencyMs.toFixed(0)}ms (jitter=${jitterMs.toFixed(1)}, conf=${confidence.toFixed(2)}) [${state.kind}]`,
  );

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

      log.debug(
        `Acquiring: ${state.samples.buf.length}/${MIN_SAMPLES_FOR_LOCK} samples, median=${medianLatency(state.samples).toFixed(0)}ms`,
      );

      // A coarse alignment is already in flight (we are awaiting its pause/play).
      // Samples keep accumulating, but must not start a second alignment.
      if (coarseAlignmentInProgress) break;

      if (passesStabilityGate(state.samples)) {
        // Gate passed - transition to Locked
        // Use p10 (10th percentile) with adaptive floor - robust for EMA-smoothed values
        const stats = lockLatencyWithStats(state.samples);
        const chosenLatency = stats.chosen;
        const userTrim = currentTrimMs;

        // Diagnostic: show distribution and clamp effect
        log.info(
          `Lock stats: min=${stats.min.toFixed(0)} p10=${stats.p10.toFixed(0)} ` +
            `med=${stats.med.toFixed(0)} max=${stats.max.toFixed(0)}`,
        );
        log.info(
          `Lock choose: p10=${stats.p10.toFixed(0)} floor=${stats.floor.toFixed(0)} → chosen=${chosenLatency.toFixed(0)}ms`,
        );
        updateTargetVideo();

        if (targetVideo) {
          log.info(
            `Target video found: ${targetVideo.src || targetVideo.currentSrc || 'blob/stream'}`,
          );

          // Attach event listeners for re-acquire on stall/seek/pause
          attachVideoEventListeners(targetVideo);

          // Coarse alignment uses total delay (latency + userTrim)
          const alignedVideo = targetVideo;
          let anchors: { lockNowMs: number; lockVideoTime: number };
          coarseAlignmentInProgress = true;
          try {
            anchors = await performCoarseAlignment(alignedVideo, chosenLatency + userTrim);
          } finally {
            coarseAlignmentInProgress = false;
          }

          // While we were waiting the world may have moved on: epoch change,
          // stale event, sync disabled, or a different target video. Only lock
          // if this Acquiring state is still current and the video unchanged.
          const current = syncStates.get(stateKey(streamId, speakerIp));
          if (current !== state) {
            log.info(
              `State changed during coarse alignment (now ${current?.kind ?? 'none'}), not locking`,
            );
            break;
          }
          if (targetVideo !== alignedVideo) {
            log.info('Target video changed during coarse alignment, re-acquiring');
            setState(streamId, speakerIp, {
              kind: 'Acquiring',
              epochId,
              samples: createSampleWindow(),
            });
            break;
          }

          // Reset jump detection baseline
          lastSyncErrorMs = 0;

          setState(streamId, speakerIp, {
            kind: 'Locked',
            epochId,
            samples: state.samples,
            lockedLatencyMs: chosenLatency,
            // Use the latest trim: it may have changed during the alignment wait
            userTrimMs: currentTrimMs,
            lockNowMs: anchors.lockNowMs,
            lockVideoTime: anchors.lockVideoTime,
            rateMode: 'rate',
          });

          startSyncLoop();
          log.info('Sync loop started');
        } else {
          log.warn('Stability gate passed but no video element found, will retry');
          // Reset samples to prevent spamming - we'll try again after collecting fresh data
          const freshSamples = createSampleWindow();
          setState(streamId, speakerIp, { kind: 'Acquiring', epochId, samples: freshSamples });
        }
      }
      break;
    }

    case 'Locked': {
      // Check for epoch change
      if (epochId !== state.epochId) {
        // New epoch - go back to acquiring
        log.info(`Epoch changed ${state.epochId} → ${epochId}, re-acquiring`);
        detachVideoEventListeners();
        const samples = createSampleWindow();
        addSample(samples, sample);
        setState(streamId, speakerIp, { kind: 'Acquiring', epochId, samples });
        stopSyncLoop();
        break;
      }

      // Keep collecting samples (for potential re-acquire or debug)
      addSample(state.samples, sample);

      // NOTE: We intentionally do NOT adjust lockedLatencyMs based on sync error.
      //
      // The sync loop measures deviation from our SCHEDULE, not actual A/V offset.
      // If we slewed based on sync error:
      // - Sites that fight playbackRate would cause us to walk lockedLatencyMs
      //   in whatever direction makes the schedule "easier" to hit
      // - This could destroy actual A/V sync
      //
      // The playbackRate/micro-pause control loop handles schedule tracking.
      // lockedLatencyMs stays fixed at the value we locked with.
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

  log.warn(`Latency stale event received (epoch=${epochId}, current state=${state.kind})`);

  // Only transition to Stale from Locked or Acquiring with matching epoch
  if ((state.kind === 'Locked' || state.kind === 'Acquiring') && state.epochId === epochId) {
    const lockedLatencyMs = state.kind === 'Locked' ? state.lockedLatencyMs : 0;
    const userTrimMs = state.kind === 'Locked' ? state.userTrimMs : 0;

    // Clean up video listeners when leaving Locked state
    if (state.kind === 'Locked') {
      detachVideoEventListeners();
    }

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
  log.info('Video sync content script initialized');

  // Listen for messages from background
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // Latency events from desktop via background
    if (message.type === 'LATENCY_EVENT' && message.payload) {
      handleLatencyEvent(message.payload as LatencyBroadcastEvent);
      sendResponse({ success: true });
      return true;
    }

    // Video sync control messages from popup via background
    if (message.type === 'SET_VIDEO_SYNC_ENABLED') {
      const wasEnabled = videoSyncEnabled;
      const newEnabled = message.payload?.enabled ?? false;
      log.info(`SET_VIDEO_SYNC_ENABLED: ${wasEnabled} → ${newEnabled}`);
      videoSyncEnabled = newEnabled;

      if (!videoSyncEnabled && wasEnabled) {
        // Disable: stop everything, restore playbackRate
        stopSyncLoop();
        stopVideoChecking();
        detachVideoEventListeners();
        resetAllStates();
        if (targetVideo) targetVideo.playbackRate = 1.0;
        log.info('Video sync disabled');
      } else if (videoSyncEnabled && !wasEnabled) {
        startVideoChecking();
        log.info('Video sync enabled, waiting for latency events');
      }
      broadcastSyncState();
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'SET_VIDEO_SYNC_TRIM') {
      const newTrim = message.payload?.trimMs ?? 0;
      log.info(`SET_VIDEO_SYNC_TRIM: ${currentTrimMs} → ${newTrim}`);
      currentTrimMs = newTrim;
      // Apply to active locks: the sync loop reads userTrimMs from the locked
      // state, so the resulting error shift is absorbed by its normal control
      // logic - rate slew (rate mode) or micro-pause (pause mode) to delay the
      // video, rate slew to advance it - and a shift past the hard error
      // threshold seeks or micro-pauses directly. No re-alignment is needed.
      // Exception: in pause mode a sub-threshold trim that advances the video
      // cannot be applied (see runSyncIteration); it takes effect at the next lock.
      for (const [key, state] of syncStates.entries()) {
        if (state.kind === 'Locked' || state.kind === 'Stale') {
          syncStates.set(key, { ...state, userTrimMs: newTrim });
        }
      }
      broadcastSyncState();
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'TRIGGER_RESYNC') {
      log.info('TRIGGER_RESYNC received');
      if (videoSyncEnabled) {
        triggerReAcquire('manual resync');
      }
      sendResponse({ success: true });
      return true;
    }

    if (message.type === 'GET_VIDEO_SYNC_STATE') {
      const status = getCurrentSyncStatus();
      log.debug(`GET_VIDEO_SYNC_STATE: returning ${JSON.stringify(status)}`);
      sendResponse(status);
      return true;
    }

    return false;
  });
}

// Run initialization
init();
