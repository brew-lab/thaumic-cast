import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { SpeakerNotice } from '@thaumic-cast/protocol';

import en from '../locales/en.json';
import extensionEn from '../../../extension/src/locales/en.json';
import {
  HEAD_START_NOTICE_MEMORY_MS,
  HEAD_START_OPTIONS_MS,
  currentReadings,
  dismissNotice,
  emptyDismissals,
  headStartOptions,
  isNoticeDismissed,
  noticeOffersSettings,
  speakerNoticeLines,
  type NoticeWordingContext,
} from './speaker-notices';

const KITCHEN = '192.168.1.10';
const STREAM = 'stream-1';
const NOW = 1_700_000_000_000;

function ctx(fields: Partial<NoticeWordingContext> = {}): NoticeWordingContext {
  return { speakerName: 'Kitchen', headStartFixed: false, offerDriftCorrection: false, ...fields };
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

describe('headStartOptions', () => {
  it('should offer off and the ladder up to 2000 ms', () => {
    expect(headStartOptions(500)).toEqual(
      [0, 250, 500, 750, 1000, 1500, 2000].map((ms) => ({ ms, custom: false })),
    );
  });

  it("should offer every step the core's notices may suggest", () => {
    const constants = readFileSync(
      new URL('../../../../packages/thaumic-core/src/protocol_constants.rs', import.meta.url),
      'utf8',
    );
    const match = /pub const HEAD_START_LADDER_MS: \[u32; \d+\] = \[([^\]]+)\];/.exec(constants);
    expect(match).not.toBeNull();
    const ladder = match![1].split(',').map((step) => Number(step.trim()));
    expect(HEAD_START_OPTIONS_MS).toEqual([0, ...ladder]);
  });

  it('should show an off-ladder value as a custom option in order', () => {
    const options = headStartOptions(600);
    expect(options.map((o) => o.ms)).toEqual([0, 250, 500, 600, 750, 1000, 1500, 2000]);
    expect(options.filter((o) => o.custom)).toEqual([{ ms: 600, custom: true }]);
  });
});

describe('speakerNoticeLines', () => {
  it('should word a head start that ran out and point at Settings > Speakers', () => {
    expect(speakerNoticeLines(ranOut, ctx())).toEqual([
      {
        key: 'dashboard.speaker_notice_head_start_ran_out',
        params: { stall: 620, name: 'Kitchen', current: 500, left: 0, suggested: 750 },
      },
      { key: 'dashboard.speaker_notice_where' },
    ]);
  });

  it('should pick the _off variant when the connection had no head start', () => {
    const off = { ...ranOut, headStartMs: 0, suggestedHeadStartMs: 500 };
    expect(keys(off)[0]).toBe('dashboard.speaker_notice_head_start_ran_out_off');
    expect(keys({ ...off, kind: 'head_start_close' })[0]).toBe(
      'dashboard.speaker_notice_head_start_close_off',
    );
  });

  it('should name the environment variable when it fixes the head start', () => {
    expect(keys(ranOut, ctx({ headStartFixed: true }))[1]).toBe(
      'dashboard.speaker_notice_where_fixed',
    );
  });

  it('should give no where line for a stall no head start covers', () => {
    const noRemedy: SpeakerNotice = {
      kind: 'head_start_no_remedy',
      noticeId: 2,
      stallMs: 2400,
      headStartMs: 500,
      restartHelps: false,
    };
    expect(keys(noRemedy)).toEqual(['dashboard.speaker_notice_head_start_no_remedy']);
  });

  it('should add restart advice only when the core says a restart refills', () => {
    const low: SpeakerNotice = { kind: 'running_low', noticeId: 3, leftMs: 90, restartHelps: true };
    expect(keys(low)).toEqual([
      'dashboard.speaker_notice_running_low',
      'dashboard.speaker_notice_restart_refills',
    ]);
    expect(keys({ ...low, restartHelps: false })).toEqual(['dashboard.speaker_notice_running_low']);
  });

  it('should offer drift correction for an uncorrected drift only when it can be turned on here', () => {
    const drift: SpeakerNotice = {
      kind: 'drift_uncorrected',
      noticeId: 4,
      minutes: 25,
      restartHelps: true,
    };
    expect(keys(drift, ctx({ offerDriftCorrection: true }))).toEqual([
      'dashboard.speaker_notice_drift_uncorrected',
      'dashboard.speaker_notice_drift_turn_on_desktop',
      'dashboard.speaker_notice_restart_refills',
    ]);
    expect(keys(drift)).not.toContain('dashboard.speaker_notice_drift_turn_on_desktop');
    const saturated: SpeakerNotice = { ...drift, kind: 'drift_saturated' };
    expect(keys(saturated, ctx({ offerDriftCorrection: true }))).not.toContain(
      'dashboard.speaker_notice_drift_turn_on_desktop',
    );
  });

  it('should have a string for every key it can produce', () => {
    const notices: SpeakerNotice[] = [
      ranOut,
      { ...ranOut, headStartMs: 0 },
      { ...ranOut, kind: 'head_start_close' },
      { ...ranOut, kind: 'head_start_close', headStartMs: 0 },
      { kind: 'head_start_no_remedy', noticeId: 1, stallMs: 2400, restartHelps: false },
      { kind: 'running_low', noticeId: 1, leftMs: 90, restartHelps: true },
      { kind: 'drift_uncorrected', noticeId: 1, minutes: 20, restartHelps: true },
      { kind: 'drift_saturated', noticeId: 1, minutes: 20, restartHelps: false },
    ];
    const strings = en as Record<string, string>;
    for (const notice of notices) {
      for (const fixed of [false, true]) {
        const context = ctx({ headStartFixed: fixed, offerDriftCorrection: !fixed });
        for (const key of keys(notice, context)) {
          expect(strings[key]).toBeString();
        }
      }
    }
  });

  it('should word each shared notice exactly as the extension does', () => {
    const strings = en as Record<string, string>;
    const extension = extensionEn as Record<string, string>;
    const shared = Object.keys(strings).filter(
      (key) =>
        key.startsWith('dashboard.speaker_notice_') &&
        key !== 'dashboard.speaker_notice_where' &&
        key !== 'dashboard.speaker_notice_where_fixed' &&
        !key.endsWith('_open_settings'),
    );
    expect(shared.length).toBeGreaterThan(0);
    for (const key of shared) {
      expect(strings[key]).toBe(extension[key.slice('dashboard.'.length)]);
    }
  });
});

describe('noticeOffersSettings', () => {
  it('should offer settings for head-start advice the user can act on here', () => {
    expect(noticeOffersSettings(ranOut, false)).toBe(true);
    expect(noticeOffersSettings({ ...ranOut, kind: 'head_start_close' }, false)).toBe(true);
  });

  it('should not offer settings when the environment fixes the head start or there is no step', () => {
    expect(noticeOffersSettings(ranOut, true)).toBe(false);
    expect(
      noticeOffersSettings(
        { ...ranOut, kind: 'head_start_no_remedy', suggestedHeadStartMs: undefined },
        false,
      ),
    ).toBe(false);
    expect(
      noticeOffersSettings({ kind: 'running_low', noticeId: 1, restartHelps: true }, false),
    ).toBe(false);
  });
});

describe('dismissal', () => {
  it('should keep a notice dismissed while the core repeats it', () => {
    const dismissed = dismissNotice(emptyDismissals(), STREAM, KITCHEN, ranOut, NOW);
    // The core repeats the same notice id in every 30 s report.
    expect(isNoticeDismissed(dismissed, STREAM, KITCHEN, ranOut, NOW + 30_000)).toBe(true);
    expect(isNoticeDismissed(dismissed, STREAM, KITCHEN, ranOut, NOW + 30 * 60_000)).toBe(true);
  });

  it('should show an escalation to a higher head start again', () => {
    const dismissed = dismissNotice(emptyDismissals(), STREAM, KITCHEN, ranOut, NOW);
    const higher = { ...ranOut, noticeId: 2, suggestedHeadStartMs: 1000 };
    expect(isNoticeDismissed(dismissed, STREAM, KITCHEN, higher, NOW + 60_000)).toBe(false);
  });

  it('should remember the same head-start advice across casts for 24 hours', () => {
    const dismissed = dismissNotice(emptyDismissals(), STREAM, KITCHEN, ranOut, NOW);
    const nextCast = { ...ranOut, noticeId: 1 };
    expect(isNoticeDismissed(dismissed, 'stream-2', KITCHEN, nextCast, NOW + 60_000)).toBe(true);
    expect(
      isNoticeDismissed(
        dismissed,
        'stream-2',
        KITCHEN,
        nextCast,
        NOW + HEAD_START_NOTICE_MEMORY_MS + 1,
      ),
    ).toBe(false);
    // Another speaker's advice is its own.
    expect(isNoticeDismissed(dismissed, 'stream-2', '192.168.1.11', nextCast, NOW)).toBe(false);
  });

  it('should not carry a running-low dismissal over to the next cast', () => {
    const low: SpeakerNotice = { kind: 'running_low', noticeId: 1, leftMs: 90, restartHelps: true };
    const dismissed = dismissNotice(emptyDismissals(), STREAM, KITCHEN, low, NOW);
    expect(isNoticeDismissed(dismissed, 'stream-2', KITCHEN, low, NOW + 60_000)).toBe(false);
  });

  it('should drop dismissals older than the memory', () => {
    const first = dismissNotice(emptyDismissals(), STREAM, KITCHEN, ranOut, NOW);
    const later = NOW + HEAD_START_NOTICE_MEMORY_MS + 1;
    const second = dismissNotice(first, 'stream-2', KITCHEN, { ...ranOut, noticeId: 5 }, later);
    expect(Object.keys(second.byNotice)).toEqual([`stream-2|${KITCHEN}|5`]);
  });
});

describe('currentReadings', () => {
  const reading = { streamId: STREAM, notice: ranOut };

  it('should keep a reading about the stream the speaker plays now', () => {
    const readings = { [KITCHEN]: reading };
    expect(currentReadings(readings, { [KITCHEN]: STREAM })).toBe(readings);
  });

  it('should drop a reading from an earlier cast when the speaker plays a new stream', () => {
    expect(currentReadings({ [KITCHEN]: reading }, { [KITCHEN]: 'stream-2' })).toEqual({});
  });

  it('should drop a reading for a speaker that no longer casts', () => {
    const lounge = '192.168.1.11';
    const readings = { [KITCHEN]: reading, [lounge]: { streamId: STREAM } };
    expect(currentReadings(readings, { [lounge]: STREAM })).toEqual({
      [lounge]: { streamId: STREAM },
    });
  });
});
