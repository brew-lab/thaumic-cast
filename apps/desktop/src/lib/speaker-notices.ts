/**
 * Speaker Notice Wording, Dismissal and the Head Start Ladder
 *
 * The core decides every speaker notice and sends the figures its wording
 * needs; this module only picks the words and remembers what the user
 * dismissed. It follows the extension's rules (`apps/extension/src/lib/
 * speaker-notices.ts`), with one difference in wording: the head start is
 * changed right here, so a head-start notice points at Settings > Speakers
 * rather than naming the desktop app.
 *
 * Dismissal: a notice is dismissed by `(streamId, speakerIp, noticeId)`, which
 * holds while the core repeats it and lapses on a new episode or an
 * escalation. A dismissed head-start notice is also remembered for 24 hours
 * by `(speakerIp, kind, suggestedHeadStartMs)`, so the same advice does not
 * return on the next cast; advice to go higher still does. Dismissals live in
 * memory and last for the app run.
 */

import type { SpeakerNotice } from '@thaumic-cast/protocol';

/**
 * The speaker head starts the settings select offers, in ms, `0` being off.
 * The non-zero steps match `HEAD_START_LADDER_MS` in thaumic-core, the steps
 * a head-start notice suggests.
 */
export const HEAD_START_OPTIONS_MS: readonly number[] = [0, 250, 500, 750, 1000, 1500, 2000];

/** One option of the head start select. */
export interface HeadStartOption {
  /** The head start, in ms. */
  ms: number;
  /** Whether the value is off the ladder (set in the settings file), shown as custom. */
  custom: boolean;
}

/**
 * The options the head start select shows: the ladder, plus the current value
 * as a custom option when it is off the ladder, in order.
 * @param currentMs - The head start in effect, in ms
 * @returns The options, sorted by value
 */
export function headStartOptions(currentMs: number): HeadStartOption[] {
  const options = HEAD_START_OPTIONS_MS.map((ms) => ({ ms, custom: false }));
  if (!HEAD_START_OPTIONS_MS.includes(currentMs)) {
    options.push({ ms: currentMs, custom: true });
    options.sort((a, b) => a.ms - b.ms);
  }
  return options;
}

/** The latest notice the core stands for one speaker. */
export interface SpeakerNoticeReading {
  /** The stream the speaker is playing. */
  streamId: string;
  /** The notice, absent when there is nothing to tell the user. */
  notice?: SpeakerNotice;
}

/** Speaker IP → the stream it is playing now, from the playback sessions. */
export type SpeakerStreams = Record<string, string>;

/**
 * Drops readings that no longer describe a cast: the speaker has stopped, or
 * it now plays a different stream than the one the reading is about.
 * @param readings - Latest reading per speaker IP
 * @param streams - The stream each casting speaker plays now
 * @returns The readings still current, or `readings` itself when all are
 */
export function currentReadings(
  readings: Record<string, SpeakerNoticeReading>,
  streams: SpeakerStreams,
): Record<string, SpeakerNoticeReading> {
  const kept = Object.entries(readings).filter(
    ([speakerIp, reading]) => streams[speakerIp] === reading.streamId,
  );
  if (kept.length === Object.keys(readings).length) return readings;
  return Object.fromEntries(kept);
}

/** How long a dismissed head-start notice stays dismissed across casts. */
export const HEAD_START_NOTICE_MEMORY_MS = 24 * 60 * 60 * 1000;

/** One translatable sentence of a notice. */
export interface NoticeLine {
  /** i18n key. */
  key: string;
  /** Interpolation values; every figure is in ms unless the key says otherwise. */
  params?: Record<string, string | number>;
}

/** What the wording of a notice depends on besides the notice itself. */
export interface NoticeWordingContext {
  /** Room or group name to show for the speaker. */
  speakerName: string;
  /** Whether THAUMIC_PCM_CONNECT_BURST_MS fixes the head start. */
  headStartFixed: boolean;
}

/**
 * Whether a notice suggests a head start the user can pick in Settings, so
 * the notice offers a button that goes there.
 * @param notice - The core's notice
 * @param headStartFixed - Whether an environment variable fixes the head start
 * @returns True for a head-start notice with a suggestion, unless the setting is fixed
 */
export function noticeOffersSettings(notice: SpeakerNotice, headStartFixed: boolean): boolean {
  return (
    !headStartFixed &&
    (notice.kind === 'head_start_ran_out' || notice.kind === 'head_start_close') &&
    notice.suggestedHeadStartMs !== undefined
  );
}

/**
 * Words a speaker notice as the sentences the dashboard joins into one message.
 * @param notice - The core's notice
 * @param ctx - The wording context
 * @returns The sentences, in order
 */
export function speakerNoticeLines(notice: SpeakerNotice, ctx: NoticeWordingContext): NoticeLine[] {
  const name = ctx.speakerName;
  const lines: NoticeLine[] = [];
  const stall = notice.stallMs ?? 0;
  const current = notice.headStartMs ?? 0;
  const left = Math.max(0, notice.leftMs ?? 0);
  const suggested = notice.suggestedHeadStartMs;
  const off = current === 0 ? '_off' : '';

  switch (notice.kind) {
    case 'head_start_ran_out':
    case 'head_start_close':
      if (suggested === undefined) {
        // Only the no-remedy kind should lack a suggestion; say that rather
        // than suggest nothing.
        lines.push({
          key: 'dashboard.speaker_notice_head_start_no_remedy',
          params: { stall, name },
        });
        break;
      }
      lines.push({
        key: `dashboard.speaker_notice_${notice.kind}${off}`,
        params: { stall, name, current, left, suggested },
      });
      lines.push({
        key: ctx.headStartFixed
          ? 'dashboard.speaker_notice_where_fixed'
          : 'dashboard.speaker_notice_where',
      });
      break;
    case 'head_start_no_remedy':
      lines.push({ key: 'dashboard.speaker_notice_head_start_no_remedy', params: { stall, name } });
      break;
    case 'running_low':
      lines.push({ key: 'dashboard.speaker_notice_running_low', params: { name, left } });
      break;
    case 'drift_uncorrected':
    case 'drift_saturated':
      lines.push({
        key: `dashboard.speaker_notice_${notice.kind}`,
        params: { name, minutes: Math.max(1, notice.minutes ?? 1) },
      });
      break;
  }

  if (notice.restartHelps) lines.push({ key: 'dashboard.speaker_notice_restart_refills' });
  return lines;
}

/** Dismissed notices, kept for the app run. */
export interface SpeakerNoticeDismissals {
  /** `streamId|speakerIp|noticeId` → when it was dismissed. */
  byNotice: Record<string, number>;
  /** `speakerIp|kind|suggested` → when the memory lapses (head-start kinds only). */
  headStart: Record<string, number>;
}

/**
 * An empty set of dismissals.
 * @returns No dismissals
 */
export function emptyDismissals(): SpeakerNoticeDismissals {
  return { byNotice: {}, headStart: {} };
}

/**
 * The key a notice episode is dismissed by.
 * @param streamId - The stream the speaker is playing
 * @param speakerIp - The speaker
 * @param notice - The notice
 * @returns The episode key
 */
function episodeKey(streamId: string, speakerIp: string, notice: SpeakerNotice): string {
  return `${streamId}|${speakerIp}|${notice.noticeId}`;
}

/**
 * The key a head-start notice's advice is remembered by across casts.
 * @param speakerIp - The speaker
 * @param notice - The notice
 * @returns The advice key, or null for kinds that are not about the head start
 */
function headStartKey(speakerIp: string, notice: SpeakerNotice): string | null {
  if (
    notice.kind !== 'head_start_ran_out' &&
    notice.kind !== 'head_start_close' &&
    notice.kind !== 'head_start_no_remedy'
  ) {
    return null;
  }
  return `${speakerIp}|${notice.kind}|${notice.suggestedHeadStartMs ?? '-'}`;
}

/**
 * Whether the user has dismissed a notice: this episode of it, or, for a
 * head-start notice, the same advice for the same speaker within 24 hours.
 * @param dismissals - The dismissals so far
 * @param streamId - The stream the speaker is playing
 * @param speakerIp - The speaker
 * @param notice - The notice
 * @param now - The current time
 * @returns True if the notice should stay hidden
 */
export function isNoticeDismissed(
  dismissals: SpeakerNoticeDismissals,
  streamId: string,
  speakerIp: string,
  notice: SpeakerNotice,
  now: number,
): boolean {
  if (dismissals.byNotice[episodeKey(streamId, speakerIp, notice)] !== undefined) return true;
  const key = headStartKey(speakerIp, notice);
  const until = key === null ? undefined : dismissals.headStart[key];
  return until !== undefined && until > now;
}

/**
 * Records a dismissal, dropping entries older than the 24-hour memory so a
 * long app run does not collect them without bound.
 * @param dismissals - The dismissals so far
 * @param streamId - The stream the speaker is playing
 * @param speakerIp - The speaker
 * @param notice - The notice being dismissed
 * @param now - The current time
 * @returns The new dismissals
 */
export function dismissNotice(
  dismissals: SpeakerNoticeDismissals,
  streamId: string,
  speakerIp: string,
  notice: SpeakerNotice,
  now: number,
): SpeakerNoticeDismissals {
  const byNotice: Record<string, number> = {};
  for (const [key, at] of Object.entries(dismissals.byNotice)) {
    if (now - at < HEAD_START_NOTICE_MEMORY_MS) byNotice[key] = at;
  }
  byNotice[episodeKey(streamId, speakerIp, notice)] = now;

  const headStart: Record<string, number> = {};
  for (const [key, until] of Object.entries(dismissals.headStart)) {
    if (until > now) headStart[key] = until;
  }
  const key = headStartKey(speakerIp, notice);
  if (key !== null) headStart[key] = now + HEAD_START_NOTICE_MEMORY_MS;

  return { byNotice, headStart };
}
