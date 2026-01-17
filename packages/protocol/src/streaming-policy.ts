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

  /** Pause mode: resume threshold for WebSocket buffer (bytes). */
  wsBufferResumeThreshold: number;

  /** Server-side streaming buffer size (ms). Sent in handshake. */
  streamingBufferMs: number;
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
  wsBufferHighWater: 512_000, // 512KB before pausing
  dropOnBackpressure: false, // Pause instead of drop
  wsBufferResumeThreshold: 128_000, // Resume at 128KB (hysteresis)
  streamingBufferMs: 500, // Larger server buffer for jitter tolerance
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
  wsBufferResumeThreshold: 128_000, // Not used in realtime mode
  streamingBufferMs: 200, // Tighter server buffer for lower latency
};

/**
 * Returns the streaming policy for a given latency mode.
 * @param mode - The latency mode from encoder config
 * @returns The appropriate streaming policy
 */
export function getStreamingPolicy(mode: LatencyMode): StreamingPolicy {
  return mode === 'realtime' ? REALTIME_POLICY : QUALITY_POLICY;
}
