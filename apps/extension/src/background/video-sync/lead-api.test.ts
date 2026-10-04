import { beforeEach, describe, expect, it } from 'bun:test';

import { resetChromeStub, tabMessages } from '../../test-support/chrome-stub';
import {
  forgetTab,
  getTabHookStatus,
  handleHookStatus,
  onHookStatus,
  setTabLead,
} from './lead-api';

const sender = (tabId: number, frameId: number) =>
  ({ tab: { id: tabId }, frameId }) as chrome.runtime.MessageSender;

describe('setTabLead', () => {
  beforeEach(() => resetChromeStub());

  it('should send one lead message to the whole tab, rounded and bounded', async () => {
    await setTabLead(7, { enabled: true, leadMs: 912.4 });
    await setTabLead(7, { enabled: true, leadMs: 9000, rearm: true });
    expect(tabMessages).toEqual([
      { tabId: 7, message: { type: 'VIDEO_SYNC_LEAD', enabled: true, leadMs: 912 } },
      { tabId: 7, message: { type: 'VIDEO_SYNC_LEAD', enabled: true, leadMs: 6000, rearm: true } },
    ]);
  });

  it('should say the tab was not reached when no relay answers', async () => {
    expect(await setTabLead(7, { enabled: false, leadMs: 0 })).toEqual({
      reached: false,
      paired: false,
    });
  });

  it('should say the tab was reached when a relay answers', async () => {
    const tabs = chrome.tabs as unknown as { sendMessage: (...a: unknown[]) => Promise<unknown> };
    const original = tabs.sendMessage;
    tabs.sendMessage = async () => ({ paired: true, status: null });
    try {
      expect(await setTabLead(7, { enabled: true, leadMs: 900 })).toEqual({
        reached: true,
        paired: true,
      });
    } finally {
      tabs.sendMessage = original;
    }
  });
});

describe('handleHookStatus', () => {
  beforeEach(() => forgetTab(3));

  it('should keep each frame of a tab apart and tell listeners', () => {
    const seen: number[][] = [];
    const off = onHookStatus((tabId, frames) => seen.push([tabId, frames.size]));
    const status = { state: 'applied' as const, appliedLeadMs: 900, playing: true };
    handleHookStatus({ type: 'VIDEO_SYNC_HOOK_STATUS', status }, sender(3, 0));
    handleHookStatus(
      { type: 'VIDEO_SYNC_HOOK_STATUS', status: { ...status, state: 'no-media', playing: false } },
      sender(3, 12),
    );
    off();
    const frames = getTabHookStatus(3);
    expect(frames.get(0)?.state).toBe('applied');
    expect(frames.get(12)?.state).toBe('no-media');
    expect(seen).toEqual([
      [3, 1],
      [3, 2],
    ]);
  });

  it('should ignore a status without a tab', () => {
    const status = { state: 'idle' as const, appliedLeadMs: 0, playing: false };
    handleHookStatus(
      { type: 'VIDEO_SYNC_HOOK_STATUS', status },
      {} as chrome.runtime.MessageSender,
    );
    expect(getTabHookStatus(3).size).toBe(0);
  });

  it('should forget a tab', () => {
    const status = { state: 'idle' as const, appliedLeadMs: 0, playing: false };
    handleHookStatus({ type: 'VIDEO_SYNC_HOOK_STATUS', status }, sender(3, 0));
    forgetTab(3);
    expect(getTabHookStatus(3).size).toBe(0);
  });
});
