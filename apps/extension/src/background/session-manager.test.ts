import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createEncoderConfig, type EncoderConfig } from '@thaumic-cast/protocol';

import type { BackgroundToPopupMessage } from '../lib/messages';
import { chromeStorageData, resetChromeStub } from '../test-support/chrome-stub';
import { notificationService } from './notification-service';
import { persistenceManager } from './persistence-manager';
import {
  clearAllSessions,
  getActiveCasts,
  getActiveTabIds,
  getAllSessions,
  getSession,
  getSessionBySpeakerIp,
  getSessionByStreamId,
  getSessionCount,
  hasBrowserCaptureSessions,
  hasSession,
  hasTabCaptureSessions,
  registerSession,
  removeSession,
  removeSpeakerFromSession,
} from './session-manager';

const ENCODER: EncoderConfig = createEncoderConfig({ codec: 'pcm' });
const KITCHEN = '192.168.1.10';
const OFFICE = '192.168.1.11';

function register(
  tabId: number,
  streamId: string,
  speakerIps: string[] = [KITCHEN],
  captureMode: 'tab' | 'browser' = 'tab',
): void {
  const names = speakerIps.map((ip) => `Speaker ${ip}`);
  registerSession(tabId, streamId, speakerIps, names, ENCODER, false, captureMode);
}

const notifications: BackgroundToPopupMessage[] = [];
let unsubscribe = (): void => {};

beforeEach(() => {
  resetChromeStub();
  clearAllSessions();
  notifications.length = 0;
  unsubscribe = notificationService.subscribe((msg) => notifications.push(msg));
});

afterEach(() => {
  unsubscribe();
});

describe('registerSession', () => {
  it('should not mutate the arrays the caller passed to registerSession', () => {
    const ips = [KITCHEN, OFFICE];
    const names = ['Kitchen', 'Office'];
    registerSession(1, 'stream-1', ips, names, ENCODER, false, 'tab');

    removeSpeakerFromSession(1, KITCHEN);

    expect(ips).toEqual([KITCHEN, OFFICE]);
    expect(names).toEqual(['Kitchen', 'Office']);
    expect(getSession(1)?.speakerIps).toEqual([OFFICE]);
  });

  it('should store the session under its tab with tab capture by default', () => {
    register(1, 'stream-1', [KITCHEN, OFFICE]);

    expect(hasSession(1)).toBe(true);
    expect(getSession(1)).toMatchObject({
      tabId: 1,
      streamId: 'stream-1',
      speakerIps: [KITCHEN, OFFICE],
      speakerNames: [`Speaker ${KITCHEN}`, `Speaker ${OFFICE}`],
      captureMode: 'tab',
      syncSpeakers: false,
    });
  });

  it('should replace an earlier session for the same tab', () => {
    register(1, 'stream-1');
    register(1, 'stream-2', [OFFICE]);

    expect(getSessionCount()).toBe(1);
    expect(getSession(1)?.streamId).toBe('stream-2');
    expect(getSessionByStreamId('stream-1')).toBeUndefined();
  });

  it('should tell the popup the active casts changed', () => {
    register(1, 'stream-1');

    expect(notifications.at(-1)).toMatchObject({ type: 'ACTIVE_CASTS_CHANGED' });
  });

  it('should persist sessions to session storage immediately', () => {
    register(1, 'stream-1');

    expect(chromeStorageData.session.activeSessions).toEqual([
      [1, expect.objectContaining({ streamId: 'stream-1' })],
    ]);
  });
});

describe('lookups', () => {
  beforeEach(() => {
    register(1, 'stream-1', [KITCHEN]);
    register(2, 'stream-2', [OFFICE, '192.168.1.12']);
  });

  it('should find a session by its stream id', () => {
    expect(getSessionByStreamId('stream-2')?.tabId).toBe(2);
    expect(getSessionByStreamId('stream-9')).toBeUndefined();
  });

  it('should find a session by any of its speakers', () => {
    expect(getSessionBySpeakerIp('192.168.1.12')?.tabId).toBe(2);
    expect(getSessionBySpeakerIp(KITCHEN)?.tabId).toBe(1);
    expect(getSessionBySpeakerIp('10.0.0.1')).toBeUndefined();
  });

  it('should enumerate sessions and their tabs', () => {
    expect(getSessionCount()).toBe(2);
    expect(getActiveTabIds()).toEqual([1, 2]);
    expect(getAllSessions().map((s) => s.streamId)).toEqual(['stream-1', 'stream-2']);
  });
});

describe('removeSession', () => {
  it('should forget the session and notify the popup', () => {
    register(1, 'stream-1');
    notifications.length = 0;

    removeSession(1);

    expect(hasSession(1)).toBe(false);
    expect(notifications.map((n) => n.type)).toEqual(['ACTIVE_CASTS_CHANGED']);
  });

  it('should do nothing for a tab without a session', () => {
    register(1, 'stream-1');
    notifications.length = 0;

    removeSession(99);

    expect(getSessionCount()).toBe(1);
    expect(notifications).toEqual([]);
  });
});

describe('removeSpeakerFromSession', () => {
  it('should remove the speaker and its display name and keep the cast running', () => {
    register(1, 'stream-1', [KITCHEN, OFFICE]);

    expect(removeSpeakerFromSession(1, KITCHEN)).toBe(true);
    expect(getSession(1)).toMatchObject({
      speakerIps: [OFFICE],
      speakerNames: [`Speaker ${OFFICE}`],
    });
    expect(hasSession(1)).toBe(true);
  });

  it('should end the whole session when the last speaker is removed', () => {
    register(1, 'stream-1', [KITCHEN]);

    expect(removeSpeakerFromSession(1, KITCHEN)).toBe(true);
    expect(hasSession(1)).toBe(false);
    expect(getSessionCount()).toBe(0);
  });

  it('should report false when the tab or speaker is unknown', () => {
    register(1, 'stream-1', [KITCHEN]);

    expect(removeSpeakerFromSession(2, KITCHEN)).toBe(false);
    expect(removeSpeakerFromSession(1, OFFICE)).toBe(false);
    expect(getSession(1)?.speakerIps).toEqual([KITCHEN]);
  });
});

describe('capture mode queries', () => {
  it('should reflect which capture modes are in use', () => {
    expect(hasTabCaptureSessions()).toBe(false);
    expect(hasBrowserCaptureSessions()).toBe(false);

    register(1, 'stream-1', [KITCHEN], 'browser');
    expect(hasTabCaptureSessions()).toBe(false);
    expect(hasBrowserCaptureSessions()).toBe(true);

    register(2, 'stream-2', [OFFICE], 'tab');
    expect(hasTabCaptureSessions()).toBe(true);
  });
});

describe('clearAllSessions', () => {
  it('should drop every session at once', () => {
    register(1, 'stream-1');
    register(2, 'stream-2', [OFFICE]);

    clearAllSessions();

    expect(getSessionCount()).toBe(0);
    expect(chromeStorageData.session.activeSessions).toEqual([]);
  });
});

describe('getActiveCasts', () => {
  it('should fall back to a placeholder media state when nothing is cached for the tab', () => {
    register(1, 'stream-1', [KITCHEN, OFFICE]);

    const [cast] = getActiveCasts();

    expect(cast).toMatchObject({
      streamId: 'stream-1',
      tabId: 1,
      speakerIps: [KITCHEN, OFFICE],
      syncSpeakers: false,
    });
    expect(cast?.mediaState).toMatchObject({ tabId: 1, tabTitle: 'Unknown Tab', metadata: null });
  });
});

describe('restoring persisted sessions', () => {
  it('should migrate the legacy single-speaker shape and fill newer fields', async () => {
    chromeStorageData.session.activeSessions = [
      [
        5,
        {
          streamId: 'old-stream',
          tabId: 5,
          speakerIp: KITCHEN,
          speakerName: 'Kitchen',
          encoderConfig: ENCODER,
          startedAt: 1,
        },
      ],
    ];

    const restored = await persistenceManager.get<[number, unknown][]>('activeSessions')?.restore();

    expect(restored).toEqual([
      [
        5,
        {
          streamId: 'old-stream',
          tabId: 5,
          speakerIps: [KITCHEN],
          speakerNames: ['Kitchen'],
          encoderConfig: ENCODER,
          startedAt: 1,
          syncSpeakers: false,
          captureMode: 'tab',
        },
      ],
    ]);
  });

  it('should ignore stored data that is not a session list', async () => {
    chromeStorageData.session.activeSessions = { corrupted: true };

    const entry = persistenceManager.get('activeSessions');
    expect(entry).toBeDefined();
    expect(await entry!.restore()).toBeUndefined();
  });
});
