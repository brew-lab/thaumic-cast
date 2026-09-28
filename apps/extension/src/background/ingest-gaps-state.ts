/**
 * Ingest Gaps State Module
 *
 * Keeps the companion's latest `ingestGaps` report for each stream this
 * extension owns. The companion sends one when audio from this browser reached
 * it late often enough that every speaker on the stream had a gap (the stream's
 * smoothing ran dry at least twice in a minute), at most once every ten
 * minutes, with the smoothing step that would have covered the worst gap. This
 * module caches it so a popup opened afterwards can still show the notice.
 *
 * State is ephemeral (not persisted). An entry is dropped when its stream's
 * cast ends, and every entry when the WebSocket drops.
 */

import { createLogger } from '@thaumic-cast/shared';
import type { StreamEvent } from '@thaumic-cast/protocol';
import type { IngestGapsChangedMessage, IngestGapsEntry } from '../lib/message-schemas';

export type { IngestGapsEntry } from '../lib/message-schemas';

/** The `ingestGaps` variant of the companion's stream event. */
export type IngestGapsEvent = Extract<StreamEvent, { type: 'ingestGaps' }>;

const log = createLogger('IngestGapsState');

/** Latest report per stream ID. */
const entries = new Map<string, IngestGapsEntry>();

/**
 * Returns the current ingest-gaps snapshot keyed by stream ID (read-only copy).
 * @returns Latest report for every tracked stream
 */
export function getIngestGaps(): Record<string, IngestGapsEntry> {
  return Object.fromEntries(entries);
}

/**
 * Records an `ingestGaps` event as the latest report for its stream.
 * @param event - The companion's ingest-gaps event
 * @param receivedAt - This browser's clock when the event arrived
 */
export function applyIngestGapsEvent(event: IngestGapsEvent, receivedAt: number): void {
  entries.set(event.streamId, {
    gapsLastMinute: event.gapsLastMinute,
    worstGapMs: event.worstGapMs,
    smoothingMs: event.smoothingMs,
    ...(event.suggestedSmoothingMs !== undefined && {
      suggestedSmoothingMs: event.suggestedSmoothingMs,
    }),
    receivedAt,
  });
  log.warn(
    `Audio for stream ${event.streamId} reached the companion late ` +
      `${event.gapsLastMinute} times in the last minute (worst ${event.worstGapMs} ms, ` +
      `smoothing ${event.smoothingMs} ms, suggested ${event.suggestedSmoothingMs ?? 'none'})`,
  );
}

/**
 * Drops the report for a stream. Called when its cast ends.
 * @param streamId - The stream whose report to drop
 * @returns True if a report was dropped (caller should broadcast)
 */
export function clearIngestGaps(streamId: string): boolean {
  return entries.delete(streamId);
}

/**
 * Drops every report. Called when the WebSocket drops.
 * @returns True if any report was dropped (caller should broadcast)
 */
export function clearAllIngestGaps(): boolean {
  if (entries.size === 0) return false;
  entries.clear();
  return true;
}

/**
 * Builds the popup broadcast payload from the current state. Single source
 * of truth for the `INGEST_GAPS_CHANGED` shape.
 * @returns The broadcast message reflecting the current state
 */
export function ingestGapsBroadcast(): IngestGapsChangedMessage {
  return { type: 'INGEST_GAPS_CHANGED', streams: getIngestGaps() };
}
