import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createEncoderConfig } from '@thaumic-cast/protocol';

import type { BackgroundToPopupMessage, SpeakerLinkQualityEvent } from '../lib/messages';
import { resetChromeStub } from '../test-support/chrome-stub';
import { handleWsTemporarilyDisconnected } from './handlers/connection';
import { notificationService } from './notification-service';
import {
  clearAllSessions,
  registerSession,
  removeSession,
  removeSpeakerFromSession,
} from './session-manager';
import {
  applySpeakerLinkQualityEvent,
  clearAllSpeakerLinkQuality,
  getSpeakerLinkQuality,
} from './speaker-link-quality-state';

const ENCODER = createEncoderConfig({ codec: 'pcm' });
const KITCHEN = '192.168.1.10';
const OFFICE = '192.168.1.11';
const NOW = 1_700_000_000_000;

function linkEvent(
  speakerIp: string,
  fields: Partial<SpeakerLinkQualityEvent> = {},
): SpeakerLinkQualityEvent {
  return {
    type: 'speakerLinkQuality',
    speakerIp,
    quality: 'poor',
    rttMedianMs: 4,
    rttMaxMs: 180,
    spikesPerMinute: 7,
    failuresPerMinute: 1,
    jitterBufferMs: 200,
    timestamp: NOW,
    ...fields,
  };
}

function register(tabId: number, speakerIps: string[]): void {
  const names = speakerIps.map((ip) => `Speaker ${ip}`);
  registerSession(tabId, `stream-${tabId}`, speakerIps, names, ENCODER, false, 'tab');
}

const notifications: BackgroundToPopupMessage[] = [];
let unsubscribe = (): void => {};

function linkQualityBroadcasts(): BackgroundToPopupMessage[] {
  return notifications.filter((msg) => msg.type === 'SPEAKER_LINK_QUALITY_CHANGED');
}

beforeEach(() => {
  resetChromeStub();
  clearAllSessions();
  clearAllSpeakerLinkQuality();
  notifications.length = 0;
  unsubscribe = notificationService.subscribe((msg) => notifications.push(msg));
});

afterEach(() => {
  unsubscribe();
});

describe('applySpeakerLinkQualityEvent', () => {
  it('should keep the latest reading per speaker with the event time as updatedAt', () => {
    applySpeakerLinkQualityEvent(linkEvent(KITCHEN, { quality: 'degraded', timestamp: NOW }));
    applySpeakerLinkQualityEvent(linkEvent(OFFICE, { quality: 'good', spikesPerMinute: 0 }));
    applySpeakerLinkQualityEvent(
      linkEvent(KITCHEN, {
        quality: 'poor',
        spikesPerMinute: 12,
        suggestedJitterBufferMs: 500,
        timestamp: NOW + 60_000,
      }),
    );

    expect(getSpeakerLinkQuality()).toEqual({
      [KITCHEN]: {
        quality: 'poor',
        rttMedianMs: 4,
        rttMaxMs: 180,
        spikesPerMinute: 12,
        failuresPerMinute: 1,
        jitterBufferMs: 200,
        suggestedJitterBufferMs: 500,
        updatedAt: NOW + 60_000,
      },
      [OFFICE]: {
        quality: 'good',
        rttMedianMs: 4,
        rttMaxMs: 180,
        spikesPerMinute: 0,
        failuresPerMinute: 1,
        jitterBufferMs: 200,
        updatedAt: NOW,
      },
    });
  });

  it('should forget an earlier suggestion when the next reading has none', () => {
    applySpeakerLinkQualityEvent(linkEvent(KITCHEN, { suggestedJitterBufferMs: 500 }));
    applySpeakerLinkQualityEvent(linkEvent(KITCHEN, { timestamp: NOW + 60_000 }));

    expect(getSpeakerLinkQuality()[KITCHEN]).not.toHaveProperty('suggestedJitterBufferMs');
  });

  it('should hand out a copy that later events do not mutate', () => {
    applySpeakerLinkQualityEvent(linkEvent(KITCHEN));
    const before = getSpeakerLinkQuality();

    applySpeakerLinkQualityEvent(linkEvent(OFFICE));

    expect(Object.keys(before)).toEqual([KITCHEN]);
  });
});

describe('clearing when a speaker leaves every active cast', () => {
  it('should drop the reading when the speaker is removed from its cast and tell the popup', () => {
    register(1, [KITCHEN, OFFICE]);
    applySpeakerLinkQualityEvent(linkEvent(KITCHEN));
    applySpeakerLinkQualityEvent(linkEvent(OFFICE));
    notifications.length = 0;

    removeSpeakerFromSession(1, KITCHEN);

    expect(Object.keys(getSpeakerLinkQuality())).toEqual([OFFICE]);
    expect(linkQualityBroadcasts()).toEqual([
      { type: 'SPEAKER_LINK_QUALITY_CHANGED', speakers: getSpeakerLinkQuality() },
    ]);
  });

  it('should drop every speaker of a cast when the cast stops', () => {
    register(1, [KITCHEN, OFFICE]);
    applySpeakerLinkQualityEvent(linkEvent(KITCHEN));
    applySpeakerLinkQualityEvent(linkEvent(OFFICE));
    notifications.length = 0;

    removeSession(1);

    expect(getSpeakerLinkQuality()).toEqual({});
    expect(linkQualityBroadcasts()).toEqual([
      { type: 'SPEAKER_LINK_QUALITY_CHANGED', speakers: {} },
    ]);
  });

  it('should keep the reading while another cast still uses the speaker', () => {
    register(1, [KITCHEN]);
    register(2, [KITCHEN]);
    applySpeakerLinkQualityEvent(linkEvent(KITCHEN));
    notifications.length = 0;

    removeSession(1);

    expect(Object.keys(getSpeakerLinkQuality())).toEqual([KITCHEN]);
    expect(linkQualityBroadcasts()).toEqual([]);
  });

  it('should not tell the popup when the removed speaker had no reading', () => {
    register(1, [KITCHEN]);
    notifications.length = 0;

    removeSession(1);

    expect(linkQualityBroadcasts()).toEqual([]);
  });
});

describe('clearing on WebSocket disconnect', () => {
  it('should drop every reading and tell the popup when the connection is lost', () => {
    register(1, [KITCHEN]);
    applySpeakerLinkQualityEvent(linkEvent(KITCHEN));
    notifications.length = 0;

    handleWsTemporarilyDisconnected();

    expect(getSpeakerLinkQuality()).toEqual({});
    expect(notifications).toEqual([
      { type: 'SPEAKER_LINK_QUALITY_CHANGED', speakers: {} },
      { type: 'WS_CONNECTION_LOST', reason: 'reconnecting' },
    ]);
  });

  it('should not tell the popup about link quality when there was nothing to drop', () => {
    handleWsTemporarilyDisconnected();

    expect(linkQualityBroadcasts()).toEqual([]);
  });
});
