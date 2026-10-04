import { describe, expect, it } from 'bun:test';

import {
  DEAD_MAN_MS,
  DeadMan,
  freezeVerdict,
  isLive,
  liveTooClose,
  nextStarve,
  shiftHole,
  starved,
  trackLiveEdge,
  type FreezeSample,
} from './guards';

describe('live edge', () => {
  it('should need the lead plus 0.6 s of content beyond the playhead', () => {
    expect(liveTooClose(1.4, 0.9)).toBe(true);
    expect(liveTooClose(1.5, 0.9)).toBe(false);
    expect(liveTooClose(10, 0.9)).toBe(false);
  });

  it('should call a stream live by duration or by a moving seekable end', () => {
    expect(isLive(Infinity, 100, false)).toBe(true);
    expect(isLive(100, Infinity, false)).toBe(true);
    expect(isLive(100, 2e5, false)).toBe(true);
    expect(isLive(100, 100, true)).toBe(true);
    expect(isLive(100, 100, false)).toBe(false);
  });

  it('should see the seekable end move', () => {
    let st = trackLiveEdge(null, 100, 0);
    expect(st.moving).toBe(false);
    st = trackLiveEdge(st, 100.3, 1000);
    expect(st.moving).toBe(false);
    st = trackLiveEdge(st, 101, 2000);
    expect(st.moving).toBe(true);
  });

  it('should not call a fixed seekable end moving', () => {
    let st = trackLiveEdge(null, 100, 0);
    for (let t = 1000; t < 20000; t += 1000) st = trackLiveEdge(st, 100, t);
    expect(st.moving).toBe(false);
  });

  it('should count three starving checks in a row', () => {
    let n = 0;
    n = nextStarve(n, 0.1);
    n = nextStarve(n, 0.2);
    expect(starved(n)).toBe(false);
    n = nextStarve(n, 0.1);
    expect(starved(n)).toBe(true);
    expect(nextStarve(n, 0.3)).toBe(0);
  });
});

describe('freezeVerdict', () => {
  const sample = (over: Partial<FreezeSample>): FreezeSample => ({
    paused: false,
    seeking: false,
    ended: false,
    readyState: 4,
    currentTime: 10,
    now: 0,
    hasData: true,
    holeByShift: false,
    ...over,
  });

  it('should turn the lead off after 2.5 s stuck with data at the playhead', () => {
    let v = freezeVerdict(null, sample({ now: 0 }));
    v = freezeVerdict(v.state, sample({ now: 2000 }));
    expect(v.freeze).toBe(false);
    v = freezeVerdict(v.state, sample({ now: 2600 }));
    expect(v.freeze).toBe(true);
  });

  it('should turn the lead off for a hole the shift explains', () => {
    let v = freezeVerdict(null, sample({ hasData: false, holeByShift: true }));
    v = freezeVerdict(v.state, sample({ now: 3000, hasData: false, holeByShift: true }));
    expect(v.freeze).toBe(true);
  });

  it('should leave a network stall alone', () => {
    let v = freezeVerdict(null, sample({ hasData: false }));
    v = freezeVerdict(v.state, sample({ now: 5000, hasData: false }));
    expect(v.freeze).toBe(false);
  });

  it('should restart the clock when the playhead moves', () => {
    let v = freezeVerdict(null, sample({ now: 0 }));
    v = freezeVerdict(v.state, sample({ now: 2000, currentTime: 11 }));
    v = freezeVerdict(v.state, sample({ now: 4000, currentTime: 11 }));
    expect(v.freeze).toBe(false);
  });

  it('should never judge paused, seeking, ended or empty elements', () => {
    for (const over of [{ paused: true }, { seeking: true }, { ended: true }, { readyState: 0 }]) {
      let v = freezeVerdict(null, sample(over));
      expect(v.state).toBeNull();
      v = freezeVerdict({ ct: 10, since: 0 }, sample({ ...over, now: 9000 }));
      expect(v.freeze).toBe(false);
    }
  });
});

describe('shiftHole', () => {
  it('should not call audio that covers the playhead a hole', () => {
    expect(shiftHole([[0, 20]], 10, 0.9)).toBe(false);
  });

  it('should call a gap with audio resuming just after the playhead a hole', () => {
    expect(
      shiftHole(
        [
          [0, 9.9],
          [10.5, 20],
        ],
        10,
        0.9,
      ),
    ).toBe(true);
  });

  it('should not call shifted audio that simply ran out a hole (a network stall)', () => {
    expect(shiftHole([[0, 9.1]], 10, 0.9)).toBe(false);
  });

  it('should not call audio resuming far beyond the shift a hole', () => {
    expect(
      shiftHole(
        [
          [0, 9.9],
          [15, 20],
        ],
        10,
        0.9,
      ),
    ).toBe(false);
  });
});

describe('DeadMan', () => {
  it('should trip after 10 s without a command while the timers run on time', () => {
    const d = new DeadMan();
    d.heard(0);
    let tripped = false;
    for (let t = 250; t <= DEAD_MAN_MS; t += 250) tripped = d.check(t);
    expect(tripped).toBe(false);
    expect(d.check(DEAD_MAN_MS + 250)).toBe(true);
  });

  it('should reset on every command', () => {
    const d = new DeadMan();
    d.heard(0);
    for (let t = 250; t <= 60000; t += 250) {
      if (t % 2000 === 0) d.heard(t);
      expect(d.check(t)).toBe(false);
    }
  });

  it('should not trip on a throttled page whose timers run once a minute', () => {
    const d = new DeadMan();
    d.heard(0);
    for (let t = 60000; t <= 600000; t += 60000) {
      expect(d.check(t)).toBe(false);
      d.heard(t + 5); // the relay's re-send, also throttled, lands just after
    }
  });
});
