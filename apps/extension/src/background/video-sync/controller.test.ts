import { describe, expect, it } from 'bun:test';
import type { PlayoutLatency } from '@thaumic-cast/protocol';

import {
  CAPTURE_DELAY_FIRST_WAIT_MS,
  CAPTURE_DELAY_WINDOW_MS,
  COMPANION_OLD_AFTER_EVENTS,
  LEAD_STEP_MIN_INTERVAL_MS,
  LeadController,
  leadFor,
  median,
  pickFrame,
  type CastFacts,
} from './controller';
import type { FrameHookStatus } from './lead-api';

const PCM_TAB: CastFacts = { captureMode: 'tab', codec: 'pcm' };
const KITCHEN = { ip: '192.168.1.20', name: 'Kitchen', trimMs: 0 };

/**
 * A playout estimate with the fields the controller reads.
 * @param companionMs - The estimate
 * @param fields - Anything else to set
 * @returns The estimate
 */
function playout(companionMs: number, fields: Partial<PlayoutLatency> = {}): PlayoutLatency {
  return {
    companionMs,
    uncertaintyMs: 20,
    source: 'reserve',
    epoch: 1,
    queueMs: 60,
    reserveMs: companionMs - 60,
    headStartMs: 500,
    calibMs: 20,
    ...fields,
  };
}

/**
 * A frame's hook status.
 * @param fields - The fields to set
 * @returns The status
 */
function frame(fields: Partial<FrameHookStatus>): FrameHookStatus {
  return {
    frameId: 0,
    state: 'ready',
    appliedLeadMs: 0,
    playing: true,
    receivedAt: 1,
    ...fields,
  };
}

/** A send that reached the page's relay. */
const REACHED = { reached: true, access: true, scriptable: true };

/**
 * Gives a controller a capture-delay sample from long ago: it has heard one,
 * so the first lead need not wait, but the sample counts for nothing.
 * @param c - The controller
 * @returns The controller
 */
function heardCaptureDelay(c: LeadController): LeadController {
  c.onCaptureDelay(0, -CAPTURE_DELAY_WINDOW_MS - 1);
  return c;
}

/**
 * A controller that has been told the page has the hook.
 * @param facts - The cast's facts
 * @returns The controller
 */
function reachedController(facts: CastFacts = PCM_TAB): LeadController {
  const c = heardCaptureDelay(new LeadController(facts, KITCHEN, true));
  c.onReach(REACHED);
  return c;
}

describe('leadFor', () => {
  it('should add the companion, the capture delay and the trim, less 40 ms', () => {
    expect(leadFor(700, 30, 0)).toBe(690);
    expect(leadFor(700, 30, 50)).toBe(740);
    expect(leadFor(700, 30, -100)).toBe(590);
  });

  it('should clamp to 0..6000 and round', () => {
    expect(leadFor(10, 0, -500)).toBe(0);
    expect(leadFor(7000, 0, 0)).toBe(6000);
    expect(leadFor(700.4, 0.4, 0)).toBe(661);
  });
});

describe('median', () => {
  it('should take the middle, or the mean of the middle two', () => {
    expect(median([])).toBe(0);
    expect(median([5])).toBe(5);
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 20, 30])).toBe(25);
  });
});

describe('LeadController: the lead', () => {
  it('should send the first estimate at once, with the capture delay median', () => {
    const c = reachedController();
    c.onCaptureDelay(20, 0);
    c.onCaptureDelay(40, 1000);
    c.onCaptureDelay(30, 2000);
    c.onPlayout(playout(700));
    expect(c.next(2000)).toEqual({ enabled: true, leadMs: 690 });
    expect(c.next(2100)).toBeNull();
  });

  it('should count only the last ten seconds of capture delay', () => {
    const c = reachedController();
    c.onCaptureDelay(500, 0);
    c.onCaptureDelay(20, 11_000);
    expect(c.captureDelay(11_000)).toBe(20);
  });

  it('should hold small moves and send a move above 40 ms', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    expect(c.next(0)?.leadMs).toBe(660);
    c.onPlayout(playout(735));
    expect(c.next(10_000)).toBeNull();
    c.onPlayout(playout(745));
    expect(c.next(10_000)).toEqual({ enabled: true, leadMs: 705 });
  });

  it('should send routine moves at most once every five seconds', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    c.next(0);
    c.onPlayout(playout(800));
    expect(c.next(LEAD_STEP_MIN_INTERVAL_MS - 1)).toBeNull();
    expect(c.next(LEAD_STEP_MIN_INTERVAL_MS)?.leadMs).toBe(760);
    c.onPlayout(playout(900));
    expect(c.next(LEAD_STEP_MIN_INTERVAL_MS + 1000)).toBeNull();
    expect(c.next(2 * LEAD_STEP_MIN_INTERVAL_MS)?.leadMs).toBe(860);
  });

  it('should send at once when the epoch steps, whatever the size of the move', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    c.next(0);
    c.onPlayout(playout(710, { epoch: 2 }));
    expect(c.next(100)).toEqual({ enabled: true, leadMs: 670 });
  });

  it('should apply a trim at once', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    c.next(0);
    c.setTrim(20);
    expect(c.next(100)).toEqual({ enabled: true, leadMs: 680 });
    c.setTrim(20);
    expect(c.next(200)).toBeNull();
  });

  it('should send lead off when switched off, and the lead at once when switched back on', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    c.next(0);
    c.setEnabled(false);
    expect(c.next(100)).toEqual({ enabled: false, leadMs: 0 });
    expect(c.next(200)).toBeNull();
    expect(c.keepAlive()).toBeNull();
    c.setEnabled(true);
    expect(c.next(300)).toEqual({ enabled: true, leadMs: 660 });
  });

  it('should keep the lead when the measurement goes stale', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    c.next(0);
    c.onStale();
    expect(c.next(20_000)).toBeNull();
    expect(c.keepAlive()).toEqual({ enabled: true, leadMs: 660 });
    expect(c.status().state).toBe('locking');
    expect(c.status().leadMs).toBe(660);
  });

  it('should still apply a trim while stale, from the last estimate', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    c.next(0);
    c.onStale();
    c.setTrim(-60);
    expect(c.next(100)?.leadMs).toBe(600);
  });

  it('should probe with a lead of 0 before any estimate', () => {
    const c = new LeadController(PCM_TAB, KITCHEN, true);
    expect(c.keepAlive()).toEqual({ enabled: true, leadMs: 0 });
    expect(c.next(0)).toBeNull();
  });

  it('should add the rearm flag to the next send', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    c.next(0);
    c.requestRearm();
    expect(c.next(100)).toEqual({ enabled: true, leadMs: 660, rearm: true });
    expect(c.next(200)).toBeNull();
  });

  it('should keep a restored lead when the estimate agrees within 40 ms', () => {
    const c = heardCaptureDelay(
      new LeadController(PCM_TAB, KITCHEN, true, { leadMs: 660, epoch: 3 }),
    );
    expect(c.keepAlive()).toEqual({ enabled: true, leadMs: 660 });
    c.onPlayout(playout(720, { epoch: 3 }));
    expect(c.next(0)).toBeNull();
    c.onPlayout(playout(720, { epoch: 4 }));
    expect(c.next(0)?.leadMs).toBe(680);
  });

  it('should await a fresh estimate for a new speaker and apply it at once', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    c.next(0);
    c.follow({ ip: '192.168.1.21', name: 'Den', trimMs: 30 });
    expect(c.target(100)).toBeNull();
    expect(c.status().speakerName).toBe('Den');
    c.onPlayout(playout(700));
    expect(c.next(200)?.leadMs).toBe(690);
  });

  it('should remember the lead in force and its epoch', () => {
    const c = reachedController();
    expect(c.snapshot()).toBeNull();
    c.onPlayout(playout(700, { epoch: 2 }));
    c.next(0);
    expect(c.snapshot()).toEqual({ leadMs: 660, epoch: 2 });
    c.setEnabled(false);
    expect(c.snapshot()).toBeNull();
  });
});

describe('LeadController: gates', () => {
  it('should send nothing for a browser-wide capture', () => {
    const c = reachedController({ captureMode: 'browser', codec: 'pcm' });
    c.onPlayout(playout(700));
    expect(c.next(0)).toBeNull();
    expect(c.keepAlive()).toBeNull();
    expect(c.status()).toMatchObject({ state: 'unavailable', reason: 'browser-capture' });
  });

  it('should send nothing for a cast that is not PCM', () => {
    const c = reachedController({ captureMode: 'tab', codec: 'aac-lc' });
    expect(c.next(0)).toBeNull();
    expect(c.keepAlive()).toBeNull();
    expect(c.status()).toMatchObject({ state: 'unavailable', reason: 'pcm-only' });
  });

  it('should take a companion that never sends an estimate to be too old', () => {
    const c = reachedController();
    for (let i = 1; i < COMPANION_OLD_AFTER_EVENTS; i++) c.onPlayout(undefined);
    expect(c.status().state).toBe('locking');
    c.onPlayout(undefined);
    expect(c.status()).toMatchObject({ state: 'unavailable', reason: 'companion-old' });
    expect(c.keepAlive()).toBeNull();
    c.onPlayout(playout(700));
    expect(c.status().state).not.toBe('unavailable');
  });

  it('should not call a companion old for gaps after it has sent estimates', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    for (let i = 0; i < COMPANION_OLD_AFTER_EVENTS * 2; i++) c.onPlayout(undefined);
    expect(c.status().reason).toBeUndefined();
  });

  it('should ask for a reload when no relay answered, or for access without it', () => {
    const c = new LeadController(PCM_TAB, KITCHEN, true);
    expect(c.status().state).toBe('locking');
    c.onReach({ reached: false, access: true, scriptable: true });
    expect(c.status()).toMatchObject({ state: 'unavailable', reason: 'reload' });
    c.onReach({ reached: false, access: false, scriptable: false });
    expect(c.status()).toMatchObject({ state: 'unavailable', reason: 'no-access' });
    c.onReach(REACHED);
    expect(c.status().state).toBe('locking');
  });

  it('should not advise a reload on a page no script may enter', () => {
    const c = new LeadController(PCM_TAB, KITCHEN, true);
    c.onReach({ reached: false, access: true, scriptable: false });
    expect(c.status()).toMatchObject({ state: 'unavailable', reason: 'not-web-page' });
  });

  it('should be off when switched off, whatever else holds', () => {
    const c = reachedController({ captureMode: 'tab', codec: 'flac' });
    c.setEnabled(false);
    expect(c.status()).toEqual({
      enabled: false,
      state: 'off',
      speakerIp: KITCHEN.ip,
      speakerName: KITCHEN.name,
      trimMs: 0,
    });
  });
});

describe('LeadController: states from the hook', () => {
  it.each(['muxed', 'worker', 'no-mse', 'format'] as const)(
    'should report a page that cannot be synced (%s)',
    (reason) => {
      const c = reachedController();
      c.onFrames([frame({ state: 'unavailable', reason })]);
      expect(c.status()).toMatchObject({ state: 'unavailable', reason });
    },
  );

  it.each(['freeze', 'live-edge'] as const)('should report a lead turned off (%s)', (reason) => {
    const c = reachedController();
    c.onFrames([frame({ state: 'off', reason })]);
    expect(c.status()).toMatchObject({ state: 'turned-off', reason });
  });

  it('should be locking while the hook switches, waits or lacks a fragment start', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    c.next(0);
    for (const f of [
      frame({ state: 'switching', appliedLeadMs: 660 }),
      frame({ state: 'pending', appliedLeadMs: 0 }),
      frame({ state: 'pending', reason: 'no-rap', appliedLeadMs: 0 }),
    ]) {
      c.onFrames([f]);
      expect(c.status().state).toBe('locking');
    }
  });

  it('should go from locking on the prior to in step on the reserve', () => {
    const c = reachedController();
    c.onPlayout(playout(600, { source: 'prior' }));
    c.next(0);
    c.onFrames([frame({ state: 'applied', appliedLeadMs: 560 })]);
    expect(c.status()).toMatchObject({ state: 'locking', source: 'prior', leadMs: 560 });

    c.onPlayout(playout(700, { source: 'reserve', epoch: 2 }));
    expect(c.next(1000)?.leadMs).toBe(660);
    // The hook still reports the old lead until its switch lands.
    expect(c.status().state).toBe('locking');
    c.onFrames([frame({ state: 'applied', appliedLeadMs: 656 })]);
    expect(c.status()).toMatchObject({ state: 'in-step', source: 'reserve', leadMs: 660 });
  });

  it('should not be in step while stale', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    c.next(0);
    c.onFrames([frame({ state: 'applied', appliedLeadMs: 660 })]);
    expect(c.status().state).toBe('in-step');
    c.onStale();
    expect(c.status().state).toBe('locking');
  });

  it('should be in step at a lead of 0, where the hook stays ready', () => {
    const c = reachedController();
    c.setTrim(-500);
    c.onPlayout(playout(300));
    expect(c.next(0)?.leadMs).toBe(0);
    c.onFrames([frame({ state: 'ready', appliedLeadMs: 0 })]);
    expect(c.status()).toMatchObject({ state: 'in-step', leadMs: 0 });
  });

  it('should not count ready as in step while a lead is wanted', () => {
    const c = reachedController();
    c.onPlayout(playout(700));
    c.next(0);
    c.onFrames([frame({ state: 'ready', appliedLeadMs: 0 })]);
    expect(c.status().state).toBe('locking');
  });

  it('should say there is nothing to watch on a page with no media', () => {
    const c = reachedController();
    c.onFrames([frame({ state: 'no-media', playing: false })]);
    expect(c.status().state).toBe('no-video');
    c.onFrames([frame({ state: 'ready', playing: true })]);
    expect(c.status().state).toBe('locking');
  });

  it('should be locking, not idle, before any frame has reported', () => {
    expect(reachedController().status().state).toBe('locking');
  });
});

describe('LeadController: the first capture delay', () => {
  it('should hold the first lead until a capture delay arrives', () => {
    const c = new LeadController(PCM_TAB, KITCHEN, true);
    c.onReach(REACHED);
    c.onPlayout(playout(700));
    expect(c.next(0)).toEqual({ enabled: true, leadMs: 0 });
    expect(c.next(1000)).toBeNull();
    c.onCaptureDelay(80, 1500);
    expect(c.next(1500)).toEqual({ enabled: true, leadMs: 740 });
  });

  it('should send without it once the wait is over', () => {
    const c = new LeadController(PCM_TAB, KITCHEN, true);
    c.onPlayout(playout(700));
    c.next(0);
    expect(c.next(CAPTURE_DELAY_FIRST_WAIT_MS - 1)).toBeNull();
    expect(c.next(CAPTURE_DELAY_FIRST_WAIT_MS)).toEqual({ enabled: true, leadMs: 660 });
  });
});

describe('pickFrame', () => {
  it('should prefer a playing frame with a Media Source element', () => {
    const top = frame({ frameId: 0, state: 'unavailable', reason: 'no-mse', playing: true });
    const embed = frame({ frameId: 5, state: 'applied', playing: true });
    const idle = frame({ frameId: 7, state: 'ready', playing: false, receivedAt: 9 });
    expect(pickFrame([top, idle, embed])?.frameId).toBe(5);
  });

  it('should prefer a playing frame that cannot be synced over a paused one that can', () => {
    const paused = frame({ frameId: 1, state: 'ready', playing: false });
    const muxed = frame({ frameId: 2, state: 'unavailable', reason: 'muxed', playing: true });
    expect(pickFrame([paused, muxed])?.frameId).toBe(2);
  });

  it('should break ties by the latest report', () => {
    const a = frame({ frameId: 1, state: 'applied', receivedAt: 10 });
    const b = frame({ frameId: 2, state: 'applied', receivedAt: 20 });
    expect(pickFrame([a, b])?.frameId).toBe(2);
  });

  it('should ignore frames with no media', () => {
    expect(
      pickFrame([
        frame({ state: 'idle', playing: false }),
        frame({ state: 'no-media', playing: false }),
      ]),
    ).toBeNull();
  });
});
