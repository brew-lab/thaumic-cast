import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { resetChromeStub, runtimeMessages } from '../test-support/chrome-stub';
import { THEME_POLL_MS, watchToolbarTheme } from './toolbar-theme';

/** A media query whose `matches` the test sets, firing `change` only when asked. */
const query = {
  matches: false,
  listeners: new Set<() => void>(),
  addEventListener(_: string, listener: () => void): void {
    this.listeners.add(listener);
  },
  removeEventListener(_: string, listener: () => void): void {
    this.listeners.delete(listener);
  },
};
const realMatchMedia = globalThis.matchMedia;
const themes = (): boolean[] =>
  runtimeMessages.map((m) => (m as { payload: { dark: boolean } }).payload.dark);

beforeEach(() => {
  resetChromeStub();
  query.matches = false;
  query.listeners.clear();
  globalThis.matchMedia = (() => query) as unknown as typeof globalThis.matchMedia;
});

afterEach(() => {
  globalThis.matchMedia = realMatchMedia;
});

describe('watchToolbarTheme', () => {
  it('should report the theme at once, and a change event once', () => {
    const stop = watchToolbarTheme();
    query.matches = true;
    for (const listener of query.listeners) listener();
    for (const listener of query.listeners) listener();
    stop();
    expect(themes()).toEqual([false, true]);
  });

  it('should report a change that comes with no event, as in the offscreen document', async () => {
    const stop = watchToolbarTheme();
    query.matches = true;
    await Bun.sleep(THEME_POLL_MS + 100);
    stop();
    expect(themes()).toEqual([false, true]);
  });
});
