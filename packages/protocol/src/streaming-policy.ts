/**
 * Streaming Policy Module
 *
 * Centralizes buffer sizing, drop thresholds, and backpressure behavior
 * based on latency mode. This provides a single source of truth for all
 * tunable constants in the audio streaming pipeline.
 *
 * Policy derivation:
 * - 'quality' mode: Larger buffers, no catch-up, pause on backpressure (for music)
 * - 'realtime' mode: Smaller buffers, bounded latency, drop on backpressure (for sync)
 */

import type { LatencyMode } from './audio.js';

/**
 * Frame queue hysteresis ratio for quality mode.
 * When the frame queue exceeds max size, it trims to this fraction of max
 * to prevent oscillation (repeatedly hitting the cap).
 */
export const FRAME_QUEUE_HYSTERESIS_RATIO = 0.67;

/**
 * Streaming policy configuration derived from latency mode.
 * Centralizes buffer sizing, drop thresholds, and backpressure behavior.
 */
export interface StreamingPolicy {
  /** Ring buffer duration in seconds. */
  ringBufferSeconds: number;

  /** Bounded latency: max buffer depth before catch-up (ms), or null to disable. */
  catchUpMaxMs: number | null;
  /** Bounded latency: target depth after catch-up (ms). */
  catchUpTargetMs: number;

  /** Backpressure: max pending encode operations. */
  maxEncodeQueue: number;
  /** Backpressure: WebSocket buffer threshold (bytes). */
  wsBufferHighWater: number;
  /** Backpressure: whether to drop frames (true) or pause (false). */
  dropOnBackpressure: boolean;

  /** Max frames the server cadence queue can hold, expressed in ms. Sent in handshake. */
  queueCapacityMs: number;
}

/**
 * Policy for quality-optimized streaming (music, podcasts).
 * Prioritizes audio continuity over bounded latency.
 */
const QUALITY_POLICY: StreamingPolicy = {
  ringBufferSeconds: 10,
  catchUpMaxMs: null, // Never catch up - let buffer grow
  catchUpTargetMs: 200, // Unused when catchUpMaxMs is null
  maxEncodeQueue: 16, // More lenient queue
  wsBufferHighWater: 2_097_152, // 2 MiB before pausing
  dropOnBackpressure: false, // Queue frames instead of drop
  queueCapacityMs: 0,
};

/**
 * Policy for realtime streaming (video sync, gaming, low-latency).
 * Prioritizes bounded latency over audio continuity.
 */
const REALTIME_POLICY: StreamingPolicy = {
  ringBufferSeconds: 3,
  catchUpMaxMs: 1000, // Catch up when >1s behind
  catchUpTargetMs: 200, // Target 200ms after catch-up
  maxEncodeQueue: 8, // Tight queue
  wsBufferHighWater: 256_000, // 256KB before dropping
  dropOnBackpressure: true, // Drop to maintain timing
  queueCapacityMs: 0,
};

/**
 * Returns the streaming policy for a given latency mode.
 * @param mode - The latency mode from encoder config
 * @returns The appropriate streaming policy
 */
export function getStreamingPolicy(mode: LatencyMode): StreamingPolicy {
  return mode === 'realtime' ? REALTIME_POLICY : QUALITY_POLICY;
}
