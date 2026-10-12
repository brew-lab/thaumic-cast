import { beforeEach, describe, expect, it } from 'bun:test';

import { readVolume } from '../popup/hooks/useSonosState';
import { resetChromeStub, runtimeMessages } from '../test-support/chrome-stub';
import { StartCastMessageSchema } from './message-schemas';
import { buildStartVolume, pendingStartsFor, startLimitOf, withPendingStart } from './start-level';

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

  it('should send hand-set levels for the cast’s rooms only', () => {
    expect(buildStartVolume(OFF, [KITCHEN], { [KITCHEN]: 45, [STUDY]: 12 })).toEqual({
      rooms: { [KITCHEN]: 45 },
    });
    expect(buildStartVolume(ON, [KITCHEN, STUDY], { [STUDY]: 12 })).toEqual({
      limit: 30,
      rooms: { [STUDY]: 12 },
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

  it('should carry the hand-set level of a chosen room in START_CAST only', () => {
    const pending = { [KITCHEN]: 45, [STUDY]: 12 };
    const message = {
      type: 'START_CAST',
      payload: { roomIds: [KITCHEN], startLevels: pendingStartsFor([KITCHEN], pending) },
    };

    const parsed = StartCastMessageSchema.parse(message);

    expect(parsed.payload.startLevels).toEqual({ [KITCHEN]: 45 });
  });
});

describe('readVolume', () => {
  it('should have no volume for a speaker that has not reported one', () => {
    expect(readVolume({}, KITCHEN)).toBeUndefined();
    expect(readVolume({ [KITCHEN]: 0 }, KITCHEN)).toBe(0);
  });
});
