/**
 * Speaker Notice Wording and Dismissal
 *
 * The companion decides every speaker notice and sends the figures its
 * wording needs; this module only picks the words and remembers what the user
 * dismissed. Pure functions, so the popup hook stays thin and the rules are
 * testable without Chrome.
 *
 * Wording: a head-start notice names what happened and the head start that
 * would have covered it, then where to change it: in the environment variable
 * when one fixes it, else in the desktop app or the server's config by the
 * companion's type, else neutrally. An uncorrected drift offers clock drift
 * correction where the companion has it and it is not on. Restart advice is
 * added only when the companion says a restart refills the speaker.
 *
 * Dismissal: a notice is dismissed by `(streamId, speakerIp, noticeId)`, which
 * holds while the companion repeats it and lapses on a new episode or an
 * escalation. A dismissed head-start notice is also remembered for 24 hours
 * by `(speakerIp, kind, suggestedHeadStartMs)`, so the same advice does not
 * return on the next cast; advice to go higher still does.
 */

import type { AppType, CompanionAudio, SpeakerNotice } from '@thaumic-cast/protocol';

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
  /** The companion's speaker-side settings; null when it does not report them. */
  companionAudio: CompanionAudio | null;
  /** Which companion is connected; null when unknown. */
  appType: AppType | null;
}

/**
 * Whether a notice kind is about the speaker head start.
 * @param kind - The notice kind
 * @returns True for the three head-start kinds
 */
export function isHeadStartNotice(kind: SpeakerNotice['kind']): boolean {
  return (
    kind === 'head_start_ran_out' || kind === 'head_start_close' || kind === 'head_start_no_remedy'
  );
}

/**
 * Picks the sentence saying where the speaker head start is changed: the
 * environment variable when one fixes it, else the desktop app or the server's
 * config by companion type. Without the companion's settings the neutral
 * wording is used, since whether an environment variable fixes the head start
 * is then unknown.
 * @param suggested - The head start the notice suggests, in ms
 * @param ctx - The wording context
 * @returns The sentence to append
 */
export function headStartWhereLine(suggested: number, ctx: NoticeWordingContext): NoticeLine {
  if (!ctx.companionAudio) return { key: 'speaker_notice_where_unknown' };
  if (ctx.companionAudio.headStartFixed) return { key: 'speaker_notice_where_fixed' };
  if (ctx.appType === 'desktop') return { key: 'speaker_notice_where_desktop' };
  if (ctx.appType === 'server')
    return { key: 'speaker_notice_where_server', params: { suggested } };
  return { key: 'speaker_notice_where_unknown' };
}

/**
 * Picks the sentence offering clock drift correction for an uncorrected
 * drift: only when the companion reports its mode, the mode is not already
 * `on`, the speaker monitor (which correction steers by) is on, and the
 * companion's type says where correction is turned on.
 * @param ctx - The wording context
 * @returns The sentence to append, or null when there is nothing to offer
 */
export function driftTurnOnLine(ctx: NoticeWordingContext): NoticeLine | null {
  const audio = ctx.companionAudio;
  if (!audio?.speakerMonitor || audio.driftCompensation === undefined) return null;
  if (audio.driftCompensation === 'on') return null;
  if (ctx.appType === 'desktop') return { key: 'speaker_notice_drift_turn_on_desktop' };
  if (ctx.appType === 'server') return { key: 'speaker_notice_drift_turn_on_server' };
  return null;
}

/**
 * Words a speaker notice as the sentences the popup joins into one message.
 * @param notice - The companion's notice
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
        lines.push({ key: 'speaker_notice_head_start_no_remedy', params: { stall, name } });
        break;
      }
      lines.push({
        key: `speaker_notice_${notice.kind}${off}`,
        params: { stall, name, current, left, suggested },
      });
      lines.push(headStartWhereLine(suggested, ctx));
      break;
    case 'head_start_no_remedy':
      lines.push({ key: 'speaker_notice_head_start_no_remedy', params: { stall, name } });
      break;
    case 'running_low':
      lines.push({ key: 'speaker_notice_running_low', params: { name, left } });
      break;
    case 'drift_uncorrected':
    case 'drift_saturated': {
      lines.push({
        key: `speaker_notice_${notice.kind}`,
        params: { name, minutes: Math.max(1, notice.minutes ?? 1) },
      });
      const turnOn = notice.kind === 'drift_uncorrected' ? driftTurnOnLine(ctx) : null;
      if (turnOn) lines.push(turnOn);
      break;
    }
  }

  if (notice.restartHelps) lines.push({ key: 'speaker_notice_restart_refills' });
  return lines;
}

/** Dismissed notices, as kept in extension storage. */
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
 * Checks that every value of a stored map is a number.
 * @param value - The value read from storage
 * @returns True for an object of numbers
 */
function isNumberMap(value: unknown): value is Record<string, number> {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === 'number')
  );
}

/**
 * Reads dismissals from storage, tolerating anything malformed.
 * @param value - The value read from storage
 * @returns The dismissals, or none if the value is not recognised
 */
export function parseDismissals(value: unknown): SpeakerNoticeDismissals {
  if (typeof value !== 'object' || value === null) return emptyDismissals();
  const { byNotice, headStart } = value as Record<string, unknown>;
  return {
    byNotice: isNumberMap(byNotice) ? byNotice : {},
    headStart: isNumberMap(headStart) ? headStart : {},
  };
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
  if (!isHeadStartNotice(notice.kind)) return null;
  return `${speakerIp}|${notice.kind}|${notice.suggestedHeadStartMs ?? '-'}`;
}

/**
 * Whether the user has dismissed a notice: this episode of it, or, for a
 * head-start notice, the same advice for the same speaker within 24 hours.
 * @param dismissals - The stored dismissals
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
 * Records a dismissal, dropping entries older than the 24-hour memory so the
 * stored map does not grow without bound. Notice ids are per stream, and a
 * stream id is never reused, so an old episode key can never match again.
 * @param dismissals - The stored dismissals
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

/** How long an ingest-gaps notice stands after it arrives. */
export const INGEST_GAPS_NOTICE_MS = 10 * 60 * 1000;

/** The ingest-gaps figures the wording needs. */
export interface IngestGapsFigures {
  /** Gaps counted in the last minute. */
  gapsLastMinute: number;
  /** The longest gap, in ms. */
  worstGapMs: number;
  /** The smoothing step that would have covered it; absent when none would. */
  suggestedSmoothingMs?: number;
}

/**
 * Words an ingest-gaps notice for the connected companion.
 * @param gaps - The companion's figures
 * @param appType - Which companion is connected; null when unknown
 * @returns The sentence to show
 */
export function ingestGapsLine(gaps: IngestGapsFigures, appType: AppType | null): NoticeLine {
  // The copy names the companion; with its type unknown, the desktop app is
  // the likelier one and the advice is the same.
  const where = appType === 'server' ? 'server' : 'desktop';
  if (gaps.suggestedSmoothingMs === undefined) {
    return { key: `ingest_gaps_no_remedy_${where}`, params: { worst: gaps.worstGapMs } };
  }
  return {
    key: `ingest_gaps_message_${where}`,
    params: { count: gaps.gapsLastMinute, suggested: gaps.suggestedSmoothingMs },
  };
}
