/**
 * Speaker Link Quality State Module
 *
 * Keeps the companion's latest verdict on the network path to each speaker
 * this extension is casting to. The companion measures its own round trips
 * to a speaker and sends a `speakerLinkQuality` network event on each
 * transition between good, degraded and poor; this module caches the latest
 * reading per speaker so a freshly opened popup can render the alert without
 * waiting for the next transition.
 *
 * State is ephemeral (not persisted). Entries are dropped when the speaker
 * leaves every active cast and wholesale when the WebSocket drops, since the
 * companion only reports on speakers that are playing a stream.
 */

import { createLogger } from '@thaumic-cast/shared';
import type {
  SpeakerLinkQualityChangedMessage,
  SpeakerLinkQualityEvent,
  SpeakerLinkQualityState,
} from '../lib/message-schemas';

export type { SpeakerLinkQualityState } from '../lib/message-schemas';

const log = createLogger('SpeakerLinkQualityState');

/** Latest reading per speaker IP. */
const entries = new Map<string, SpeakerLinkQualityState>();

/**
 * Returns the current link-quality snapshot keyed by speaker IP (read-only copy).
 * @returns Latest reading for every tracked speaker
 */
export function getSpeakerLinkQuality(): Record<string, SpeakerLinkQualityState> {
  return Object.fromEntries(entries);
}

/**
 * Records a `speakerLinkQuality` event as the latest reading for its speaker.
 * The companion's numbers are carried through as sent, including its buffer
 * suggestion when it made one; the event's timestamp becomes `updatedAt`,
 * the popup's dismissal key.
 * @param event - The companion's link-quality event
 */
export function applySpeakerLinkQualityEvent(event: SpeakerLinkQualityEvent): void {
  entries.set(event.speakerIp, {
    quality: event.quality,
    rttMedianMs: event.rttMedianMs,
    rttMaxMs: event.rttMaxMs,
    spikesPerMinute: event.spikesPerMinute,
    failuresPerMinute: event.failuresPerMinute,
    jitterBufferMs: event.jitterBufferMs,
    ...(event.suggestedJitterBufferMs !== undefined && {
      suggestedJitterBufferMs: event.suggestedJitterBufferMs,
    }),
    updatedAt: event.timestamp,
  });
  log.info(
    `Link to ${event.speakerIp} is ${event.quality} ` +
      `(rtt median ${event.rttMedianMs} ms, max ${event.rttMaxMs} ms, ` +
      `${event.spikesPerMinute} troubled samples/min, ` +
      `${event.failuresPerMinute} retransmission timeouts/min, ` +
      `buffer ${event.jitterBufferMs} ms` +
      (event.suggestedJitterBufferMs !== undefined
        ? `, suggested ${event.suggestedJitterBufferMs} ms)`
        : ')'),
  );
}

/**
 * Drops the reading for a speaker. Called when the speaker leaves every
 * active cast, since the companion stops reporting on it.
 * @param speakerIp - The speaker whose reading to drop
 * @returns True if a reading was dropped (caller should broadcast)
 */
export function clearSpeakerLinkQuality(speakerIp: string): boolean {
  return entries.delete(speakerIp);
}

/**
 * Drops every reading. Called when the WebSocket drops, since the companion's
 * verdicts are only meaningful while it is connected and reporting.
 * @returns True if any reading was dropped (caller should broadcast)
 */
export function clearAllSpeakerLinkQuality(): boolean {
  if (entries.size === 0) return false;
  entries.clear();
  return true;
}

/**
 * Builds the popup broadcast payload from the current state. Single source
 * of truth for the `SPEAKER_LINK_QUALITY_CHANGED` shape — callers that
 * change state through the functions above should broadcast by passing this
 * result to `notifyPopup`.
 * @returns The broadcast message reflecting the current state
 */
export function speakerLinkQualityBroadcast(): SpeakerLinkQualityChangedMessage {
  return { type: 'SPEAKER_LINK_QUALITY_CHANGED', speakers: getSpeakerLinkQuality() };
}
