/**
 * Toolbar Badge
 *
 * The "!" on the extension's toolbar button (DESIGN.md C-badge-tb,
 * notices-spec §7): it says something needs a look while the popup is shut.
 * Never a count. Its colour is the highest severity among what sets it, and
 * its title, which is also the button's accessible name, is
 * "Thaumic Cast: {{lead}}" for that item.
 *
 * Sets it:
 * - the connection lost while casts were running, until it is back;
 * - no speaker can be reached (danger) or no reply from the speakers
 *   (warning), while a cast runs;
 * - a speaker that cut out, may cut out soon, or may cut out within ten
 *   minutes, on a running cast, until dismissed;
 * - gaps in the sound or pieces missing from the audio, on a running cast,
 *   until dismissed;
 * - an unseen fault event from the away log (a cast that ended by itself
 *   for a fault, the connection lost and back, a room still playing or not
 *   joined after the popup shut).
 *
 * Never: neutral events, "nearly cut out", drift more than ten minutes away,
 * set-up errors or "not found" with no cast, reconnecting, an update, an old
 * companion.
 *
 * Responsibilities:
 * - Gather the items from the background's own state (pure `badgeItems`)
 * - Pick the badge (pure `badgeFor`)
 * - Write `chrome.action` only when the result changes
 * - Keep the browser theme the popup and the offscreen document report
 */

import { createLogger } from '@thaumic-cast/shared';
import i18next, { type TFunction } from 'i18next';
import { CHROME } from '@thaumic-cast/ui/tokens';
import type { CaptureHealthState } from './capture-health-state';
import type { IngestGapsEntry, SpeakerHealthEntry } from '../lib/message-schemas';
import {
  CAPTURE_HEALTH_DISMISSED_KEY,
  INGEST_GAPS_DISMISSED_KEY,
  INGEST_GAPS_NOTICE_MS,
  NO_REPLY_DISMISSED_KEY,
  SPEAKER_NOTICES_DISMISSED_KEY,
  isNoticeDismissed,
  parseDismissals,
  type SpeakerNoticeDismissals,
} from '../lib/speaker-notices';
import { unseenAwayEvents, type AwayEvent } from '../lib/away-events';
import { DEFAULT_LOCALE, getInitialLanguage, resources } from '../lib/locales';
import { loadExtensionSettings } from '../lib/settings';
import type { ToolbarTheme } from './toolbar-icon';

const log = createLogger('ToolbarBadge');

/** Where the browser theme is kept for the badge (`chrome.storage.session`). */
export const TOOLBAR_DARK_KEY = 'toolbarDark';

/** Drift this many minutes away or nearer sets the badge. */
const DRIFT_BADGE_MINUTES = 10;

/** A string key and its values, translated when the badge is written. */
export interface BadgeLead {
  /** The lead's string key. */
  key: string;
  /** Its values. */
  params?: Record<string, string | number>;
}

/** One thing that sets the badge. */
export interface BadgeItem {
  /** Warning or danger. */
  sev: 'warning' | 'danger';
  /** The lead the title names. */
  lead: BadgeLead;
  /** When it began (epoch ms), so the newest of a severity wins the title. */
  at: number;
}

/** Everything the items are gathered from. */
export interface BadgeSources {
  /** The stream ids of this client's running casts, with their tabs. */
  casts: { streamId: string; tabId: number }[];
  /** The companion's view of the speakers' network. */
  networkHealth: 'ok' | 'degraded';
  /** Why it is degraded. */
  networkHealthReason: string | null;
  /** The latest reading per speaker IP. */
  speakerHealth: Record<string, SpeakerHealthEntry>;
  /** A speaker's room name. */
  speakerName: (speakerIp: string) => string;
  /** Dismissed speaker notices. */
  speakerDismissals: SpeakerNoticeDismissals;
  /** The latest ingest-gaps report per stream id. */
  ingestGaps: Record<string, IngestGapsEntry>;
  /** Dismissed ingest-gaps notices: stream id → the report's `receivedAt`. */
  ingestDismissed: Record<string, number>;
  /** Capture health. */
  captureHealth: CaptureHealthState;
  /** The `detectedAt` of the dismissed capture-health notice. */
  captureDismissedAt: number | null;
  /** "No reply from the speakers" was dismissed in the popup. */
  noReplyDismissed: boolean;
  /** Every stored away event. */
  away: readonly AwayEvent[];
  /** The time now. */
  now: number;
}

/** The badge to draw. */
export interface BadgeState {
  /** Always "!". */
  text: string;
  /** The background colour. */
  bg: string;
  /** The text colour. */
  fg: string;
  /** The lead the title names. */
  lead: BadgeLead;
}

/**
 * The lead a speaker notice sets the badge with, or null for one that does not.
 * @param entry - The speaker's reading, with its notice
 * @param name - The speaker's room name
 * @returns The lead, or null
 */
function speakerLead(entry: SpeakerHealthEntry, name: string): BadgeLead | null {
  const notice = entry.notice;
  if (!notice) return null;
  switch (notice.kind) {
    case 'head_start_ran_out':
    case 'head_start_no_remedy':
      return { key: 'speaker_lead_cut_out', params: { name } };
    case 'running_low':
      return { key: 'speaker_lead_may_cut_out_soon', params: { name } };
    case 'drift_uncorrected':
    case 'drift_saturated':
      return notice.minutes !== undefined && notice.minutes <= DRIFT_BADGE_MINUTES
        ? { key: 'speaker_lead_may_cut_out_in', params: { name, minutes: notice.minutes } }
        : null;
    case 'head_start_close':
      return null;
  }
}

/** The lead each away event kind is named by. */
const AWAY_LEADS: Record<AwayEvent['kind'], string> = {
  cast_ended: 'cast_ended',
  speaker_left: 'room_left_cast',
  connection_lost: 'notice_lead_connection_lost',
  stop_failed: 'room_still_playing',
  join_failed: 'room_join_failed',
};

/**
 * Gathers what sets the badge now.
 * @param sources - The background's state
 * @returns The items, in no order
 */
export function badgeItems(sources: BadgeSources): BadgeItem[] {
  const items: BadgeItem[] = [];
  const { casts, now } = sources;
  const streamIds = new Set(casts.map((cast) => cast.streamId));

  // The connection lost while casts ran: a condition until it is back.
  for (const event of sources.away) {
    if (event.kind === 'connection_lost' && !event.recoveredAt) {
      items.push({ sev: 'danger', lead: { key: AWAY_LEADS.connection_lost }, at: event.at });
    }
  }

  if (casts.length > 0 && sources.networkHealth === 'degraded') {
    if (sources.networkHealthReason === 'speakers_unreachable') {
      items.push({ sev: 'danger', lead: { key: 'notice_lead_unreachable' }, at: now });
    } else if (
      sources.networkHealthReason === 'speakers_not_responding' &&
      !sources.noReplyDismissed
    ) {
      items.push({ sev: 'warning', lead: { key: 'notice_lead_no_reply' }, at: now });
    }
  }

  for (const [speakerIp, entry] of Object.entries(sources.speakerHealth)) {
    if (!streamIds.has(entry.streamId) || !entry.notice) continue;
    if (
      isNoticeDismissed(sources.speakerDismissals, entry.streamId, speakerIp, entry.notice, now)
    ) {
      continue;
    }
    const lead = speakerLead(entry, sources.speakerName(speakerIp));
    if (lead) items.push({ sev: 'warning', lead, at: entry.updatedAt });
  }

  for (const streamId of streamIds) {
    const report = sources.ingestGaps[streamId];
    if (!report || now - report.receivedAt >= INGEST_GAPS_NOTICE_MS) continue;
    if (sources.ingestDismissed[streamId] === report.receivedAt) continue;
    items.push({ sev: 'warning', lead: { key: 'cast_lead_gaps' }, at: report.receivedAt });
  }

  const capture = sources.captureHealth;
  if (
    capture.degraded &&
    capture.detectedAt !== null &&
    casts.some((cast) => cast.tabId === capture.tabId) &&
    capture.detectedAt !== sources.captureDismissedAt
  ) {
    items.push({
      sev: 'warning',
      lead: { key: 'cast_lead_pieces_missing' },
      at: capture.detectedAt,
    });
  }

  for (const event of unseenAwayEvents(sources.away)) {
    if (event.sev === 'neutral') continue;
    items.push({
      sev: event.sev,
      lead: { key: AWAY_LEADS[event.kind], params: { name: event.subject } },
      at: event.at,
    });
  }

  return items;
}

/**
 * Picks the badge: the highest severity sets the colour, and the newest item
 * of that severity names the title.
 * @param items - What sets the badge
 * @param dark - Whether the browser's toolbar is dark; the light pair when unknown
 * @returns The badge, or null to clear it
 */
export function badgeFor(items: readonly BadgeItem[], dark: boolean): BadgeState | null {
  if (items.length === 0) return null;
  const sev = items.some((item) => item.sev === 'danger') ? 'danger' : 'warning';
  const lead = items
    .filter((item) => item.sev === sev)
    .reduce((newest, item) => (item.at > newest.at ? item : newest)).lead;
  const colours = CHROME.toolbarBadge[sev][dark ? 'dark' : 'light'];
  return { text: CHROME.toolbarBadge.text, bg: colours.bg, fg: colours.fg, lead };
}

// ─────────────────────────────────────────────────────────────────────────────
// Writing the badge
// ─────────────────────────────────────────────────────────────────────────────

const translator = i18next.createInstance();
let translatorReady: Promise<TFunction> | null = null;

/**
 * The translator for the title, in the language the popup uses.
 * @returns The `t` function
 */
async function translate(): Promise<TFunction> {
  translatorReady ??= loadExtensionSettings()
    .then((settings) => getInitialLanguage(settings.language))
    .catch(() => DEFAULT_LOCALE)
    .then((lng) =>
      translator.init({
        resources,
        lng,
        fallbackLng: DEFAULT_LOCALE,
        interpolation: { escapeValue: false },
      }),
    );
  return translatorReady;
}

/** What was last written, so nothing is written twice. */
let written: string | null = null;

/**
 * Writes the badge to the toolbar, only when it differs from what is there.
 * @param badge - The badge, or null to clear it
 * @returns Resolves when written
 */
export async function writeBadge(badge: BadgeState | null): Promise<void> {
  const t = await translate();
  const title = badge
    ? t('toolbar_title', { lead: t(badge.lead.key, badge.lead.params ?? {}) })
    : chrome.i18n.getMessage('extensionName');
  const next = JSON.stringify({ badge, title });
  if (next === written) return;
  written = next;
  try {
    await chrome.action.setBadgeText({ text: badge?.text ?? '' });
    if (badge) {
      await chrome.action.setBadgeBackgroundColor({ color: badge.bg });
      await chrome.action.setBadgeTextColor({ color: badge.fg });
    }
    await chrome.action.setTitle({ title });
  } catch (err) {
    written = null;
    log.warn('Failed to write the toolbar badge:', err);
  }
}

/**
 * The browser's theme, as last reported; null when none has been.
 * @returns The theme, or null
 */
export async function readToolbarTheme(): Promise<ToolbarTheme> {
  try {
    const stored = await chrome.storage.session.get(TOOLBAR_DARK_KEY);
    const dark = stored[TOOLBAR_DARK_KEY];
    return typeof dark === 'boolean' ? (dark ? 'dark' : 'light') : null;
  } catch {
    return null;
  }
}

/**
 * Whether the toolbar is dark, as last reported; light when unknown.
 * @returns True for a dark toolbar
 */
export async function isToolbarDark(): Promise<boolean> {
  return (await readToolbarTheme()) === 'dark';
}

/**
 * Keeps the browser theme reported by the popup or the offscreen document.
 * The service worker has no `matchMedia`, so it cannot read it itself.
 * @param dark - Whether the toolbar is dark
 * @returns Resolves when stored
 */
export async function setToolbarDark(dark: boolean): Promise<void> {
  try {
    await chrome.storage.session.set({ [TOOLBAR_DARK_KEY]: dark });
  } catch (err) {
    log.warn('Failed to keep the toolbar theme:', err);
  }
}

/**
 * Reads the dismissals the popup keeps.
 * @returns The four kinds of dismissal
 */
export async function readDismissals(): Promise<
  Pick<
    BadgeSources,
    'speakerDismissals' | 'ingestDismissed' | 'captureDismissedAt' | 'noReplyDismissed'
  >
> {
  try {
    const stored = await chrome.storage.local.get([
      SPEAKER_NOTICES_DISMISSED_KEY,
      INGEST_GAPS_DISMISSED_KEY,
      CAPTURE_HEALTH_DISMISSED_KEY,
      NO_REPLY_DISMISSED_KEY,
    ]);
    const ingest = stored[INGEST_GAPS_DISMISSED_KEY];
    const capture = stored[CAPTURE_HEALTH_DISMISSED_KEY];
    return {
      speakerDismissals: parseDismissals(stored[SPEAKER_NOTICES_DISMISSED_KEY]),
      ingestDismissed:
        typeof ingest === 'object' && ingest !== null ? (ingest as Record<string, number>) : {},
      captureDismissedAt: typeof capture === 'number' ? capture : null,
      noReplyDismissed: stored[NO_REPLY_DISMISSED_KEY] === true,
    };
  } catch {
    return {
      speakerDismissals: parseDismissals(null),
      ingestDismissed: {},
      captureDismissedAt: null,
      noReplyDismissed: false,
    };
  }
}

/**
 * Forgets what was written. For tests.
 */
export function resetToolbarBadgeForTests(): void {
  written = null;
}
