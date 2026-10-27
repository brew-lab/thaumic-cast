/**
 * Cast Moved State Module
 *
 * Keeps, for each stream this extension owns, when the companion last said
 * its cast moved: the household's Sonos UPnP was switched off mid-cast, so
 * the companion started the cast again over the speakers' local connection
 * (port 1443), and listeners may have heard a short skip. This module caches
 * it so a popup opened afterwards can still say so.
 *
 * State is ephemeral (not persisted). An entry is dropped when its stream's
 * cast ends, and every entry when the WebSocket drops.
 */

import { createLogger } from '@thaumic-cast/shared';
import type { CastMovedChangedMessage, CastMovedEntry } from '../lib/message-schemas';

export type { CastMovedEntry } from '../lib/message-schemas';

const log = createLogger('CastMovedState');

/** When each stream's cast last moved. */
const entries = new Map<string, CastMovedEntry>();

/**
 * Returns the current snapshot keyed by stream ID (read-only copy).
 * @returns When each tracked stream's cast last moved
 */
export function getCastMoved(): Record<string, CastMovedEntry> {
  return Object.fromEntries(entries);
}

/**
 * Records that a stream's cast moved.
 * @param streamId - The stream whose cast moved
 * @param receivedAt - This browser's clock when the event arrived
 */
export function applyCastMoved(streamId: string, receivedAt: number): void {
  entries.set(streamId, { receivedAt });
  log.warn(`Cast of stream ${streamId} moved to the speakers' local connection (UPnP off)`);
}

/**
 * Drops the entry for a stream. Called when its cast ends.
 * @param streamId - The stream whose entry to drop
 * @returns True if an entry was dropped (caller should broadcast)
 */
export function clearCastMoved(streamId: string): boolean {
  return entries.delete(streamId);
}

/**
 * Drops every entry. Called when the WebSocket drops.
 * @returns True if any entry was dropped (caller should broadcast)
 */
export function clearAllCastMoved(): boolean {
  if (entries.size === 0) return false;
  entries.clear();
  return true;
}

/**
 * Builds the popup broadcast payload from the current state. Single source
 * of truth for the `CAST_MOVED_CHANGED` shape.
 * @returns The broadcast message reflecting the current state
 */
export function castMovedBroadcast(): CastMovedChangedMessage {
  return { type: 'CAST_MOVED_CHANGED', streams: getCastMoved() };
}
