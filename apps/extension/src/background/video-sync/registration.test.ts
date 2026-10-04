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

function grantAllSites(): void {
  grantedOrigins.add('http://*/*');
  grantedOrigins.add('https://*/*');
}

describe('syncVideoSyncScripts', () => {
  beforeEach(() => resetChromeStub());

  it('should register the hook in MAIN and the relay in ISOLATED with the exact options', async () => {
    grantAllSites();
    expect(await syncVideoSyncScripts(true)).toBe(true);
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
    await syncVideoSyncScripts(true);
    expect(await syncVideoSyncScripts(false)).toBe(false);
    expect(registeredScripts.size).toBe(0);
  });

  it('should be idempotent: on twice updates instead of registering again', async () => {
    grantAllSites();
    await syncVideoSyncScripts(true);
    expect(await syncVideoSyncScripts(true)).toBe(true);
    expect(registeredScripts.size).toBe(2);
    expect(scriptingCalls.map((c) => c.op)).toEqual(['register', 'update']);
  });

  it('should do nothing when turned off with nothing registered', async () => {
    await syncVideoSyncScripts(false);
    expect(scriptingCalls).toEqual([]);
  });

  it('should register only the missing script after a partial registration', async () => {
    grantAllSites();
    await syncVideoSyncScripts(true);
    registeredScripts.delete(RELAY_SCRIPT_ID);
    scriptingCalls.length = 0;
    await syncVideoSyncScripts(true);
    expect(scriptingCalls).toEqual([
      { op: 'update', ids: [HOOK_SCRIPT_ID] },
      { op: 'register', ids: [RELAY_SCRIPT_ID] },
    ]);
  });

  it('should not register without the all-sites permission, and remove stale scripts', async () => {
    expect(await syncVideoSyncScripts(true)).toBe(false);
    expect(registeredScripts.size).toBe(0);
    grantAllSites();
    await syncVideoSyncScripts(true);
    grantedOrigins.clear();
    await syncVideoSyncScripts(true);
    expect(registeredScripts.size).toBe(0);
  });
});
