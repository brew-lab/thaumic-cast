import { beforeEach, describe, expect, it } from 'bun:test';

import {
  grantedOrigins,
  registeredScripts,
  resetChromeStub,
  scriptingCalls,
} from '../../test-support/chrome-stub';
import { HOOK_SCRIPT_ID, RELAY_SCRIPT_ID, syncVideoSyncScripts } from './registration';

const COMMON = {
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_start',
  allFrames: true,
  matchOriginAsFallback: true,
  persistAcrossSessions: true,
};

const on = (): boolean => true;
const off = (): boolean => false;

function grantAllSites(): void {
  grantedOrigins.add('http://*/*');
  grantedOrigins.add('https://*/*');
}

describe('syncVideoSyncScripts', () => {
  beforeEach(() => resetChromeStub());

  it('should register the hook in MAIN and the relay in ISOLATED with the exact options', async () => {
    grantAllSites();
    expect(await syncVideoSyncScripts(on)).toBe(true);
    expect(registeredScripts.get(HOOK_SCRIPT_ID)).toEqual({
      id: HOOK_SCRIPT_ID,
      js: ['video-sync-hook.js'],
      world: 'MAIN',
      ...COMMON,
    } as chrome.scripting.RegisteredContentScript);
    expect(registeredScripts.get(RELAY_SCRIPT_ID)).toEqual({
      id: RELAY_SCRIPT_ID,
      js: ['video-sync-relay.js'],
      world: 'ISOLATED',
      ...COMMON,
    } as chrome.scripting.RegisteredContentScript);
  });

  it('should unregister both when turned off', async () => {
    grantAllSites();
    await syncVideoSyncScripts(on);
    expect(await syncVideoSyncScripts(off)).toBe(false);
    expect(registeredScripts.size).toBe(0);
  });

  it('should be idempotent: on twice updates instead of registering again', async () => {
    grantAllSites();
    await syncVideoSyncScripts(on);
    expect(await syncVideoSyncScripts(on)).toBe(true);
    expect(registeredScripts.size).toBe(2);
    expect(scriptingCalls.map((c) => c.op)).toEqual(['register', 'update']);
  });

  it('should do nothing when turned off with nothing registered', async () => {
    await syncVideoSyncScripts(off);
    expect(scriptingCalls).toEqual([]);
  });

  it('should register only the missing script after a partial registration', async () => {
    grantAllSites();
    await syncVideoSyncScripts(on);
    registeredScripts.delete(RELAY_SCRIPT_ID);
    scriptingCalls.length = 0;
    await syncVideoSyncScripts(on);
    expect(scriptingCalls).toEqual([
      { op: 'update', ids: [HOOK_SCRIPT_ID] },
      { op: 'register', ids: [RELAY_SCRIPT_ID] },
    ]);
  });

  it('should not register without the all-sites permission, and remove stale scripts', async () => {
    expect(await syncVideoSyncScripts(on)).toBe(false);
    expect(registeredScripts.size).toBe(0);
    grantAllSites();
    await syncVideoSyncScripts(on);
    grantedOrigins.clear();
    await syncVideoSyncScripts(on);
    expect(registeredScripts.size).toBe(0);
  });

  it('should run overlapping calls in turn, each reading the setting afresh', async () => {
    grantAllSites();
    let setting = false;
    let release: () => void = () => {};
    let started: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const reading = new Promise<void>((r) => (started = r));
    // The first call read the setting before it was saved, and is slow.
    const first = syncVideoSyncScripts(async () => {
      const v = setting;
      started();
      await gate;
      return v;
    });
    await reading;
    setting = true;
    const second = syncVideoSyncScripts(() => setting);
    // Give the second call every chance to finish before the first resumes.
    await new Promise((r) => setTimeout(r, 10));
    release();
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(registeredScripts.size).toBe(2);
  });
});
