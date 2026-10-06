import { beforeEach, describe, expect, it } from 'bun:test';

import { readVolume } from '../popup/hooks/useSonosState';
import { resetChromeStub, runtimeMessages } from '../test-support/chrome-stub';
import { StartCastMessageSchema } from './message-schemas';
import {
  buildStartVolume,
  pendingStartsFor,
  startCeilingChoices,
  startLevelCaption,
  startLevelView,
  startLimitOf,
  withPendingStart,
} from './start-level';

const KITCHEN = '192.168.1.10';
const STUDY = '192.168.1.11';
const ON = { startCeilingEnabled: true, startCeiling: 30 };
const OFF = { startCeilingEnabled: false, startCeiling: 30 };

beforeEach(() => {
  resetChromeStub();
});

describe('startLimitOf', () => {
  it('should give the limit only while it is on', () => {
    expect(startLimitOf(ON)).toBe(30);
    expect(startLimitOf(OFF)).toBeUndefined();
  });
});

describe('buildStartVolume', () => {
  it('should send the limit when it is on', () => {
    expect(buildStartVolume(ON, [KITCHEN])).toEqual({ limit: 30 });
  });

  it('should send nothing with the limit off and nothing set by hand', () => {
    expect(buildStartVolume(OFF, [KITCHEN])).toBeUndefined();
  });

  it('should send hand-set levels for the cast’s speakers only', () => {
    expect(buildStartVolume(OFF, [KITCHEN], { [KITCHEN]: 45, [STUDY]: 12 })).toEqual({
      speakers: { [KITCHEN]: 45 },
    });
    expect(buildStartVolume(ON, [KITCHEN, STUDY], { [STUDY]: 12 })).toEqual({
      limit: 30,
      speakers: { [STUDY]: 12 },
    });
  });
});

describe('the start slider before Cast', () => {
  it('should keep a hand-set level in the popup and send nothing to the speaker', () => {
    let pending: Record<string, number> = {};
    pending = withPendingStart(pending, KITCHEN, 40);
    pending = withPendingStart(pending, KITCHEN, 45);

    expect(pending).toEqual({ [KITCHEN]: 45 });
    expect(runtimeMessages).toEqual([]);
  });

  it('should carry the hand-set level of a chosen speaker in START_CAST only', () => {
    const pending = { [KITCHEN]: 45, [STUDY]: 12 };
    const message = {
      type: 'START_CAST',
      payload: { speakerIps: [KITCHEN], startLevels: pendingStartsFor([KITCHEN], pending) },
    };

    const parsed = StartCastMessageSchema.parse(message);

    expect(parsed.payload.startLevels).toEqual({ [KITCHEN]: 45 });
  });
});

describe('startLevelView and startLevelCaption', () => {
  it('should show the limit for a room above it, with the room’s level now', () => {
    const view = startLevelView({ current: 72, fixed: false, limit: 30, pending: undefined });

    expect(view).toEqual({ kind: 'known', now: 72, start: 30 });
    expect(startLevelCaption(view)).toEqual({
      key: 'start_level_caption',
      params: { now: 72, start: 30 },
    });
  });

  it('should show a room at or under the limit as it is, with no caption', () => {
    const view = startLevelView({ current: 18, fixed: false, limit: 30, pending: undefined });

    expect(view).toEqual({ kind: 'known', now: 18, start: 18 });
    expect(startLevelCaption(view)).toBeNull();
  });

  it('should show a hand-set level, even above the limit', () => {
    const view = startLevelView({ current: 41, fixed: false, limit: 30, pending: 45 });

    expect(view).toEqual({ kind: 'known', now: 41, start: 45 });
    expect(startLevelCaption(view)?.params).toEqual({ now: 41, start: 45 });
  });

  it('should not make up a level before the speaker reports one', () => {
    const view = startLevelView({
      current: undefined,
      fixed: false,
      limit: 30,
      pending: undefined,
    });

    expect(view).toEqual({ kind: 'unknown', limit: 30 });
    expect(startLevelCaption(view)).toEqual({
      key: 'start_level_unknown',
      params: { limit: 30 },
    });
    expect(startLevelCaption({ kind: 'unknown', limit: undefined })).toBeNull();
  });

  it('should show a fixed output as fixed, whatever its level', () => {
    const view = startLevelView({ current: 100, fixed: true, limit: 30, pending: 20 });

    expect(view).toEqual({ kind: 'fixed' });
    expect(startLevelCaption(view)?.key).toBe('volume_fixed_hint');
  });

  it('should start where the room is when the limit is off', () => {
    const view = startLevelView({
      current: 90,
      fixed: false,
      limit: undefined,
      pending: undefined,
    });

    expect(view).toEqual({ kind: 'known', now: 90, start: 90 });
    expect(startLevelCaption(view)).toBeNull();
  });
});

describe('readVolume', () => {
  it('should have no volume for a speaker that has not reported one', () => {
    expect(readVolume({}, KITCHEN)).toBeUndefined();
    expect(readVolume({ [KITCHEN]: 0 }, KITCHEN)).toBe(0);
  });
});

describe('startCeilingChoices', () => {
  it('should offer steps of 5 and keep a stored limit that is not one of them', () => {
    expect(startCeilingChoices(30)).toHaveLength(20);
    expect(startCeilingChoices(33)).toContain(33);
    expect(startCeilingChoices(33).indexOf(33)).toBe(6);
  });
});
