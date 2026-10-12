import { describe, expect, it } from 'bun:test';

import { StartVolumeSchema, plannedStartLevel } from './stream.js';

describe('plannedStartLevel', () => {
  it('should turn a room above the limit down to it', () => {
    expect(plannedStartLevel(72, 30)).toBe(30);
  });

  it('should never turn a room up', () => {
    expect(plannedStartLevel(10, 30)).toBe(10);
    expect(plannedStartLevel(30, 30)).toBe(30);
  });

  it('should not know the start before the room reports its level', () => {
    expect(plannedStartLevel(undefined, 30)).toBeUndefined();
  });

  it('should use a hand-set level, even above the limit', () => {
    expect(plannedStartLevel(20, 30, 45)).toBe(45);
    expect(plannedStartLevel(undefined, 30, 45)).toBe(45);
  });

  it('should start where the room is when the limit is off', () => {
    expect(plannedStartLevel(90, undefined)).toBe(90);
  });
});

describe('StartVolumeSchema', () => {
  it('should accept an empty start volume, which changes nothing', () => {
    expect(StartVolumeSchema.parse({})).toEqual({});
  });

  it('should only accept whole levels from 0 to 100', () => {
    expect(StartVolumeSchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(StartVolumeSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(StartVolumeSchema.safeParse({ rooms: { RINCON_A: -1 } }).success).toBe(false);
  });
});
