// ─────────────────────────────────────────────────────────────────────────────
// Video Sync Types (for A/V delay compensation)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A single latency sample for the stability gate.
 */
export interface LatencySample {
  latencyMs: number;
  jitterMs: number;
  confidence: number;
  /** Timestamp when sample was received (performance.now()) */
  tMs: number;
}

/**
 * Rolling window of latency samples for stability detection.
 */
export interface SampleWindow {
  buf: LatencySample[];
  /** Maximum samples to keep */
  max: number;
}

/**
 * Video sync state machine states.
 *
 * State transitions:
 * - NoData → Acquiring (on first Updated event)
 * - Acquiring → Locked (when stability gate passes)
 * - Locked → Stale (on Stale event)
 * - Stale → Acquiring (on Updated event, same or different epoch)
 * - Any → Acquiring (on epoch change)
 */
export type VideoSyncState =
  | { kind: 'NoData' }
  | {
      kind: 'Acquiring';
      epochId: number;
      samples: SampleWindow;
    }
  | {
      kind: 'Locked';
      epochId: number;
      /** Rolling sample window for windowed median (slew target) */
      samples: SampleWindow;
      /** Locked latency value in ms (used for video delay) */
      lockedLatencyMs: number;
      /** User-adjustable trim in ms (positive = more delay) */
      userTrimMs: number;
      /** performance.now() when lock was established */
      lockNowMs: number;
      /** video.currentTime when lock was established */
      lockVideoTime: number;
      /** Control mode: 'rate' for playbackRate, 'pause' for micro-pauses */
      rateMode: 'rate' | 'pause';
    }
  | {
      kind: 'Stale';
      epochId: number;
      /** Last known latency (preserved for UI display) */
      lockedLatencyMs: number;
      /** User trim preserved across stale */
      userTrimMs: number;
      /** When stale was detected (performance.now()) */
      sinceMs: number;
    };

/**
 * Constants for the video sync stability gate.
 */
export const VIDEO_SYNC_CONSTANTS = {
  /** Minimum confidence required for each sample */
  MIN_CONFIDENCE: 0.7,
  /** Maximum jitter (ms) allowed for each sample */
  MAX_JITTER_MS: 120,
  /** Maximum deviation from median (ms) for stability */
  MAX_MEDIAN_DEVIATION_MS: 80,
  /** Number of samples required to pass stability gate */
  REQUIRED_SAMPLES: 5,
  /** Deadband for locked state - ignore changes smaller than this */
  LOCK_DEADBAND_MS: 80,
  /** Maximum slew rate when adjusting locked latency (ms per second) */
  SLEW_RATE_MS_PER_SEC: 20,
  /** Deadband for video sync error (seconds) */
  ERROR_DEADBAND_SEC: 0.12,
  /** Hard error threshold for seek/pause (seconds) */
  HARD_ERROR_THRESHOLD_SEC: 1.0,
  /** Maximum micro-pause duration (ms) */
  MAX_MICRO_PAUSE_MS: 250,
  /** Maximum playback rate adjustment (±5%) */
  MAX_RATE_ADJUSTMENT: 0.05,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Video Sync Status (for popup display)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Video sync status for popup display.
 * Represents the current state of per-cast video sync.
 */
export interface VideoSyncStatus {
  /** Whether video sync is enabled for this cast */
  enabled: boolean;
  /** User trim adjustment in milliseconds */
  trimMs: number;
  /** Current sync state */
  state: 'off' | 'acquiring' | 'locked' | 'stale';
  /** Locked latency in ms (only when state is 'locked') */
  lockedLatencyMs?: number;
}
