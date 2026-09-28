/**
 * Speaker Health State Module
 *
 * Keeps the companion's latest verdict on the buffer of each speaker this
 * extension is casting to. The companion measures how much audio a speaker
 * holds ahead of its playhead and sends a `speakerHealth` network event every
 * 30 s and on every state change; this module caches the latest reading per
 * speaker so a freshly opened popup can warn at once, and logs each reading
 * so the figures reach the extension's logs.
 *
 * State is ephemeral (not persisted). Entries are dropped when the speaker
 * leaves every active cast and wholesale when the WebSocket drops, like the
 * link-quality readings beside them.
 */

import { createLogger } from '@thaumic-cast/shared';
import type { SpeakerHealthState } from '@thaumic-cast/protocol';
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
 * Whether a state warrants warning the user: the speaker's buffer is running
 * low or is on course to run dry.
 * @param state - The companion's verdict
 * @returns True for `low` and `draining`
 */
export function isSpeakerHealthAlarm(state: SpeakerHealthState): boolean {
  return state === 'low' || state === 'draining';
}

/**
 * Returns the current speaker-health snapshot keyed by speaker IP (read-only copy).
 * @returns Latest reading for every tracked speaker
 */
export function getSpeakerHealth(): Record<string, SpeakerHealthEntry> {
  return Object.fromEntries(entries);
}

/**
 * Records a `speakerHealth` event as the latest reading for its speaker.
 * While consecutive readings stay `low` or `draining`, `alarmSince` keeps the
 * timestamp of the first of them, so a dismissed warning stays dismissed
 * through the repeats and returns only after the speaker has recovered and
 * run low again.
 * @param event - The companion's speaker-health event
 */
export function applySpeakerHealthEvent(event: SpeakerHealthEvent): void {
  const previous = entries.get(event.speakerIp);
  const alarm = isSpeakerHealthAlarm(event.state);
  const alarmSince = alarm ? (previous?.alarmSince ?? event.timestamp) : undefined;
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
    clockPpm: event.clockPpm,
    clockSePpm: event.clockSePpm,
    timeToEmptyS: event.timeToEmptyS,
    updatedAt: event.timestamp,
    alarmSince,
  });

  const line =
    `Speaker ${event.speakerIp} buffer ${event.state}: ` +
    `reserve ${event.reserveMs ?? '?'}±${event.reservePrecisionMs ?? '?'} ms ` +
    `(p10 ${event.reserveP10Ms ?? '?'} ms${event.reserveAcked ? ' acked' : ''}, ` +
    `target ${event.targetMs ?? '?'} ms), clock ${event.clockPpm?.toFixed(1) ?? '?'} ppm, ` +
    `empty in ${event.timeToEmptyS ?? '—'} s`;
  if (alarm && previous?.state !== event.state) {
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
