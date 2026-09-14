import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createEncoderConfig } from '@thaumic-cast/protocol';

import type { BackgroundToPopupMessage } from '../../lib/messages';
import { resetChromeStub } from '../../test-support/chrome-stub';
import { notificationService } from '../notification-service';
import { dispatch } from '../router';
import { clearAllSessions, registerSession } from '../session-manager';
import { clearAllSpeakerLinkQuality, getSpeakerLinkQuality } from '../speaker-link-quality-state';
import { registerOffscreenRoutes } from './offscreen-routes';

const ENCODER = createEncoderConfig({ codec: 'pcm' });
const KITCHEN = '192.168.1.10';
const NOW = 1_700_000_000_000;
const SENDER = {} as chrome.runtime.MessageSender;

// The router registry is process-wide and refuses duplicate registrations.
registerOffscreenRoutes();

function networkEvent(payload: Record<string, unknown>): Promise<unknown> {
  return dispatch(
    { type: 'NETWORK_EVENT', payload: { category: 'network', ...payload } } as never,
    SENDER,
  );
}

function linkQualityPayload(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'speakerLinkQuality',
    speakerIp: KITCHEN,
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

const notifications: BackgroundToPopupMessage[] = [];
let unsubscribe = (): void => {};

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

describe('NETWORK_EVENT route', () => {
  it('should turn a speakerLinkQuality event for a casting speaker into a popup notification', async () => {
    registerSession(1, 'stream-1', [KITCHEN], ['Kitchen'], ENCODER, false, 'tab');
    notifications.length = 0;

    const result = await networkEvent(linkQualityPayload());

    expect(result).toEqual({ success: true });
    expect(notifications).toEqual([
      {
        type: 'SPEAKER_LINK_QUALITY_CHANGED',
        speakers: {
          [KITCHEN]: {
            quality: 'poor',
            rttMedianMs: 4,
            rttMaxMs: 180,
            spikesPerMinute: 7,
            failuresPerMinute: 1,
            jitterBufferMs: 200,
            updatedAt: NOW,
          },
        },
      },
    ]);
  });

  it('should pass the companion’s buffer suggestion straight through, and omit it when absent', async () => {
    registerSession(1, 'stream-1', [KITCHEN], ['Kitchen'], ENCODER, false, 'tab');
    notifications.length = 0;

    await networkEvent(linkQualityPayload({ suggestedJitterBufferMs: 500 }));
    await networkEvent(linkQualityPayload({ quality: 'degraded', timestamp: NOW + 60_000 }));

    expect(notifications).toEqual([
      {
        type: 'SPEAKER_LINK_QUALITY_CHANGED',
        speakers: {
          [KITCHEN]: expect.objectContaining({ jitterBufferMs: 200, suggestedJitterBufferMs: 500 }),
        },
      },
      {
        type: 'SPEAKER_LINK_QUALITY_CHANGED',
        speakers: { [KITCHEN]: expect.not.objectContaining({ suggestedJitterBufferMs: 500 }) },
      },
    ]);
    expect(getSpeakerLinkQuality()[KITCHEN]).not.toHaveProperty('suggestedJitterBufferMs');
  });

  it('should ignore link quality for a speaker this extension is not casting to', async () => {
    await networkEvent(linkQualityPayload());

    expect(getSpeakerLinkQuality()).toEqual({});
    expect(notifications).toEqual([]);
  });

  it('should still forward healthChanged as NETWORK_HEALTH_CHANGED', async () => {
    await networkEvent({
      type: 'healthChanged',
      health: 'degraded',
      reason: 'speakers_not_responding',
      timestamp: NOW,
    });

    expect(notifications).toEqual([
      { type: 'NETWORK_HEALTH_CHANGED', health: 'degraded', reason: 'speakers_not_responding' },
    ]);
  });

  it('should accept an unknown network event type without notifying anyone', async () => {
    const result = await networkEvent({ type: 'somethingNewer', timestamp: NOW });

    expect(result).toEqual({ success: true });
    expect(notifications).toEqual([]);
  });

  it('should reject a known event type whose body is invalid', async () => {
    registerSession(1, 'stream-1', [KITCHEN], ['Kitchen'], ENCODER, false, 'tab');
    notifications.length = 0;

    await expect(networkEvent(linkQualityPayload({ quality: 'terrible' }))).rejects.toThrow();
    expect(notifications).toEqual([]);
  });
});
