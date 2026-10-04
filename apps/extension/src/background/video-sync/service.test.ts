import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createEmptySonosState,
  createEncoderConfig,
  type LatencyBroadcastEvent,
  type PlayoutLatency,
} from '@thaumic-cast/protocol';

import type { BackgroundToPopupMessage } from '../../lib/messages';
import {
  chromeStorageData,
  grantedOrigins,
  resetChromeStub,
  tabMessages,
  tabUrls,
} from '../../test-support/chrome-stub';
import { VIDEO_SYNC_ORIGINS } from '../../lib/video-sync-access';
import { notificationService } from '../notification-service';
import { clearAllSessions, getSession, registerSession, removeSession } from '../session-manager';
import { setSonosState } from '../sonos-state';
import {
  getVideoSyncStatus,
  handleCaptureDelay,
  handleVideoSyncLatency,
  initVideoSyncService,
  resetVideoSyncService,
  setVideoSyncEnabled,
  setVideoSyncTrim,
  stopVideoSync,
} from './service';

const SPEAKER = '192.168.1.20';
const OTHER = '192.168.1.21';
const STREAM = 'stream-1';
const TAB = 4;

type TabsWithSend = { sendMessage: (tabId: number, message: unknown) => Promise<unknown> };
const tabs = chrome.tabs as unknown as TabsWithSend;
const stubSend = tabs.sendMessage;

/** Makes every tab's relay answer, as a page with the hook does. */
function relaysAnswer(): void {
  tabs.sendMessage = async (tabId, message) => {
    tabMessages.push({ tabId, message });
    return { paired: true, status: null };
  };
}

/**
 * Lets queued sends and storage reads finish.
 * @returns Resolves after a few turns of the event loop
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
}

/**
 * An updated latency event for the cast.
 * @param playout - Its estimate, if any
 * @param speakerIp - The speaker it is for
 * @returns The event
 */
function updated(playout?: Partial<PlayoutLatency>, speakerIp = SPEAKER): LatencyBroadcastEvent {
  return {
    category: 'latency',
    type: 'updated',
    streamId: STREAM,
    speakerIp,
    epochId: 1,
    latencyMs: 700,
    jitterMs: 5,
    confidence: 0.9,
    timestamp: 0,
    ...(playout
      ? {
          playout: {
            companionMs: 700,
            uncertaintyMs: 20,
            source: 'reserve',
            epoch: 1,
            queueMs: 60,
            reserveMs: 640,
            headStartMs: 500,
            calibMs: 20,
            ...playout,
          },
        }
      : {}),
  };
}

/**
 * The lead messages sent to the tab.
 * @returns Their bodies, oldest first
 */
function leads(): unknown[] {
  return tabMessages
    .filter((m) => m.tabId === TAB && (m.message as { type: string }).type === 'VIDEO_SYNC_LEAD')
    .map((m) => m.message);
}

/**
 * Registers a cast.
 * @param codec - Its codec
 * @param videoSync - Whether it started with video sync on
 */
function cast(codec: 'pcm' | 'aac-lc' = 'pcm', videoSync = true): void {
  registerSession(
    TAB,
    STREAM,
    [SPEAKER, OTHER],
    ['Kitchen', 'Den'],
    createEncoderConfig({ codec }),
    false,
    'tab',
    videoSync,
  );
}

const notifications: BackgroundToPopupMessage[] = [];
let unsubscribe = (): void => {};

beforeEach(() => {
  resetChromeStub();
  resetVideoSyncService();
  clearAllSessions();
  setSonosState({
    ...createEmptySonosState(),
    groups: [
      {
        id: 'g1',
        name: 'Kitchen',
        coordinatorUuid: 'RINCON_KITCHEN',
        coordinatorIp: SPEAKER,
        members: [{ uuid: 'RINCON_KITCHEN', ip: SPEAKER, zoneName: 'Kitchen' }],
      },
    ],
  });
  for (const origin of VIDEO_SYNC_ORIGINS) grantedOrigins.add(origin);
  tabs.sendMessage = stubSend;
  initVideoSyncService();
  notifications.length = 0;
  unsubscribe = notificationService.subscribe((msg) => notifications.push(msg));
});

afterEach(() => {
  unsubscribe();
  resetVideoSyncService();
  tabs.sendMessage = stubSend;
});

describe('video sync service', () => {
  it('should send the lead from the playout estimate, the capture delay and the trim', async () => {
    relaysAnswer();
    cast();
    chromeStorageData.local.videoSyncTrimBySpeaker = { RINCON_KITCHEN: 50 };
    await handleCaptureDelay(TAB, 30);
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    // 700 + 30 + 50 - 40
    expect(leads()).toContainEqual({ type: 'VIDEO_SYNC_LEAD', enabled: true, leadMs: 740 });
    expect(await getVideoSyncStatus(TAB)).toMatchObject({
      enabled: true,
      speakerIp: SPEAKER,
      speakerName: 'Kitchen',
      trimMs: 50,
      leadMs: 740,
      source: 'reserve',
    });
  });

  it('should follow only the first speaker', async () => {
    relaysAnswer();
    cast();
    await handleVideoSyncLatency(updated({ companionMs: 2000 }, OTHER));
    await settle();
    expect(leads().filter((m) => (m as { leadMs: number }).leadMs > 0)).toEqual([]);
  });

  it('should send nothing for an AAC cast and say PCM only', async () => {
    relaysAnswer();
    cast('aac-lc');
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    expect(leads()).toEqual([]);
    expect(await getVideoSyncStatus(TAB)).toMatchObject({
      state: 'unavailable',
      reason: 'pcm-only',
    });
  });

  it('should do nothing for a cast started without video sync', async () => {
    relaysAnswer();
    cast('pcm', false);
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    expect(leads()).toEqual([]);
    expect(await getVideoSyncStatus(TAB)).toBeNull();
  });

  it('should ask for a reload when the page has no relay', async () => {
    tabUrls.set(TAB, 'https://video.example/watch');
    cast();
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    expect(await getVideoSyncStatus(TAB)).toMatchObject({
      state: 'unavailable',
      reason: 'reload',
    });
    expect(notifications).toContainEqual(
      expect.objectContaining({
        type: 'VIDEO_SYNC_STATE_CHANGED',
        tabId: TAB,
        status: expect.objectContaining({ reason: 'reload' }),
      }),
    );
  });

  it('should not advise a reload on a page no script may enter', async () => {
    cast();
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    expect(await getVideoSyncStatus(TAB)).toMatchObject({ reason: 'not-web-page' });
    tabUrls.set(TAB, 'https://chromewebstore.google.com/detail/x');
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    expect(await getVideoSyncStatus(TAB)).toMatchObject({ reason: 'not-web-page' });
  });

  it('should say access is missing when the page scripts cannot be injected', async () => {
    grantedOrigins.clear();
    cast();
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    expect(await getVideoSyncStatus(TAB)).toMatchObject({ reason: 'no-access' });
  });

  it('should store a trim for the speaker and apply it at once', async () => {
    relaysAnswer();
    cast();
    await handleCaptureDelay(TAB, 0);
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    const status = await setVideoSyncTrim(TAB, -100);
    await settle();
    expect(status?.trimMs).toBe(-100);
    expect(chromeStorageData.local.videoSyncTrimBySpeaker).toEqual({ RINCON_KITCHEN: -100 });
    expect(leads().at(-1)).toEqual({ type: 'VIDEO_SYNC_LEAD', enabled: true, leadMs: 560 });
  });

  it('should take the lead off and remember the choice on the session', async () => {
    relaysAnswer();
    cast();
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    const status = await setVideoSyncEnabled(TAB, false);
    await settle();
    expect(status?.state).toBe('off');
    expect(getSession(TAB)?.videoSyncOn).toBe(false);
    expect(leads().at(-1)).toEqual({ type: 'VIDEO_SYNC_LEAD', enabled: false, leadMs: 0 });
  });

  it('should send lead 0 on stop and not bring the lead back for a late event', async () => {
    relaysAnswer();
    cast();
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    await stopVideoSync(TAB);
    expect(leads().at(-1)).toEqual({ type: 'VIDEO_SYNC_LEAD', enabled: false, leadMs: 0 });
    const sent = leads().length;
    await handleVideoSyncLatency(updated({ companionMs: 700, epoch: 2 }));
    await settle();
    expect(leads().length).toBe(sent);
  });

  it('should not let a send queued before stop go out after its lead 0', async () => {
    cast();
    // The relay holds the first send until released, as a slow page would.
    let release = (): void => {};
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    tabs.sendMessage = async (tabId, message) => {
      if (first) {
        first = false;
        await held;
      }
      tabMessages.push({ tabId, message });
      return { paired: true, status: null };
    };
    await handleCaptureDelay(TAB, 0);
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await setVideoSyncTrim(TAB, 100);
    const stopped = stopVideoSync(TAB);
    release();
    await stopped;
    await settle();
    expect(leads().at(-1)).toEqual({ type: 'VIDEO_SYNC_LEAD', enabled: false, leadMs: 0 });
    expect(leads()).not.toContainEqual(expect.objectContaining({ leadMs: 760 }));
  });

  it('should take the lead off when its cast ended some other way', async () => {
    relaysAnswer();
    cast();
    await handleCaptureDelay(TAB, 0);
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    expect(chromeStorageData.session.videoSyncLeads).toHaveProperty(String(TAB));
    // Ended without stopVideoSync (disconnected, say); a stale popup then asks.
    removeSession(TAB);
    expect(await getVideoSyncStatus(TAB)).toBeNull();
    await settle();
    expect(leads().at(-1)).toEqual({ type: 'VIDEO_SYNC_LEAD', enabled: false, leadMs: 0 });
    expect(chromeStorageData.session.videoSyncLeads).not.toHaveProperty(String(TAB));
  });

  it('should keep the lead in force across a service-worker restart', async () => {
    relaysAnswer();
    cast();
    chromeStorageData.session.videoSyncLeads = {
      [String(TAB)]: { streamId: STREAM, leadMs: 655, epoch: 1 },
    };
    await handleVideoSyncLatency(updated({ companionMs: 700, epoch: 1 }));
    await settle();
    // 660 is within 40 ms of the restored 655: nothing moves.
    expect(leads()).toEqual([{ type: 'VIDEO_SYNC_LEAD', enabled: true, leadMs: 655 }]);
  });

  it('should ignore a stored lead from another cast', async () => {
    relaysAnswer();
    cast();
    chromeStorageData.session.videoSyncLeads = {
      [String(TAB)]: { streamId: 'old-stream', leadMs: 1500, epoch: 1 },
    };
    await handleCaptureDelay(TAB, 0);
    await handleVideoSyncLatency(updated({ companionMs: 700 }));
    await settle();
    expect(leads()).toContainEqual({ type: 'VIDEO_SYNC_LEAD', enabled: true, leadMs: 660 });
    expect(leads()).not.toContainEqual(expect.objectContaining({ leadMs: 1500 }));
  });

  it('should drop an estimate this build cannot read', async () => {
    relaysAnswer();
    cast();
    const event = updated({ companionMs: 700 });
    (event as unknown as { playout: unknown }).playout = { companionMs: 'soon' };
    await handleVideoSyncLatency(event);
    await settle();
    expect(leads().filter((m) => (m as { leadMs: number }).leadMs > 0)).toEqual([]);
  });
});
