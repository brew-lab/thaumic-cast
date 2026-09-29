/**
 * Speaker Health State Module
 *
 * Keeps the companion's latest verdict on the buffer of each speaker this
 * extension is casting to. The companion measures how much audio a speaker
 * holds ahead of its playhead and sends a `speakerHealth` network event every
 * 30 s and on every state change, with the notice (if any) it decided the user
 * should see. This module caches the latest reading per speaker so a freshly
 * opened popup can show the notice at once, and logs each reading so the
 * figures reach the extension's logs. Nothing is judged here: the companion
 * decides every notice.
 *
 * State is ephemeral (not persisted). Entries are dropped when the speaker
 * leaves every active cast and wholesale when the WebSocket drops.
 */

import { createLogger } from '@thaumic-cast/shared';
import type {
  SpeakerHealthChangedMessage,
  SpeakerHealthEntry,
  SpeakerHealthEvent,
} from '../lib/message-schemas';

export type { SpeakerHealthEntry } from '../lib/message-schemas';

const log = createLogger('SpeakerHealthState');

/** Latest reading per speaker IP. */
const entries = new Map<string, SpeakerHealthEntry>();

/**
 * Returns the current speaker-health snapshot keyed by speaker IP (read-only copy).
 * @returns Latest reading for every tracked speaker
 */
export function getSpeakerHealth(): Record<string, SpeakerHealthEntry> {
  return Object.fromEntries(entries);
}

/**
 * Records a `speakerHealth` event as the latest reading for its speaker,
 * carrying the companion's figures and notice through as sent. Logs a new
 * notice (a new `noticeId`) as a warning and every other reading at debug.
 * @param event - The companion's speaker-health event
 */
export function applySpeakerHealthEvent(event: SpeakerHealthEvent): void {
  const previous = entries.get(event.speakerIp);
  entries.set(event.speakerIp, {
    streamId: event.streamId,
    epochId: event.epochId,
    state: event.state,
    reserveMs: event.reserveMs,
    reservePrecisionMs: event.reservePrecisionMs,
    reserveMinMs: event.reserveMinMs,
    reserveP10Ms: event.reserveP10Ms,
    reserveAcked: event.reserveAcked,
    targetMs: event.targetMs,
    headStartMs: event.headStartMs,
    headStartConfiguredMs: event.headStartConfiguredMs,
    floorMs: event.floorMs,
    stallMs: event.stallMs,
    clockPpm: event.clockPpm,
    clockSePpm: event.clockSePpm,
    timeToFloorS: event.timeToFloorS,
    driftMode: event.driftMode,
    commandPpm: event.commandPpm,
    netInsertedMs: event.netInsertedMs,
    notice: event.notice,
    updatedAt: event.timestamp,
  });

  const notice = event.notice;
  const line =
    `Speaker ${event.speakerIp} buffer ${event.state}: ` +
    `reserve ${event.reserveMs ?? '?'}±${event.reservePrecisionMs ?? '?'} ms ` +
    `(p10 ${event.reserveP10Ms ?? '?'} ms${event.reserveAcked ? ' acked' : ''}, ` +
    `floor ${event.floorMs ?? '?'} ms, stall ${event.stallMs ?? '?'} ms), ` +
    `head start ${event.headStartMs ?? '?'}/${event.headStartConfiguredMs ?? '?'} ms, ` +
    `clock ${event.clockPpm?.toFixed(1) ?? '?'} ppm, floor in ${event.timeToFloorS ?? '—'} s` +
    (event.driftMode
      ? `, drift ${event.driftMode} ${event.commandPpm?.toFixed(1) ?? '?'} ppm` +
        (event.netInsertedMs !== undefined ? ` (${event.netInsertedMs} ms inserted)` : '')
      : '') +
    (notice ? `, notice ${notice.kind} #${notice.noticeId}` : '');
  const isNewNotice =
    notice !== undefined &&
    (previous?.notice?.noticeId !== notice.noticeId || previous.streamId !== event.streamId);
  if (isNewNotice) {
    log.warn(line);
  } else {
    log.debug(line);
  }
}

/**
 * Drops the reading for a speaker. Called when the speaker leaves every
 * active cast.
 * @param speakerIp - The speaker whose reading to drop
 * @returns True if a reading was dropped (caller should broadcast)
 */
export function clearSpeakerHealth(speakerIp: string): boolean {
  return entries.delete(speakerIp);
}

/**
 * Drops every reading. Called when the WebSocket drops, since the companion's
 * verdicts are only meaningful while it is connected and reporting.
 * @returns True if any reading was dropped (caller should broadcast)
 */
export function clearAllSpeakerHealth(): boolean {
  if (entries.size === 0) return false;
  entries.clear();
  return true;
}

/**
 * Builds the popup broadcast payload from the current state. Single source
 * of truth for the `SPEAKER_HEALTH_CHANGED` shape.
 * @returns The broadcast message reflecting the current state
 */
export function speakerHealthBroadcast(): SpeakerHealthChangedMessage {
  return { type: 'SPEAKER_HEALTH_CHANGED', speakers: getSpeakerHealth() };
}
