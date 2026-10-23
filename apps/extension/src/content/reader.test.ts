import { describe, expect, it } from 'bun:test';

import { CONTROL_EVENT, METADATA_EVENT } from './constants';
import { startMediaReader, type ReaderPage } from './reader';

/**
 * A media session shaped like the browser's: metadata and playbackState are accessors on the
 * prototype, and the values they hold are what the browser's media session sees.
 */
class FakeSession {
  /** What the browser's media session holds. */
  readonly browser = {
    metadata: null as MediaMetadata | null,
    playbackState: 'none' as MediaSessionPlaybackState,
    handlers: new Map<string, MediaSessionActionHandler | null>(),
  };

  get metadata(): MediaMetadata | null {
    return this.browser.metadata;
  }

  set metadata(value: MediaMetadata | null) {
    this.browser.metadata = value;
  }

  get playbackState(): MediaSessionPlaybackState {
    return this.browser.playbackState;
  }

  set playbackState(value: MediaSessionPlaybackState) {
    if (!['none', 'paused', 'playing'].includes(value)) throw new TypeError('bad state');
    this.browser.playbackState = value;
  }

  setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null): void {
    this.browser.handlers.set(action, handler);
  }
}

/**
 * Reads a property through the browser's own getter, past the reader's accessor.
 * @param session - The session
 * @param key - The property
 * @returns What the browser's media session holds
 */
function nativeValue(session: MediaSession, key: 'metadata' | 'playbackState'): unknown {
  return Object.getOwnPropertyDescriptor(FakeSession.prototype, key)!.get!.call(session);
}

/** A fake browser media session. */
function fakeSession(): MediaSession {
  return new FakeSession() as unknown as MediaSession;
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

  it('should pass metadata and playbackState on to the browser and still emit them', async () => {
    const page = fakePage();
    startMediaReader(page);
    const states: unknown[] = [];
    page.win.addEventListener(METADATA_EVENT, (e) => void states.push((e as CustomEvent).detail));
    const metadata = { title: 'Song', artist: 'Band', album: '', artwork: [] };

    page.session.metadata = metadata as unknown as MediaMetadata;
    page.session.playbackState = 'playing';

    expect(nativeValue(page.session, 'metadata')).toBe(metadata);
    expect(nativeValue(page.session, 'playbackState')).toBe('playing');
    expect(page.session.metadata).toBe(metadata as unknown as MediaMetadata);
    expect(page.session.playbackState).toBe('playing');
    await new Promise((r) => setTimeout(r, 200));
    expect(states).toEqual([
      expect.objectContaining({ title: 'Song', artist: 'Band', playbackState: 'playing' }),
    ]);
  });

  it('should let a value the browser refuses throw to the page, unchanged', () => {
    const page = fakePage();
    startMediaReader(page);

    expect(() => {
      page.session.playbackState = 'stopped' as MediaSessionPlaybackState;
    }).toThrow(TypeError);
    expect(nativeValue(page.session, 'playbackState')).toBe('none');
  });

  it('should pass values on to the browser when a second reader stood down', () => {
    const page = fakePage();
    startMediaReader(page);
    startMediaReader(page);

    page.session.playbackState = 'paused';

    expect(nativeValue(page.session, 'playbackState')).toBe('paused');
  });
});
