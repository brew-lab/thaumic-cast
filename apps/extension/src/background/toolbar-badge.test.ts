import { beforeEach, describe, expect, it } from 'bun:test';
import { CHROME } from '@thaumic-cast/ui/tokens';

import type { AwayEvent } from '../lib/away-events';
import type { SpeakerHealthEntry } from '../lib/message-schemas';
import { emptyDismissals, INGEST_GAPS_NOTICE_MS } from '../lib/speaker-notices';
import { actionCalls, chromeStorageData, resetChromeStub } from '../test-support/chrome-stub';
import {
  TOOLBAR_DARK_KEY,
  badgeFor,
  badgeItems,
  isToolbarDark,
  readDismissals,
  resetToolbarBadgeForTests,
  setToolbarDark,
  writeBadge,
  type BadgeItem,
  type BadgeSources,
} from './toolbar-badge';

const NOW = 1_000_000;
const KITCHEN = '192.168.1.10';

/**
 * Sources with one running cast and nothing wrong.
 * @param partial - The fields to change
 * @returns The sources
 */
function sources(partial: Partial<BadgeSources> = {}): BadgeSources {
  return {
    casts: [{ streamId: 's1', tabId: 4 }],
    networkHealth: 'ok',
    networkHealthReason: null,
    speakerHealth: {},
    speakerName: () => 'Kitchen',
    speakerDismissals: emptyDismissals(),
    ingestGaps: {},
    ingestDismissed: {},
    captureHealth: { degraded: false, tabId: null, detectedAt: null },
    captureDismissedAt: null,
    noReplyDismissed: false,
    away: [],
    now: NOW,
    ...partial,
  };
}

/**
 * A speaker reading with a notice.
 * @param notice - The notice's kind and figures
 * @param streamId - The stream it plays
 * @returns The reading
 */
function reading(
  notice: Partial<NonNullable<SpeakerHealthEntry['notice']>> & {
    kind: NonNullable<SpeakerHealthEntry['notice']>['kind'];
  },
  streamId = 's1',
): SpeakerHealthEntry {
  return {
    streamId,
    notice: { noticeId: 1, restartHelps: false, ...notice },
    updatedAt: NOW - 5,
  } as SpeakerHealthEntry;
}

/**
 * A stored away event.
 * @param partial - The fields to set
 * @returns The event
 */
function away(partial: Partial<AwayEvent>): AwayEvent {
  return {
    id: 'e',
    kind: 'cast_ended',
    sev: 'warning',
    subject: 'Song',
    params: {},
    at: NOW - 10,
    shownAt: null,
    ...partial,
  };
}

const leads = (items: BadgeItem[]) => items.map((item) => [item.sev, item.lead.key]);

describe('badgeItems', () => {
  it('should set nothing when all is well', () => {
    expect(badgeItems(sources())).toEqual([]);
  });

  it('should set danger for a lost connection until it is back', () => {
    expect(
      leads(badgeItems(sources({ away: [away({ kind: 'connection_lost', recoveredAt: null })] }))),
    ).toEqual([['danger', 'notice_lead_connection_lost']]);
    const back = away({ kind: 'connection_lost', recoveredAt: NOW });
    expect(leads(badgeItems(sources({ away: [back] })))).toEqual([
      ['warning', 'notice_lead_connection_lost'],
    ]);
    expect(badgeItems(sources({ away: [{ ...back, shownAt: NOW }] }))).toEqual([]);
  });

  it('should set the speakers’ network only while a cast runs', () => {
    const unreachable = {
      networkHealth: 'degraded' as const,
      networkHealthReason: 'speakers_unreachable',
    };
    const noReply = {
      networkHealth: 'degraded' as const,
      networkHealthReason: 'speakers_not_responding',
    };
    expect(leads(badgeItems(sources(unreachable)))).toEqual([
      ['danger', 'notice_lead_unreachable'],
    ]);
    expect(leads(badgeItems(sources(noReply)))).toEqual([['warning', 'notice_lead_no_reply']]);
    expect(badgeItems(sources({ ...unreachable, casts: [] }))).toEqual([]);
  });

  it('should drop "No reply" once the popup dismissed it', () => {
    const noReply = {
      networkHealth: 'degraded' as const,
      networkHealthReason: 'speakers_not_responding',
    };
    expect(badgeItems(sources({ ...noReply, noReplyDismissed: true }))).toEqual([]);
  });

  it('should set a speaker that cut out or may cut out, and not one that nearly did', () => {
    const items = badgeItems(
      sources({
        speakerHealth: {
          a: reading({ kind: 'head_start_ran_out' }),
          b: reading({ kind: 'running_low' }),
          c: reading({ kind: 'head_start_close' }),
          d: reading({ kind: 'drift_uncorrected', minutes: 10 }),
          e: reading({ kind: 'drift_saturated', minutes: 11 }),
          f: reading({ kind: 'running_low' }, 'someone-else'),
        },
      }),
    );
    expect(leads(items)).toEqual([
      ['warning', 'speaker_lead_cut_out'],
      ['warning', 'speaker_lead_may_cut_out_soon'],
      ['warning', 'speaker_lead_may_cut_out_in'],
    ]);
    expect(items[2].lead.params).toEqual({ name: 'Kitchen', minutes: 10 });
  });

  it('should not set a speaker notice the user dismissed', () => {
    const entry = reading({ kind: 'running_low' });
    const dismissals = { ...emptyDismissals(), byNotice: { [`s1|${KITCHEN}|1`]: NOW } };
    expect(
      badgeItems(sources({ speakerHealth: { [KITCHEN]: entry }, speakerDismissals: dismissals })),
    ).toEqual([]);
  });

  it('should set recent gaps until dismissed', () => {
    const report = { gapsLastMinute: 3, worstGapMs: 80, smoothingMs: 200, receivedAt: NOW - 1 };
    expect(leads(badgeItems(sources({ ingestGaps: { s1: report } })))).toEqual([
      ['warning', 'cast_lead_gaps'],
    ]);
    expect(
      badgeItems(sources({ ingestGaps: { s1: report }, ingestDismissed: { s1: NOW - 1 } })),
    ).toEqual([]);
    const old = { ...report, receivedAt: NOW - INGEST_GAPS_NOTICE_MS };
    expect(badgeItems(sources({ ingestGaps: { s1: old } }))).toEqual([]);
  });

  it('should set missing pieces on a running cast until dismissed', () => {
    const captureHealth = { degraded: true, tabId: 4, detectedAt: NOW - 3 };
    expect(leads(badgeItems(sources({ captureHealth })))).toEqual([
      ['warning', 'cast_lead_pieces_missing'],
    ]);
    expect(badgeItems(sources({ captureHealth, captureDismissedAt: NOW - 3 }))).toEqual([]);
    expect(badgeItems(sources({ captureHealth: { ...captureHealth, tabId: 9 } }))).toEqual([]);
  });

  it('should set unseen fault events, and never neutral ones', () => {
    const items = badgeItems(
      sources({
        away: [
          away({ kind: 'cast_ended', sev: 'warning', subject: 'Song' }),
          away({ kind: 'cast_ended', sev: 'neutral' }),
          away({ kind: 'speaker_left', sev: 'neutral' }),
          away({ kind: 'stop_failed', sev: 'danger', subject: 'Patio' }),
          away({ kind: 'join_failed', sev: 'danger', shownAt: NOW }),
        ],
      }),
    );
    expect(items.map((item) => [item.sev, item.lead])).toEqual([
      ['danger', { key: 'room_still_playing', params: { name: 'Patio' } }],
      ['warning', { key: 'cast_ended', params: { name: 'Song' } }],
    ]);
  });
});

describe('badgeFor', () => {
  const item = (sev: 'warning' | 'danger', key: string, at: number): BadgeItem => ({
    sev,
    lead: { key },
    at,
  });

  it('should clear with nothing to say', () => {
    expect(badgeFor([], false)).toBeNull();
  });

  it('should take danger over warning, and the newest of it for the title', () => {
    const badge = badgeFor(
      [item('warning', 'w', 9), item('danger', 'old', 1), item('danger', 'new', 2)],
      false,
    );
    expect(badge).toEqual({
      text: '!',
      bg: CHROME.toolbarBadge.danger.light.bg,
      fg: CHROME.toolbarBadge.danger.light.fg,
      lead: { key: 'new' },
    });
  });

  it('should take the dark pair on a dark toolbar', () => {
    expect(badgeFor([item('warning', 'w', 1)], true)).toMatchObject({
      bg: CHROME.toolbarBadge.warning.dark.bg,
      fg: CHROME.toolbarBadge.warning.dark.fg,
    });
  });
});

describe('writeBadge', () => {
  beforeEach(() => {
    resetChromeStub();
    resetToolbarBadgeForTests();
  });

  it('should write the badge and its title, then nothing while it is the same', async () => {
    const badge = badgeFor(
      [{ sev: 'warning', lead: { key: 'cast_ended', params: { name: 'Song' } }, at: 1 }],
      false,
    );

    await writeBadge(badge);
    await writeBadge(badge);

    expect(actionCalls).toEqual([
      ['setBadgeText', { text: '!' }],
      ['setBadgeBackgroundColor', { color: CHROME.toolbarBadge.warning.light.bg }],
      ['setBadgeTextColor', { color: CHROME.toolbarBadge.warning.light.fg }],
      ['setTitle', { title: 'Thaumic Cast: Cast to Song ended' }],
    ]);
  });

  it('should clear the badge and give the title back', async () => {
    await writeBadge(null);

    expect(actionCalls).toEqual([
      ['setBadgeText', { text: '' }],
      ['setTitle', { title: 'Thaumic Cast' }],
    ]);
  });
});

describe('the toolbar theme and dismissals', () => {
  beforeEach(() => {
    resetChromeStub();
  });

  it('should be light until a document says it is dark', async () => {
    expect(await isToolbarDark()).toBe(false);
    await setToolbarDark(true);
    expect(chromeStorageData.session[TOOLBAR_DARK_KEY]).toBe(true);
    expect(await isToolbarDark()).toBe(true);
  });

  it('should read the dismissals the popup keeps, tolerating junk', async () => {
    chromeStorageData.local.dismissedIngestGapsAt = { s1: 5 };
    chromeStorageData.local.dismissedCaptureHealthAt = 'junk';
    expect(await readDismissals()).toEqual({
      speakerDismissals: emptyDismissals(),
      ingestDismissed: { s1: 5 },
      captureDismissedAt: null,
      noReplyDismissed: false,
    });
  });
});
