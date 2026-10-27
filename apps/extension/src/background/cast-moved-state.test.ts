import { beforeEach, describe, expect, it } from 'bun:test';
import {
  applyCastMoved,
  castMovedBroadcast,
  clearAllCastMoved,
  clearCastMoved,
  getCastMoved,
} from './cast-moved-state';

describe('cast-moved state', () => {
  beforeEach(() => {
    clearAllCastMoved();
  });

  it('should keep the latest move per stream and broadcast the snapshot', () => {
    applyCastMoved('s1', 1_000);
    applyCastMoved('s2', 2_000);
    applyCastMoved('s1', 3_000);

    expect(getCastMoved()).toEqual({ s1: { receivedAt: 3_000 }, s2: { receivedAt: 2_000 } });
    expect(castMovedBroadcast()).toEqual({
      type: 'CAST_MOVED_CHANGED',
      streams: { s1: { receivedAt: 3_000 }, s2: { receivedAt: 2_000 } },
    });
  });

  it('should forget a stream when its cast ends, and every stream when the connection drops', () => {
    applyCastMoved('s1', 1_000);
    applyCastMoved('s2', 2_000);

    expect(clearCastMoved('s1')).toBe(true);
    expect(clearCastMoved('s1')).toBe(false);
    expect(getCastMoved()).toEqual({ s2: { receivedAt: 2_000 } });

    expect(clearAllCastMoved()).toBe(true);
    expect(clearAllCastMoved()).toBe(false);
    expect(getCastMoved()).toEqual({});
  });
});
