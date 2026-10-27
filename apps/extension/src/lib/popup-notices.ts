/**
 * Popup Notices
 *
 * Places every standing condition the popup knows about at its source
 * (DESIGN.md P-notices, notices-spec §3–§5 as amended by annex 2): the one
 * banner, the section notice under "Casting now", each cast's slot, and the
 * room Badges. It applies the suppression rules ("a bigger problem hides what
 * it explains"), the slot order and the quiet tier's removal.
 *
 * Pure: it takes plain inputs and returns string keys and values, so the rules
 * are tested without Chrome or a render. Events the popup sees while open (a
 * failed Cast, a room still playing, a room that did not join, a room that
 * left, an auto-stop) are not conditions: the popup holds them where they
 * happened (the CastBar line, the row line, the tile note, the Toast), and a
 * lost connection takes their tiles away with it.
 */

import type { SpeakerNotice } from '@thaumic-cast/protocol';
import type { NoticeLine as Sentence } from './speaker-notices';

/** A string key and its values, translated by the popup. */
export interface Words {
  /** The string key. */
  key: string;
  /** Its values. */
  params?: Record<string, string | number>;
}

/** What the popup knows about the companion. */
export interface NoticeConnection {
  /** checking, reconnecting, connected or error. */
  phase: 'checking' | 'reconnecting' | 'connected' | 'error';
  /** The error key, while the phase is error. */
  error: string | null;
  /** Whether trying again is offered. */
  canRetry: boolean;
  /** The companion's view of the speakers' network. */
  networkHealth: 'ok' | 'degraded';
  /** Why it is degraded. */
  networkHealthReason: string | null;
}

/** One speaker notice from the companion, on a running cast. */
export interface NoticeSpeaker {
  /** The speaker's IP. */
  speakerIp: string;
  /** The room's name. */
  name: string;
  /** The notice. */
  notice: SpeakerNotice;
  /** Its whole shipped message, sentence by sentence. */
  lines: Sentence[];
  /** Dismissed: its words are hidden; its Badge stays while it stands. */
  dismissed: boolean;
}

/** One ingest-gaps report on a running cast. */
export interface NoticeGaps {
  /** The cast's stream. */
  streamId: string;
  /** Whether more smoothing would help. */
  hasRemedy: boolean;
  /** The shipped sentence. */
  line: Sentence;
}

/** Everything the notices are placed from. */
export interface NoticeInputs {
  /** The connection. */
  connection: NoticeConnection;
  /** The running casts. */
  casts: readonly { tabId: number; streamId: string; speakerIps: readonly string[] }[];
  /** The speaker notices, dismissed or not. */
  speakers: readonly NoticeSpeaker[];
  /**
   * The casting speakers the household no longer lists: dropped off the network (unplugged,
   * out of reach). Empty while the household is not known.
   */
  missing: readonly { speakerIp: string; name: string }[];
  /** The undismissed ingest-gaps reports. */
  gaps: readonly NoticeGaps[];
  /** The casts moved to the speakers' local connection, undismissed. */
  moved: readonly { streamId: string }[];
  /** The undismissed capture-health notice, on the tab whose cast drops frames. */
  capture: { tabId: number; key: string; hasAction: boolean } | null;
  /** The old companion warning, when it is shown (not dismissed for this build). */
  oldCompanion: { appVersion: string | null; actionKey: string } | null;
  /** "No reply from the speakers" was dismissed this popup session. */
  noReplyDismissed: boolean;
}

/** The one banner (S2). */
export interface BannerPlan {
  /** Its identity: it is said once. */
  id: 'connection_lost' | 'connection_error' | 'unreachable' | 'upnp_disabled' | 'old_companion';
  /** danger blocks and has no X; the old companion's warning has one. */
  tone: 'danger' | 'warning';
  /** The lead. */
  lead: Words;
  /** The shipped sentence. */
  text: Words;
  /** Its action: try the connection again, or open the download page. */
  action?: { kind: 'retry' | 'update'; label: Words };
  /** Nothing answered: a link to the download page, for whoever has no companion yet. */
  link?: { kind: 'download'; label: Words };
  /** Only the old companion's warning can be dismissed (P-x). */
  dismissible: boolean;
  /** A second current condition, folded in as its lead (rule 8). */
  also?: Words;
}

/** The section notice under "Casting now" (S3): no reply from the speakers. */
export interface SectionPlan {
  /** Its identity. */
  id: 'no_reply';
  /** The lead. */
  lead: Words;
  /** The shipped sentence. */
  text: Words;
}

/** Where a slot item's action goes. */
export type SlotAction = 'open_settings' | 'open_audio_settings';

/** One item in a cast's slot (S4). */
export interface SlotPlan {
  /** Its identity: said once, and a dismissed one never again. */
  id: string;
  /** What it is about, so the popup can dismiss it. */
  source:
    | { kind: 'speaker'; speakerIp: string }
    | { kind: 'missing'; speakerIp: string }
    | { kind: 'capture' }
    | { kind: 'gaps'; streamId: string }
    | { kind: 'moved'; streamId: string };
  /** Every slot item is a warning. */
  tone: 'warning';
  /** The lead. */
  lead: Words;
  /** The remedy, when there is a short one. */
  text?: Words;
  /** The whole shipped message, opening in place under Details. */
  details?: Words[];
  /** One action. */
  action?: { kind: SlotAction; label: Words };
}

/** A room's condition, as its Badge says it. */
export interface RoomCondition {
  /** May cut out, or cut out. */
  label: Words;
}

/** Where everything goes. */
export interface PopupNotices {
  /** The banner, or none. */
  banner: BannerPlan | null;
  /** The section notice, or none. */
  section: SectionPlan | null;
  /** "No reply" on the "Casting now" heading, while a cast runs. */
  headingBadge: Words | null;
  /** Each cast's slot, in slot order, by tab. */
  slots: Record<number, SlotPlan[]>;
  /** Each casting speaker's condition, by IP. */
  conditions: Record<string, RoomCondition>;
  /** Not connected: the picker waits, and nothing casts. */
  disconnected: boolean;
}

/** The lead each connection error is named by (notices-spec §2.1). */
export const CONNECTION_LEADS: Readonly<Record<string, string>> = {
  error_connection_lost: 'notice_lead_connection_lost',
  error_desktop_not_found: 'notice_lead_not_found',
  error_server_error: 'notice_lead_server_error',
  error_wrong_server: 'notice_lead_wrong_server',
  error_network_failed: 'notice_lead_network_failed',
  error_permission_needed: 'notice_lead_permission_needed',
  error_permission_denied: 'notice_lead_permission_denied',
};

/** Drift this many minutes away or nearer is shown; further away it is not (quiet tier). */
export const DRIFT_SHOWN_MINUTES = 10;

/** A speaker notice's place in the slot and its words, or null for the quiet tier. */
interface SpeakerPlace {
  /** Its place: may cut out soon, cut out, (capture), (gaps), drift. */
  rank: number;
  /** The lead's key. */
  lead: string;
  /** The Badge's key. */
  badge: string;
  /** The remedy line, if a short one names the fix. */
  remedy?: Words;
}

/**
 * Where a speaker notice goes, by its kind (annex 2, P-notices §2.3).
 * @param notice - The companion's notice
 * @returns Its place and words, or null when the popup shows it nowhere
 */
export function speakerPlace(notice: SpeakerNotice): SpeakerPlace | null {
  switch (notice.kind) {
    case 'running_low':
      return {
        rank: 1,
        lead: 'speaker_lead_may_cut_out_soon',
        badge: 'badge_may_cut_out',
        remedy: notice.restartHelps ? { key: 'speaker_notice_restart_refills' } : undefined,
      };
    case 'head_start_ran_out':
      return {
        rank: 2,
        lead: 'speaker_lead_cut_out',
        badge: 'badge_cut_out',
        remedy:
          notice.suggestedHeadStartMs !== undefined
            ? {
                key: 'speaker_remedy_head_start',
                params: { suggested: notice.suggestedHeadStartMs },
              }
            : undefined,
      };
    case 'head_start_no_remedy':
      return { rank: 2, lead: 'speaker_lead_cut_out', badge: 'badge_cut_out' };
    case 'drift_uncorrected':
    case 'drift_saturated':
      return notice.minutes !== undefined && notice.minutes <= DRIFT_SHOWN_MINUTES
        ? { rank: 5, lead: 'speaker_lead_may_cut_out_in', badge: 'badge_may_cut_out' }
        : null;
    case 'head_start_close':
      return null;
  }
}

/**
 * The banner candidates that stand now, highest first (rule 8).
 * @param inputs - The inputs
 * @returns The candidates
 */
function bannerCandidates(inputs: NoticeInputs): BannerPlan[] {
  const { connection, oldCompanion } = inputs;
  const out: BannerPlan[] = [];
  if (connection.phase === 'error') {
    const error = connection.error ?? 'error_desktop_not_found';
    const lost = error === 'error_connection_lost';
    out.push({
      id: lost ? 'connection_lost' : 'connection_error',
      tone: 'danger',
      lead: { key: CONNECTION_LEADS[error] ?? 'connection_status_disconnected' },
      text: { key: error },
      action: connection.canRetry
        ? {
            kind: 'retry',
            label: { key: lost ? 'retry_connection' : 'try_again' },
          }
        : undefined,
      link:
        error === 'error_desktop_not_found'
          ? { kind: 'download', label: { key: 'download_companion' } }
          : undefined,
      dismissible: false,
    });
  }
  const knowsSpeakers = connection.phase === 'connected' || connection.phase === 'error';
  if (
    knowsSpeakers &&
    connection.networkHealth === 'degraded' &&
    connection.networkHealthReason === 'speakers_unreachable'
  ) {
    out.push({
      id: 'unreachable',
      tone: 'danger',
      lead: { key: 'notice_lead_unreachable' },
      text: { key: 'network.speakers_unreachable' },
      dismissible: false,
    });
  }
  if (
    knowsSpeakers &&
    connection.networkHealth === 'degraded' &&
    connection.networkHealthReason === 'speakers_upnp_disabled'
  ) {
    out.push({
      id: 'upnp_disabled',
      tone: 'danger',
      lead: { key: 'notice_lead_upnp_disabled' },
      text: { key: 'network.speakers_upnp_disabled' },
      dismissible: false,
    });
  }
  if (oldCompanion && connection.phase === 'connected') {
    out.push({
      id: 'old_companion',
      tone: 'warning',
      lead: { key: 'version_old_lead' },
      text: oldCompanion.appVersion
        ? { key: 'version_old_body', params: { appVersion: oldCompanion.appVersion } }
        : { key: 'version_old_body_unknown' },
      action: { kind: 'update', label: { key: oldCompanion.actionKey } },
      dismissible: true,
    });
  }
  return out;
}

/**
 * Places every standing condition at its source.
 * @param inputs - What the popup knows
 * @returns Where each notice goes
 */
export function placeNotices(inputs: NoticeInputs): PopupNotices {
  const { connection, casts } = inputs;
  const candidates = bannerCandidates(inputs);
  const [first, second] = candidates;
  const banner = first ? { ...first, ...(second ? { also: second.lead } : {}) } : null;
  const disconnected = connection.phase === 'error';
  // UPnP switched off refuses every speaker, so it hides the same as nothing reached.
  const unreachable = candidates.some((c) => c.id === 'unreachable' || c.id === 'upnp_disabled');
  const noReply =
    !disconnected &&
    !unreachable &&
    connection.phase === 'connected' &&
    connection.networkHealth === 'degraded' &&
    connection.networkHealthReason === 'speakers_not_responding';

  const slots: Record<number, SlotPlan[]> = {};
  const conditions: Record<string, RoomCondition> = {};
  // Rule 1: not connected, the casts have stopped; rule 3: nothing can be reached, so one
  // problem is not shown again on every speaker and every cast.
  const perCast = !disconnected && !unreachable;

  for (const cast of casts) {
    const ranked: { rank: number; order: number; item: SlotPlan }[] = [];
    if (perCast) {
      // A speaker gone from the household plays nothing: the biggest problem a room can
      // have, so it leads the slot and hides that speaker's other notices. It stands until
      // the speaker is back or removed, so it has no X.
      const gone = new Set<string>();
      for (const missing of inputs.missing) {
        const order = cast.speakerIps.indexOf(missing.speakerIp);
        if (order === -1) continue;
        gone.add(missing.speakerIp);
        conditions[missing.speakerIp] = { label: { key: 'badge_not_answering' } };
        ranked.push({
          rank: 0,
          order,
          item: {
            id: `missing:${missing.speakerIp}`,
            source: { kind: 'missing', speakerIp: missing.speakerIp },
            tone: 'warning',
            lead: { key: 'speaker_lead_not_answering', params: { name: missing.name } },
            text: { key: 'speaker_not_answering_text' },
          },
        });
      }
      for (const view of inputs.speakers) {
        if (gone.has(view.speakerIp)) continue;
        const order = cast.speakerIps.indexOf(view.speakerIp);
        if (order === -1) continue;
        const place = speakerPlace(view.notice);
        if (!place) continue;
        conditions[view.speakerIp] = { label: { key: place.badge } };
        if (view.dismissed) continue;
        const params: Record<string, string | number> = { name: view.name };
        if (place.rank === 5) params.minutes = view.notice.minutes ?? 0;
        ranked.push({
          rank: place.rank,
          order,
          item: {
            id: `speaker:${view.speakerIp}:${view.notice.noticeId}`,
            source: { kind: 'speaker', speakerIp: view.speakerIp },
            tone: 'warning',
            lead: { key: place.lead, params },
            text: place.remedy,
            details: view.lines.map((line) => ({ key: line.key, params: line.params })),
          },
        });
      }
      const capture = inputs.capture?.tabId === cast.tabId ? inputs.capture : null;
      if (capture) {
        ranked.push({
          rank: 3,
          order: 0,
          item: {
            id: `capture:${cast.tabId}`,
            source: { kind: 'capture' },
            tone: 'warning',
            lead: { key: 'cast_lead_pieces_missing' },
            text: { key: capture.key },
            action: capture.hasAction
              ? { kind: 'open_settings', label: { key: 'capture_health_action_open_settings' } }
              : undefined,
          },
        });
      }
      // Rule 5: capture health already explains the gaps.
      const gaps = capture ? undefined : inputs.gaps.find((g) => g.streamId === cast.streamId);
      if (gaps) {
        ranked.push({
          rank: 4,
          order: 0,
          item: {
            id: `gaps:${cast.streamId}`,
            source: { kind: 'gaps', streamId: cast.streamId },
            tone: 'warning',
            lead: { key: 'cast_lead_gaps' },
            text: { key: gaps.line.key, params: gaps.line.params },
            action: gaps.hasRemedy
              ? {
                  kind: 'open_audio_settings',
                  label: { key: 'ingest_gaps_action_open_settings' },
                }
              : undefined,
          },
        });
      }
      // The cast moved to the speakers' own connection, with a short skip.
      if (inputs.moved.some((m) => m.streamId === cast.streamId)) {
        ranked.push({
          rank: 5,
          order: 0,
          item: {
            id: `moved:${cast.streamId}`,
            source: { kind: 'moved', streamId: cast.streamId },
            tone: 'warning',
            lead: { key: 'cast_lead_moved' },
            text: { key: 'cast_moved_text' },
          },
        });
      }
    }
    ranked.sort((a, b) => a.rank - b.rank || a.order - b.order);
    slots[cast.tabId] = ranked.map((r) => r.item);
  }

  return {
    banner,
    section:
      noReply && !inputs.noReplyDismissed
        ? {
            id: 'no_reply',
            lead: { key: 'notice_lead_no_reply' },
            text: { key: 'network.speakers_not_responding' },
          }
        : null,
    headingBadge: noReply && casts.length > 0 ? { key: 'badge_no_reply' } : null,
    slots,
    conditions,
    disconnected,
  };
}

/** The CastBar line's lead for each error a Cast can end in (notices-spec §2.5). */
export const CASTBAR_LEADS: Readonly<Record<string, string>> = {
  error_cast_failed: 'castbar_lead_cast_failed',
  error_playback_failed: 'castbar_lead_playback_failed',
  error_capture_denied: 'castbar_lead_capture_denied',
  error_capture_denied_reason: 'castbar_lead_capture_denied',
  error_max_sessions: 'castbar_lead_max_sessions',
  error_no_active_tab: 'castbar_lead_no_active_tab',
  error_stop_tab_capture_first: 'castbar_lead_stop_tab_capture_first',
  error_stop_browser_capture_first: 'castbar_lead_stop_browser_capture_first',
  error_offscreen_unavailable: 'castbar_lead_offscreen_unavailable',
  error_codec_detection_failed: 'castbar_lead_codec_detection_failed',
  error_unsupported_sample_rate: 'castbar_lead_rate',
  error_pcm_rate_unsupported: 'castbar_lead_rate',
  error_upnp_disabled: 'notice_lead_upnp_disabled',
  error_flac_needs_upnp: 'castbar_lead_flac_needs_upnp',
};

/**
 * The CastBar line for a Cast that did not start: a short lead, and the shipped sentence.
 * An error the popup has no lead for is "The cast did not start", with its own words.
 * @param error - The error key (or text) the background answered with
 * @param params - Its values
 * @returns The lead and the text
 */
export function castBarFailure(
  error: string | undefined,
  params: Record<string, string | number> = {},
): { lead: Words; text: Words } {
  const key = error ?? 'error_cast_failed';
  return {
    lead: { key: CASTBAR_LEADS[key] ?? 'castbar_lead_cast_failed', params },
    text: { key, params },
  };
}
