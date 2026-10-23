import { describe, expect, it } from 'bun:test';

import { CONTROL_EVENT, METADATA_EVENT } from './constants';
import { startMediaReader, type ReaderPage } from './reader';

/** A media session that records what reaches the browser's own setActionHandler. */
function fakeSession(): MediaSession {
  const native = new Map<string, MediaSessionActionHandler | null>();
  return {
    metadata: null,
    playbackState: 'none',
    setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
      native.set(action, handler);
    },
  } as unknown as MediaSession;
}

/** A page: its window and media session. */
function fakePage(): ReaderPage & { win: EventTarget; session: MediaSession } {
  return { win: new EventTarget(), session: fakeSession() };
}

/**
 * Sends a control command the way the bridge does.
 * @param win - The page's window
 * @param action - The action
 */
function control(win: EventTarget, action: string): void {
  win.dispatchEvent(new CustomEvent(CONTROL_EVENT, { detail: { action } }));
}

describe('startMediaReader', () => {
  it('should call the page handler once for one control command', () => {
    const page = fakePage();
    expect(startMediaReader(page)).toBe(true);
    const calls: string[] = [];
    page.session.setActionHandler('nexttrack', (d) => void calls.push(d.action));

    control(page.win, 'nexttrack');

    expect(calls).toEqual(['nexttrack']);
  });

  it('should stand down when a reader already serves the page', () => {
    // Two installed copies of the extension both inject a reader into the page.
    const page = fakePage();
    expect(startMediaReader(page)).toBe(true);
    expect(startMediaReader(page)).toBe(false);
    const calls: string[] = [];
    page.session.setActionHandler('nexttrack', (d) => void calls.push(d.action));
    page.session.setActionHandler('previoustrack', (d) => void calls.push(d.action));

    // Each copy's bridge hears only its own extension, but both dispatch on the same window.
    control(page.win, 'nexttrack');
    control(page.win, 'previoustrack');

    expect(calls).toEqual(['nexttrack', 'previoustrack']);
  });

  it('should still pass the handler on to the browser', () => {
    const page = fakePage();
    const seen: string[] = [];
    const native = page.session.setActionHandler.bind(page.session);
    page.session.setActionHandler = (action, handler) => {
      seen.push(action);
      native(action, handler);
    };
    startMediaReader(page);

    page.session.setActionHandler('nexttrack', () => undefined);

    expect(seen).toEqual(['nexttrack']);
  });

  it('should report the supported actions once the page registers them', async () => {
    const page = fakePage();
    startMediaReader(page);
    const states: unknown[] = [];
    page.win.addEventListener(METADATA_EVENT, (e) => void states.push((e as CustomEvent).detail));

    page.session.setActionHandler('nexttrack', () => undefined);
    await new Promise((r) => setTimeout(r, 200));

    expect(states).toEqual([
      expect.objectContaining({ supportedActions: ['nexttrack'], playbackState: 'none' }),
    ]);
  });
});
