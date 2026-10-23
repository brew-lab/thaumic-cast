import { describe, expect, it } from 'bun:test';
import type { SpeakerNotice } from '@thaumic-cast/protocol';
import en from '../locales/en.json';
import {
  CASTBAR_LEADS,
  CONNECTION_LEADS,
  castBarFailure,
  placeNotices,
  speakerPlace,
  type NoticeInputs,
  type NoticeSpeaker,
} from './popup-notices';

const KITCHEN = '192.168.1.51';
const OFFICE = '192.168.1.52';

/**
 * Inputs for one connected cast on two speakers, with nothing wrong.
 * @param over - What to change
 * @returns The inputs
 */
function inputs(over: Partial<NoticeInputs> = {}): NoticeInputs {
  return {
    connection: {
      phase: 'connected',
      error: null,
      canRetry: false,
      networkHealth: 'ok',
      networkHealthReason: null,
    },
    casts: [{ tabId: 7, streamId: 's7', speakerIps: [KITCHEN, OFFICE] }],
    speakers: [],
    missing: [],
    gaps: [],
    capture: null,
    oldCompanion: null,
    noReplyDismissed: false,
    ...over,
  };
}

/**
 * A speaker notice.
 * @param speakerIp - The speaker
 * @param notice - The notice's fields
 * @param dismissed - Dismissed
 * @returns The notice
 */
function speaker(
  speakerIp: string,
  notice: Partial<SpeakerNotice> & Pick<SpeakerNotice, 'kind'>,
  dismissed = false,
): NoticeSpeaker {
  return {
    speakerIp,
    name: speakerIp === KITCHEN ? 'Kitchen' : 'Office',
    notice: { noticeId: 1, restartHelps: false, ...notice },
    lines: [{ key: 'speaker_notice_running_low', params: { name: 'Kitchen', left: 40 } }],
    dismissed,
  };
}

const lost = {
  phase: 'error' as const,
  error: 'error_connection_lost',
  canRetry: true,
  networkHealth: 'ok' as const,
  networkHealthReason: null,
};

describe('placeNotices: the banner (rules 1 and 8)', () => {
  it('should show nothing when all is well', () => {
    const placed = placeNotices(inputs());
    expect(placed.banner).toBeNull();
    expect(placed.section).toBeNull();
    expect(placed.slots[7]).toEqual([]);
    expect(placed.disconnected).toBe(false);
  });

  it('should put a lost connection in the banner, with Reconnect and no X', () => {
    const placed = placeNotices(inputs({ connection: lost }));
    expect(placed.banner).toMatchObject({
      id: 'connection_lost',
      tone: 'danger',
      lead: { key: 'notice_lead_connection_lost' },
      text: { key: 'error_connection_lost' },
      action: { kind: 'retry', label: { key: 'retry_connection' } },
      dismissible: false,
    });
    expect(placed.disconnected).toBe(true);
  });

  it('should name each connection error by its own lead, and offer Try again', () => {
    const cases: [string, string][] = [
      ['error_desktop_not_found', 'notice_lead_not_found'],
      ['error_server_error', 'notice_lead_server_error'],
      ['error_wrong_server', 'notice_lead_wrong_server'],
      ['error_network_failed', 'notice_lead_network_failed'],
      ['error_permission_needed', 'notice_lead_permission_needed'],
      ['error_permission_denied', 'notice_lead_permission_denied'],
    ];
    for (const [error, lead] of cases) {
      const placed = placeNotices(inputs({ connection: { ...lost, error } }));
      expect(placed.banner?.lead.key).toBe(lead);
      expect(placed.banner?.action?.label.key).toBe('try_again');
    }
  });

  it('should link to the download only when nothing answered, beside Try again', () => {
    const placed = placeNotices(
      inputs({ connection: { ...lost, error: 'error_desktop_not_found' } }),
    );
    expect(placed.banner?.action?.kind).toBe('retry');
    expect(placed.banner?.link).toEqual({
      kind: 'download',
      label: { key: 'download_companion' },
    });
    for (const error of [
      'error_connection_lost',
      'error_server_error',
      'error_wrong_server',
      'error_network_failed',
      'error_permission_needed',
      'error_permission_denied',
    ]) {
      expect(placeNotices(inputs({ connection: { ...lost, error } })).banner?.link).toBeUndefined();
    }
    expect(placeNotices(inputs()).banner).toBeNull();
  });

  it('should fold a second condition into the banner as its lead', () => {
    const placed = placeNotices(
      inputs({
        connection: {
          ...lost,
          networkHealth: 'degraded',
          networkHealthReason: 'speakers_unreachable',
        },
      }),
    );
    expect(placed.banner?.id).toBe('connection_lost');
    expect(placed.banner?.also).toEqual({ key: 'notice_lead_unreachable' });
  });

  it('should rank the old companion last, and let it be dismissed', () => {
    const old = { appVersion: '0.11.0', actionKey: 'version_mismatch_action_desktop' };
    const alone = placeNotices(inputs({ oldCompanion: old }));
    expect(alone.banner).toMatchObject({
      id: 'old_companion',
      tone: 'warning',
      dismissible: true,
      text: { key: 'version_old_body', params: { appVersion: '0.11.0' } },
      action: { kind: 'update', label: { key: 'version_mismatch_action_desktop' } },
    });
    expect(alone.disconnected).toBe(false);

    const under = placeNotices(
      inputs({
        oldCompanion: old,
        connection: {
          ...inputs().connection,
          networkHealth: 'degraded',
          networkHealthReason: 'speakers_unreachable',
        },
      }),
    );
    expect(under.banner?.id).toBe('unreachable');
    expect(under.banner?.also).toEqual({ key: 'version_old_lead' });
  });

  it('should say an old companion with no version is too old to say it', () => {
    const placed = placeNotices(inputs({ oldCompanion: { appVersion: null, actionKey: 'x' } }));
    expect(placed.banner?.text).toEqual({ key: 'version_old_body_unknown' });
  });

  it('should show no banner while it is still looking for a companion', () => {
    const placed = placeNotices(
      inputs({ connection: { ...inputs().connection, phase: 'checking' } }),
    );
    expect(placed.banner).toBeNull();
  });
});

describe('placeNotices: the speakers (rules 3 and 4)', () => {
  it('should hide every per-speaker and per-cast item while no speaker can be reached', () => {
    const placed = placeNotices(
      inputs({
        connection: {
          ...inputs().connection,
          networkHealth: 'degraded',
          networkHealthReason: 'speakers_unreachable',
        },
        speakers: [speaker(KITCHEN, { kind: 'running_low' })],
        capture: { tabId: 7, key: 'capture_health_frame_drops_message', hasAction: true },
      }),
    );
    expect(placed.banner?.id).toBe('unreachable');
    expect(placed.slots[7]).toEqual([]);
    expect(placed.conditions).toEqual({});
    expect(placed.section).toBeNull();
  });

  it('should put no reply under the heading, keep its Badge after X, and keep the slots', () => {
    const degraded = {
      ...inputs().connection,
      networkHealth: 'degraded' as const,
      networkHealthReason: 'speakers_not_responding',
    };
    const open = placeNotices(
      inputs({ connection: degraded, speakers: [speaker(KITCHEN, { kind: 'running_low' })] }),
    );
    expect(open.section?.lead.key).toBe('notice_lead_no_reply');
    expect(open.headingBadge).toEqual({ key: 'badge_no_reply' });
    expect(open.slots[7]).toHaveLength(1);

    const dismissed = placeNotices(inputs({ connection: degraded, noReplyDismissed: true }));
    expect(dismissed.section).toBeNull();
    expect(dismissed.headingBadge).toEqual({ key: 'badge_no_reply' });

    const idle = placeNotices(inputs({ connection: degraded, casts: [] }));
    expect(idle.section).not.toBeNull();
    expect(idle.headingBadge).toBeNull();
  });
});

describe('placeNotices: a cast slot (order, rule 5, the quiet tier)', () => {
  it('should order may cut out soon, cut out, pieces missing, then drift', () => {
    const placed = placeNotices(
      inputs({
        speakers: [
          speaker(KITCHEN, { kind: 'drift_uncorrected', minutes: 8 }),
          speaker(OFFICE, { kind: 'head_start_ran_out', suggestedHeadStartMs: 1200 }),
        ],
        capture: { tabId: 7, key: 'capture_health_frame_drops_message', hasAction: true },
      }),
    );
    expect(placed.slots[7].map((item) => item.lead.key)).toEqual([
      'speaker_lead_cut_out',
      'cast_lead_pieces_missing',
      'speaker_lead_may_cut_out_in',
    ]);
    expect(placed.slots[7][0].text).toEqual({
      key: 'speaker_remedy_head_start',
      params: { suggested: 1200 },
    });
    expect(placed.slots[7][2].lead.params).toEqual({ name: 'Kitchen', minutes: 8 });
    expect(placed.slots[7][1].action?.kind).toBe('open_settings');
  });

  it('should put running low first', () => {
    const placed = placeNotices(
      inputs({
        speakers: [
          speaker(KITCHEN, { kind: 'head_start_no_remedy' }),
          speaker(OFFICE, { kind: 'running_low', restartHelps: true }),
        ],
      }),
    );
    expect(placed.slots[7].map((item) => item.lead.key)).toEqual([
      'speaker_lead_may_cut_out_soon',
      'speaker_lead_cut_out',
    ]);
    expect(placed.slots[7][0].text).toEqual({ key: 'speaker_notice_restart_refills' });
    expect(placed.slots[7][1].text).toBeUndefined();
  });

  it('should hide the gaps when capture health already explains them', () => {
    const gaps = [
      { streamId: 's7', hasRemedy: true, line: { key: 'ingest_gaps_message_desktop' } },
    ];
    const both = placeNotices(
      inputs({
        gaps,
        capture: { tabId: 7, key: 'capture_health_frame_drops_message', hasAction: false },
      }),
    );
    expect(both.slots[7].map((item) => item.lead.key)).toEqual(['cast_lead_pieces_missing']);
    expect(both.slots[7][0].action).toBeUndefined();

    const alone = placeNotices(inputs({ gaps }));
    expect(alone.slots[7]).toMatchObject([
      {
        lead: { key: 'cast_lead_gaps' },
        action: { kind: 'open_audio_settings' },
        source: { kind: 'gaps', streamId: 's7' },
      },
    ]);
  });

  it('should show nearly cut out and far drift nowhere, and give them no Badge', () => {
    const placed = placeNotices(
      inputs({
        speakers: [
          speaker(KITCHEN, { kind: 'head_start_close', suggestedHeadStartMs: 900 }),
          speaker(OFFICE, { kind: 'drift_saturated', minutes: 40 }),
        ],
      }),
    );
    expect(placed.slots[7]).toEqual([]);
    expect(placed.conditions).toEqual({});
  });

  it('should keep a dismissed notice out of the slot and its Badge on the row', () => {
    const placed = placeNotices(
      inputs({ speakers: [speaker(KITCHEN, { kind: 'head_start_no_remedy' }, true)] }),
    );
    expect(placed.slots[7]).toEqual([]);
    expect(placed.conditions[KITCHEN]).toEqual({ label: { key: 'badge_cut_out' } });
  });

  it('should place each notice in its own cast only', () => {
    const placed = placeNotices(
      inputs({
        casts: [
          { tabId: 7, streamId: 's7', speakerIps: [KITCHEN] },
          { tabId: 8, streamId: 's8', speakerIps: [OFFICE] },
        ],
        speakers: [speaker(OFFICE, { kind: 'running_low' })],
        capture: { tabId: 7, key: 'capture_health_frame_drops_message', hasAction: true },
      }),
    );
    expect(placed.slots[7].map((item) => item.source.kind)).toEqual(['capture']);
    expect(placed.slots[8].map((item) => item.source.kind)).toEqual(['speaker']);
  });
});

describe('speakerPlace', () => {
  it('should leave a head start that ran out with no suggestion without a remedy line', () => {
    expect(
      speakerPlace({ kind: 'head_start_ran_out', noticeId: 1, restartHelps: false })?.remedy,
    ).toBeUndefined();
  });
});

describe('castBarFailure', () => {
  it('should give each Cast error its short lead and keep the shipped sentence', () => {
    expect(castBarFailure('error_max_sessions', { max: 5 })).toEqual({
      lead: { key: 'castbar_lead_max_sessions', params: { max: 5 } },
      text: { key: 'error_max_sessions', params: { max: 5 } },
    });
    expect(castBarFailure('error_pcm_rate_unsupported', { rate: 96000 }).lead.key).toBe(
      'castbar_lead_rate',
    );
  });

  it('should call anything else a cast that did not start', () => {
    expect(castBarFailure(undefined).lead.key).toBe('castbar_lead_cast_failed');
    expect(castBarFailure('Something odd').lead.key).toBe('castbar_lead_cast_failed');
    expect(castBarFailure('Something odd').text.key).toBe('Something odd');
  });
});

describe('the words the rules choose', () => {
  const strings = en as Record<string, string>;
  it('should have an entry for every lead and every error a lead stands for', () => {
    for (const table of [CONNECTION_LEADS, CASTBAR_LEADS]) {
      for (const [error, lead] of Object.entries(table)) {
        expect(strings[error]).toBeString();
        expect(strings[lead]).toBeString();
      }
    }
  });

  it('should have an entry for every key a placed notice can carry', () => {
    const keys = [
      'notice_lead_unreachable',
      'network.speakers_unreachable',
      'notice_lead_no_reply',
      'network.speakers_not_responding',
      'badge_no_reply',
      'badge_may_cut_out',
      'badge_cut_out',
      'speaker_lead_may_cut_out_soon',
      'speaker_lead_cut_out',
      'speaker_lead_may_cut_out_in',
      'speaker_remedy_head_start',
      'cast_lead_pieces_missing',
      'cast_lead_gaps',
      'version_old_lead',
      'version_old_body',
      'version_old_body_unknown',
      'connection_status_disconnected',
      'retry_connection',
      'try_again',
      'download_companion',
    ];
    expect(keys.filter((key) => typeof strings[key] !== 'string')).toEqual([]);
  });
});

describe('placeNotices: a speaker gone from the household', () => {
  it('should lead the slot with it, badge its row and offer no X', () => {
    const placed = placeNotices(
      inputs({
        missing: [{ speakerIp: OFFICE, name: 'Office' }],
        speakers: [
          speaker(KITCHEN, { kind: 'running_low' }),
          speaker(OFFICE, { kind: 'running_low' }),
        ],
      }),
    );
    const slot = placed.slots[7];
    expect(slot.map((item) => item.id)).toEqual([`missing:${OFFICE}`, `speaker:${KITCHEN}:1`]);
    expect(slot[0]).toMatchObject({
      source: { kind: 'missing', speakerIp: OFFICE },
      lead: { key: 'speaker_lead_not_answering', params: { name: 'Office' } },
      text: { key: 'speaker_not_answering_text' },
    });
    expect(placed.conditions[OFFICE]).toEqual({ label: { key: 'badge_not_answering' } });
    for (const key of ['badge_not_answering', 'speaker_lead_not_answering']) {
      expect(en).toHaveProperty(key);
    }
  });

  it('should say nothing about it while the connection is lost', () => {
    const placed = placeNotices(
      inputs({ connection: lost, missing: [{ speakerIp: OFFICE, name: 'Office' }] }),
    );
    expect(placed.slots[7]).toEqual([]);
    expect(placed.conditions).toEqual({});
  });
});
