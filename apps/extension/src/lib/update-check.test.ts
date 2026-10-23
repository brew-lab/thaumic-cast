import { afterEach, describe, expect, it } from 'bun:test';

import { checkForUpdate, updateChannel, updateNote } from './update-check';

type Runtime = Record<string, unknown>;
const runtime = chrome.runtime as unknown as Runtime;

/**
 * Stands in for `chrome.runtime.requestUpdateCheck`, answering with one result.
 * @param result - What the browser answers
 */
function answer(result: chrome.runtime.RequestUpdateCheckResult): void {
  runtime.requestUpdateCheck = async () => result;
}

afterEach(() => {
  delete runtime.requestUpdateCheck;
  delete runtime.getManifest;
});

describe('updateChannel', () => {
  it('should treat a manifest with an update_url as a store install', () => {
    const manifest = {
      manifest_version: 3,
      name: 'x',
      version: '1.0.0',
      update_url: 'https://clients2.google.com/service/update2/crx',
    } as chrome.runtime.Manifest;
    expect(updateChannel(manifest)).toBe('store');
  });

  it('should treat a store other than Chrome’s as a store install', () => {
    const manifest = {
      manifest_version: 3,
      name: 'x',
      version: '1.0.0',
      update_url: 'https://edge.microsoft.com/extensionwebstorebase/v1/crx',
    } as chrome.runtime.Manifest;
    expect(updateChannel(manifest)).toBe('store');
  });

  it('should treat an unpacked copy, with no update_url, as manual', () => {
    runtime.getManifest = () => ({ manifest_version: 3, name: 'x', version: '1.0.0' });
    expect(updateChannel()).toBe('manual');
  });
});

describe('checkForUpdate', () => {
  it('should say latest when the store has nothing newer', async () => {
    answer({ status: 'no_update' });
    expect(await checkForUpdate()).toEqual({ kind: 'latest' });
  });

  it('should name the version the store found', async () => {
    answer({ status: 'update_available', version: '0.13.0' });
    expect(await checkForUpdate()).toEqual({ kind: 'ready', version: '0.13.0' });
  });

  it('should say throttled when the browser checked too recently', async () => {
    answer({ status: 'throttled' });
    expect(await checkForUpdate()).toEqual({ kind: 'throttled' });
  });

  it('should reject when the browser cannot run the check', async () => {
    runtime.requestUpdateCheck = async () => {
      throw new Error('no');
    };
    await expect(checkForUpdate()).rejects.toThrow('no');
  });
});

describe('updateNote', () => {
  it('should say this is the latest version', () => {
    expect(updateNote({ kind: 'latest' }, false)).toEqual({ key: 'about_update_latest' });
  });

  it('should ask for patience when throttled', () => {
    expect(updateNote({ kind: 'throttled' }, true)).toEqual({ key: 'about_update_throttled' });
  });

  it('should name a ready version while nothing casts', () => {
    expect(updateNote({ kind: 'ready', version: '0.13.0' }, false)).toEqual({
      key: 'about_update_ready',
      version: '0.13.0',
    });
  });

  it('should say the restart waits while a cast runs', () => {
    expect(updateNote({ kind: 'ready', version: '0.13.0' }, true)).toEqual({
      key: 'about_update_ready_casting',
    });
  });

  it('should still say a version is ready when the browser gives none', () => {
    expect(updateNote({ kind: 'ready' }, false)).toEqual({ key: 'about_update_ready_unnamed' });
  });
});
