import { describe, expect, it } from 'bun:test';
import type { CompanionAudio, SpeakerNotice } from '@thaumic-cast/protocol';

import en from '../locales/en.json';
import { hasEntry } from '../test-support/locale-keys';
import {
  HEAD_START_NOTICE_MEMORY_MS,
  dismissNotice,
  emptyDismissals,
  ingestGapsLine,
  isNoticeDismissed,
  parseDismissals,
  speakerNoticeLines,
  type NoticeWordingContext,
} from './speaker-notices';

const KITCHEN = '192.168.1.10';
const STREAM = 'stream-1';
const NOW = 1_700_000_000_000;

const AUDIO: CompanionAudio = { headStartMs: 500, headStartFixed: false, speakerMonitor: true };

function ctx(fields: Partial<NoticeWordingContext> = {}): NoticeWordingContext {
  return { speakerName: 'Kitchen', companionAudio: AUDIO, appType: 'desktop', ...fields };
}

const ranOut: SpeakerNotice = {
  kind: 'head_start_ran_out',
  noticeId: 1,
  stallMs: 620,
  leftMs: -120,
  headStartMs: 500,
  suggestedHeadStartMs: 750,
  restartHelps: false,
};

function keys(notice: SpeakerNotice, context = ctx()): string[] {
  return speakerNoticeLines(notice, context).map((line) => line.key);
}

describe('speakerNoticeLines', () => {
  it('should word a head start that ran out with its figures and the desktop where line', () => {
    expect(speakerNoticeLines(ranOut, ctx())).toEqual([
      {
        key: 'speaker_notice_head_start_ran_out',
        params: { stall: 620, name: 'Kitchen', current: 500, left: 0, suggested: 750 },
      },
      { key: 'speaker_notice_where_desktop' },
    ]);
  });

  it('should pick the _off variant when the connection had no head start', () => {
    const off = { ...ranOut, headStartMs: 0, suggestedHeadStartMs: 500 };
    expect(keys(off)[0]).toBe('speaker_notice_head_start_ran_out_off');
    expect(keys({ ...off, kind: 'head_start_close' })[0]).toBe(
      'speaker_notice_head_start_close_off',
    );
  });

  it('should say where to change the head start: env first, then app type, then neutrally', () => {
    const fixed = ctx({ companionAudio: { ...AUDIO, headStartFixed: true }, appType: 'server' });
    expect(keys(ranOut, fixed)[1]).toBe('speaker_notice_where_fixed');
    expect(speakerNoticeLines(ranOut, ctx({ appType: 'server' }))[1]).toEqual({
      key: 'speaker_notice_where_server',
      params: { suggested: 750 },
    });
    expect(keys(ranOut, ctx({ appType: null }))[1]).toBe('speaker_notice_where_unknown');
    // Without the companion's settings, whether an env var fixes it is unknown.
    expect(keys(ranOut, ctx({ companionAudio: null }))[1]).toBe('speaker_notice_where_unknown');
  });

  it('should follow the companion audio settings as they change', () => {
    const before = keys(ranOut, ctx());
    const after = keys(ranOut, ctx({ companionAudio: { ...AUDIO, headStartFixed: true } }));
    expect(before[1]).toBe('speaker_notice_where_desktop');
    expect(after[1]).toBe('speaker_notice_where_fixed');
  });

  it('should give no where line for a stall no head start covers', () => {
    const noRemedy: SpeakerNotice = {
      kind: 'head_start_no_remedy',
      noticeId: 2,
      stallMs: 2400,
      headStartMs: 500,
      restartHelps: false,
    };
    expect(speakerNoticeLines(noRemedy, ctx())).toEqual([
      { key: 'speaker_notice_head_start_no_remedy', params: { stall: 2400, name: 'Kitchen' } },
    ]);
  });

  it('should add restart advice only when the companion says a restart refills', () => {
    const low: SpeakerNotice = { kind: 'running_low', noticeId: 3, leftMs: 90, restartHelps: true };
    expect(speakerNoticeLines(low, ctx())).toEqual([
      { key: 'speaker_notice_running_low', params: { name: 'Kitchen', left: 90 } },
      { key: 'speaker_notice_restart_refills' },
    ]);
    expect(keys({ ...low, restartHelps: false })).toEqual(['speaker_notice_running_low']);
  });

  it('should word drift notices in minutes', () => {
    const drift: SpeakerNotice = {
      kind: 'drift_uncorrected',
      noticeId: 4,
      minutes: 25,
      restartHelps: true,
    };
    expect(speakerNoticeLines(drift, ctx())[0]).toEqual({
      key: 'speaker_notice_drift_uncorrected',
      params: { name: 'Kitchen', minutes: 25 },
    });
  });

  it('should offer drift correction for an uncorrected drift where the companion has it off', () => {
    const drift: SpeakerNotice = {
      kind: 'drift_uncorrected',
      noticeId: 4,
      minutes: 25,
      restartHelps: true,
    };
    const observing = { ...AUDIO, driftCompensation: 'observe' as const };
    expect(keys(drift, ctx({ companionAudio: observing }))).toEqual([
      'speaker_notice_drift_uncorrected',
      'speaker_notice_drift_turn_on_desktop',
      'speaker_notice_restart_refills',
    ]);
    expect(keys(drift, ctx({ companionAudio: observing, appType: 'server' }))[1]).toBe(
      'speaker_notice_drift_turn_on_server',
    );
    // Not when it is already on, the monitor it steers by is off, the
    // companion predates it, or where to turn it on is unknown.
    for (const context of [
      ctx({ companionAudio: { ...AUDIO, driftCompensation: 'on' } }),
      ctx({ companionAudio: { ...observing, speakerMonitor: false } }),
      ctx(),
      ctx({ companionAudio: observing, appType: null }),
      ctx({ companionAudio: null }),
    ]) {
      expect(keys(drift, context)).not.toContain('speaker_notice_drift_turn_on_desktop');
      expect(keys(drift, context)).not.toContain('speaker_notice_drift_turn_on_server');
    }
    // A saturated drift is one correction is already running for.
    const saturated: SpeakerNotice = { ...drift, kind: 'drift_saturated' };
    expect(keys(saturated, ctx({ companionAudio: observing }))).toEqual([
      'speaker_notice_drift_saturated',
      'speaker_notice_restart_refills',
    ]);
  });

  describe('running low from clock drift', () => {
    const low: SpeakerNotice = {
      kind: 'running_low',
      noticeId: 5,
      leftMs: 149,
      headStartMs: 500,
      restartHelps: true,
      cause: 'drift',
    };
    const observing = { ...AUDIO, driftCompensation: 'observe' as const };
    const off = { ...AUDIO, driftCompensation: 'off' as const };

    it('should keep the reason, the fix and the restart advice', () => {
      expect(speakerNoticeLines(low, ctx({ companionAudio: observing }))).toEqual([
        { key: 'speaker_notice_running_low', params: { name: 'Kitchen', left: 149 } },
        { key: 'speaker_notice_running_low_drift', params: { name: 'Kitchen' } },
        { key: 'speaker_notice_drift_turn_on_desktop' },
        { key: 'speaker_notice_restart_refills' },
      ]);
      expect(keys(low, ctx({ companionAudio: off, appType: 'server' }))).toEqual([
        'speaker_notice_running_low',
        'speaker_notice_running_low_drift',
        'speaker_notice_drift_turn_on_server',
        'speaker_notice_restart_refills',
      ]);
    });

    it('should leave out restart advice when a restart would not refill', () => {
      expect(keys({ ...low, restartHelps: false }, ctx({ companionAudio: observing }))).toEqual([
        'speaker_notice_running_low',
        'speaker_notice_running_low_drift',
        'speaker_notice_drift_turn_on_desktop',
      ]);
    });

    it('should not offer drift correction when it is on or cannot be offered', () => {
      for (const context of [
        ctx({ companionAudio: { ...AUDIO, driftCompensation: 'on' } }),
        ctx({ companionAudio: { ...observing, speakerMonitor: false } }),
        ctx(),
        ctx({ companionAudio: observing, appType: null }),
        ctx({ companionAudio: null }),
      ]) {
        expect(keys(low, context)).toEqual([
          'speaker_notice_running_low',
          'speaker_notice_running_low_drift',
          'speaker_notice_restart_refills',
        ]);
      }
    });

    it('should say nothing of the clock without the cause', () => {
      const plain: SpeakerNotice = { ...low, cause: undefined };
      expect(keys(plain, ctx({ companionAudio: observing }))).toEqual([
        'speaker_notice_running_low',
        'speaker_notice_restart_refills',
      ]);
    });
  });

  it('should only use keys the locale defines', () => {
    const strings = en as Record<string, string>;
    const notices: SpeakerNotice[] = [
      ranOut,
      { ...ranOut, headStartMs: 0 },
      { ...ranOut, kind: 'head_start_close', leftMs: 60 },
      { ...ranOut, kind: 'head_start_close', headStartMs: 0 },
      { ...ranOut, kind: 'head_start_no_remedy', suggestedHeadStartMs: undefined },
      { kind: 'running_low', noticeId: 1, leftMs: 90, restartHelps: true },
      { kind: 'running_low', noticeId: 1, leftMs: 90, restartHelps: true, cause: 'drift' },
      { kind: 'drift_uncorrected', noticeId: 1, minutes: 20, restartHelps: true },
      { kind: 'drift_saturated', noticeId: 1, minutes: 20, restartHelps: false },
    ];
    const contexts = [
      ctx(),
      ctx({ appType: 'server' }),
      ctx({ appType: null }),
      ctx({ companionAudio: { ...AUDIO, headStartFixed: true } }),
      ctx({ companionAudio: { ...AUDIO, driftCompensation: 'observe' } }),
      ctx({ companionAudio: { ...AUDIO, driftCompensation: 'off' }, appType: 'server' }),
    ];
    for (const notice of notices) {
      for (const context of contexts) {
        for (const line of speakerNoticeLines(notice, context)) {
          expect(hasEntry(strings, line.key)).toBe(true);
        }
      }
    }
    for (const suggestedSmoothingMs of [500, undefined]) {
      for (const appType of ['desktop', 'server', null] as const) {
        const line = ingestGapsLine(
          { gapsLastMinute: 2, worstGapMs: 280, suggestedSmoothingMs },
          appType,
        );
        // The count picks a plural form, so the entry is `key` or `key_other`.
        expect(hasEntry(strings, line.key)).toBe(true);
      }
    }
    expect(strings.speaker_notice_dismiss).toBeString();
    expect(strings.ingest_gaps_action_open_settings).toBeString();
  });

  it('should name the setting plain smoothing in the ingest copy', () => {
    const strings = en as Record<string, string>;
    for (const key of Object.keys(strings).filter((k) => k.startsWith('ingest_gaps_'))) {
      expect(strings[key]).not.toMatch(/browser smoothing|server smoothing/i);
    }
  });
});

describe('notice dismissal', () => {
  it('should stay dismissed while the companion repeats the same episode', () => {
    const dismissed = dismissNotice(emptyDismissals(), STREAM, KITCHEN, ranOut, NOW);

    expect(isNoticeDismissed(dismissed, STREAM, KITCHEN, ranOut, NOW + 30_000)).toBe(true);
  });

  it('should return when the notice escalates to a new episode with a higher suggestion', () => {
    const dismissed = dismissNotice(emptyDismissals(), STREAM, KITCHEN, ranOut, NOW);
    const escalated = { ...ranOut, noticeId: 2, suggestedHeadStartMs: 1000 };

    expect(isNoticeDismissed(dismissed, STREAM, KITCHEN, escalated, NOW + 60_000)).toBe(false);
  });

  it('should return when a close call escalates to running out at the same suggestion', () => {
    const close = { ...ranOut, kind: 'head_start_close' as const };
    const dismissed = dismissNotice(emptyDismissals(), STREAM, KITCHEN, close, NOW);

    expect(isNoticeDismissed(dismissed, STREAM, KITCHEN, { ...ranOut, noticeId: 2 }, NOW)).toBe(
      false,
    );
  });

  it('should remember dismissed head-start advice on the next cast for 24 hours', () => {
    const dismissed = dismissNotice(emptyDismissals(), STREAM, KITCHEN, ranOut, NOW);
    const nextCast = 'stream-2';

    expect(isNoticeDismissed(dismissed, nextCast, KITCHEN, ranOut, NOW + 3_600_000)).toBe(true);
    expect(
      isNoticeDismissed(dismissed, nextCast, KITCHEN, ranOut, NOW + HEAD_START_NOTICE_MEMORY_MS),
    ).toBe(false);
    // Another speaker's advice is its own.
    expect(isNoticeDismissed(dismissed, nextCast, '192.168.1.11', ranOut, NOW)).toBe(false);
  });

  it('should not carry a dismissed running-low notice over to the next cast', () => {
    const low: SpeakerNotice = { kind: 'running_low', noticeId: 1, leftMs: 90, restartHelps: true };
    const dismissed = dismissNotice(emptyDismissals(), STREAM, KITCHEN, low, NOW);

    expect(isNoticeDismissed(dismissed, STREAM, KITCHEN, low, NOW)).toBe(true);
    expect(isNoticeDismissed(dismissed, 'stream-2', KITCHEN, low, NOW)).toBe(false);
  });

  it('should drop entries older than the memory when recording a new dismissal', () => {
    const old = dismissNotice(emptyDismissals(), STREAM, KITCHEN, ranOut, NOW);
    const later = NOW + HEAD_START_NOTICE_MEMORY_MS + 1;
    const next = dismissNotice(old, 'stream-2', KITCHEN, { ...ranOut, noticeId: 9 }, later);

    expect(Object.keys(next.byNotice)).toEqual([`stream-2|${KITCHEN}|9`]);
    expect(Object.values(next.headStart)).toEqual([later + HEAD_START_NOTICE_MEMORY_MS]);
  });

  it('should read malformed storage as no dismissals', () => {
    expect(parseDismissals(undefined)).toEqual(emptyDismissals());
    expect(parseDismissals({ byNotice: { a: 'x' }, headStart: 3 })).toEqual(emptyDismissals());
    expect(parseDismissals({ byNotice: { a: 1 }, headStart: {} }).byNotice).toEqual({ a: 1 });
  });
});

describe('ingestGapsLine', () => {
  it('should suggest the smoothing step, naming the companion by type', () => {
    expect(
      ingestGapsLine({ gapsLastMinute: 3, worstGapMs: 280, suggestedSmoothingMs: 500 }, 'server'),
    ).toEqual({ key: 'ingest_gaps_message_server', params: { count: 3, suggested: 500 } });
  });

  it('should give the no-remedy copy when no step would cover the gap', () => {
    expect(ingestGapsLine({ gapsLastMinute: 2, worstGapMs: 900 }, 'desktop')).toEqual({
      key: 'ingest_gaps_no_remedy_desktop',
      params: { worst: 900 },
    });
  });
});
