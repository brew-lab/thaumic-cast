import { describe, expect, it } from 'bun:test';
import { ANNOUNCE_GAP_MS, ANNOUNCE_HOLD_MS } from '../tokens';
import { createAnnouncer, type AnnouncerClock, type LiveRegion } from './createAnnouncer';

/** A clock the test steps by hand: frames and timers run only when flushed. */
function manualClock(): AnnouncerClock & { frame(): void; elapse(ms: number): void } {
  let frames: (() => void)[] = [];
  let timers: { at: number; cb: () => void }[] = [];
  let now = 0;
  return {
    nextFrame: (cb) => {
      frames.push(cb);
    },
    after: (ms, cb) => {
      timers.push({ at: now + ms, cb });
    },
    frame() {
      const run = frames;
      frames = [];
      run.forEach((cb) => cb());
    },
    elapse(ms) {
      now += ms;
      const due = timers.filter((t) => t.at <= now);
      timers = timers.filter((t) => t.at > now);
      due.forEach((t) => t.cb());
    },
  };
}

const setup = () => {
  const polite: LiveRegion = { textContent: '' };
  const assertive: LiveRegion = { textContent: '' };
  const clock = manualClock();
  const announcer = createAnnouncer({ polite, assertive }, clock);
  return { polite, assertive, clock, announcer };
};

describe('createAnnouncer', () => {
  it('should say nothing before the surface has opened', () => {
    const { polite, clock, announcer } = setup();
    announcer.say('Connected');
    clock.frame();
    expect(polite.textContent).toBe('');
  });

  it('should empty the region, then write the message on the next frame', () => {
    const { polite, clock, announcer } = setup();
    announcer.open();
    polite.textContent = 'old';
    announcer.say('Copied');
    expect(polite.textContent).toBe('');
    clock.frame();
    expect(polite.textContent).toBe('Copied');
  });

  it('should empty the region ANNOUNCE_HOLD_MS after the last message', () => {
    const { polite, clock, announcer } = setup();
    announcer.open();
    announcer.say('Office is joining…');
    clock.frame();
    clock.elapse(ANNOUNCE_HOLD_MS - 1000);
    announcer.say('Office joined the cast.');
    clock.frame();
    clock.elapse(1000);
    expect(polite.textContent).toBe('Office joined the cast.');
    clock.elapse(ANNOUNCE_HOLD_MS);
    expect(polite.textContent).toBe('');
  });

  it('should space queued messages ANNOUNCE_GAP_MS apart', () => {
    const { polite, clock, announcer } = setup();
    announcer.open();
    announcer.say('First');
    announcer.say('Second');
    clock.frame();
    expect(polite.textContent).toBe('First');
    clock.elapse(ANNOUNCE_GAP_MS - 1);
    clock.frame();
    expect(polite.textContent).toBe('First');
    clock.elapse(1);
    clock.frame();
    expect(polite.textContent).toBe('Second');
  });

  it('should never repeat a message whose key was said', () => {
    const { polite, clock, announcer } = setup();
    announcer.open();
    announcer.say('Kitchen may cut out', { key: 'notice-1' });
    clock.frame();
    clock.elapse(ANNOUNCE_GAP_MS);
    polite.textContent = '';
    announcer.say('Kitchen may cut out', { key: 'notice-1' });
    clock.frame();
    expect(polite.textContent).toBe('');
  });

  it('should use the assertive region only when urgent', () => {
    const { polite, assertive, clock, announcer } = setup();
    announcer.open();
    announcer.say('Kitchen did not join.', { urgent: true });
    clock.frame();
    expect(assertive.textContent).toBe('Kitchen did not join.');
    expect(polite.textContent).toBe('');
  });

  it('should drop queued messages when the surface closes', () => {
    const { polite, clock, announcer } = setup();
    announcer.open();
    announcer.say('First');
    announcer.say('Second');
    announcer.close();
    clock.frame();
    clock.elapse(ANNOUNCE_GAP_MS);
    clock.frame();
    expect(polite.textContent).toBe('');
  });
});
