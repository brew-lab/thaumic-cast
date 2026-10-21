import { describe, expect, it } from 'bun:test';

import { isContextValid, startMediaBridge, type BridgePage, type BridgeRuntime } from './bridge';
import { CONTROL_EVENT, METADATA_EVENT } from './constants';

type Listener = Parameters<BridgeRuntime['onMessage']['addListener']>[0];

/** A chrome.runtime that can be invalidated the way an extension reload does it. */
function fakeRuntime() {
  const sent: unknown[] = [];
  const listeners = new Set<Listener>();
  const state = { valid: true };
  const runtime: BridgeRuntime = {
    get id() {
      return state.valid ? 'ext-id' : undefined;
    },
    sendMessage(message: unknown) {
      if (!state.valid) throw new Error('Extension context invalidated.');
      sent.push(message);
      return Promise.resolve(undefined);
    },
    onMessage: {
      addListener: (l) => void listeners.add(l),
      removeListener: (l) => {
        if (!state.valid) throw new Error('Extension context invalidated.');
        listeners.delete(l);
      },
    },
  };
  return { runtime, sent, listeners, state };
}

/** A page whose document has finished loading, with an optional og:image. */
function fakePage(ogImage?: string): BridgePage & { win: EventTarget } {
  const win = new EventTarget();
  const doc = {
    readyState: 'complete' as DocumentReadyState,
    querySelector: () => (ogImage ? { content: ogImage } : null),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as BridgePage['doc'];
  return { win, doc };
}

const metadata = (title: string) => new CustomEvent(METADATA_EVENT, { detail: { title } });

describe('startMediaBridge', () => {
  it('should forward the og:image and metadata to the extension', () => {
    const { runtime, sent } = fakeRuntime();
    const page = fakePage('https://example.com/art.png');
    startMediaBridge(runtime, page);
    page.win.dispatchEvent(metadata('One'));
    expect(sent).toEqual([
      { type: 'TAB_OG_IMAGE', payload: { ogImage: 'https://example.com/art.png' } },
      { type: 'TAB_METADATA_UPDATE', payload: { title: 'One' } },
    ]);
  });

  it('should pass control commands from the extension to the page', () => {
    const { runtime, listeners } = fakeRuntime();
    const page = fakePage();
    const actions: unknown[] = [];
    page.win.addEventListener(CONTROL_EVENT, (e) => actions.push((e as CustomEvent).detail));
    startMediaBridge(runtime, page);
    let response: unknown;
    for (const l of listeners)
      l({ type: 'CONTROL_MEDIA', action: 'pause' }, {}, (r) => (response = r));
    expect(actions).toEqual([{ action: 'pause' }]);
    expect(response).toEqual({ success: true });
  });

  it('should not throw when the extension context is invalidated', () => {
    const { runtime, state } = fakeRuntime();
    const page = fakePage();
    startMediaBridge(runtime, page);
    state.valid = false;
    expect(() => page.win.dispatchEvent(metadata('Two'))).not.toThrow();
  });

  it('should stop listening once the extension context is invalidated', () => {
    const { runtime, sent, state } = fakeRuntime();
    const page = fakePage();
    startMediaBridge(runtime, page);
    state.valid = false;
    page.win.dispatchEvent(metadata('Two'));
    // Back to valid only to prove the listener is gone, not merely failing.
    state.valid = true;
    page.win.dispatchEvent(metadata('Three'));
    expect(sent).toEqual([]);
  });

  it('should stop quietly when the context goes between the check and the send', () => {
    const { runtime, sent, state } = fakeRuntime();
    const page = fakePage();
    let reads = 0;
    // Valid for the bridge's check, invalid by the time sendMessage runs.
    Object.defineProperty(runtime, 'id', {
      get: () => (reads++ === 0 ? 'ext-id' : undefined),
    });
    const send = runtime.sendMessage;
    runtime.sendMessage = (m) => {
      state.valid = false;
      return send(m);
    };
    startMediaBridge(runtime, page);
    expect(() => page.win.dispatchEvent(metadata('Two'))).not.toThrow();
    state.valid = true;
    page.win.dispatchEvent(metadata('Three'));
    expect(sent).toEqual([]);
  });

  it('should remove its listeners when stopped', () => {
    const { runtime, sent, listeners } = fakeRuntime();
    const page = fakePage();
    const stop = startMediaBridge(runtime, page);
    stop();
    stop();
    page.win.dispatchEvent(metadata('Four'));
    expect(sent).toEqual([]);
    expect(listeners.size).toBe(0);
  });
});

describe('isContextValid', () => {
  it('should be false once the runtime has lost its id', () => {
    const { runtime, state } = fakeRuntime();
    expect(isContextValid(runtime)).toBe(true);
    state.valid = false;
    expect(isContextValid(runtime)).toBe(false);
  });
});
