import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createEncoderConfig } from '@thaumic-cast/protocol';

import type { BackgroundToPopupMessage, SpeakerHealthEvent } from '../lib/messages';
import { resetChromeStub } from '../test-support/chrome-stub';
import { handleWsTemporarilyDisconnected } from './handlers/connection';
import { notificationService } from './notification-service';
import { clearAllSessions, registerSession, removeSpeakerFromSession } from './session-manager';
import {
  applySpeakerHealthEvent,
  clearAllSpeakerHealth,
  getSpeakerHealth,
} from './speaker-health-state';

const ENCODER = createEncoderConfig({ codec: 'pcm' });
const KITCHEN = '192.168.1.10';
const OFFICE = '192.168.1.11';
const NOW = 1_700_000_000_000;
const REPORT_MS = 30_000;

function healthEvent(
  speakerIp: string,
  fields: Partial<SpeakerHealthEvent> = {},
): SpeakerHealthEvent {
  return {
    type: 'speakerHealth',
    streamId: 'stream-1',
    speakerIp,
    epochId: 1,
    state: 'ok',
    reserveMs: 520,
    reservePrecisionMs: 30,
    reserveAcked: true,
    targetMs: 520,
    timestamp: NOW,
    ...fields,
  };
}

const notifications: BackgroundToPopupMessage[] = [];
let unsubscribe = (): void => {};

function healthBroadcasts(): BackgroundToPopupMessage[] {
  return notifications.filter((msg) => msg.type === 'SPEAKER_HEALTH_CHANGED');
}

beforeEach(() => {
  resetChromeStub();
  clearAllSessions();
  clearAllSpeakerHealth();
  notifications.length = 0;
  unsubscribe = notificationService.subscribe((msg) => notifications.push(msg));
});

afterEach(() => {
  unsubscribe();
});

describe('applySpeakerHealthEvent', () => {
  it('should keep the latest reading per speaker with the event time as updatedAt', () => {
    applySpeakerHealthEvent(healthEvent(KITCHEN));
    applySpeakerHealthEvent(healthEvent(OFFICE, { state: 'locking', reserveMs: undefined }));
    applySpeakerHealthEvent(healthEvent(KITCHEN, { reserveMs: 500, timestamp: NOW + REPORT_MS }));

    const snapshot = getSpeakerHealth();
    expect(snapshot[KITCHEN]).toEqual({
      streamId: 'stream-1',
      epochId: 1,
      state: 'ok',
      reserveMs: 500,
      reservePrecisionMs: 30,
      reserveAcked: true,
      targetMs: 520,
      updatedAt: NOW + REPORT_MS,
    });
    expect(snapshot[OFFICE]?.state).toBe('locking');
  });

  it('should carry the companion notice and the head start figures through as sent', () => {
    const notice = {
      kind: 'head_start_close',
      noticeId: 3,
      stallMs: 420,
      leftMs: 60,
      headStartMs: 500,
      suggestedHeadStartMs: 750,
      restartHelps: false,
    } as const;
    applySpeakerHealthEvent(
      healthEvent(KITCHEN, {
        headStartMs: 500,
        headStartConfiguredMs: 500,
        floorMs: 150,
        stallMs: 420,
        notice,
      }),
    );

    expect(getSpeakerHealth()[KITCHEN]).toMatchObject({
      headStartMs: 500,
      headStartConfiguredMs: 500,
      floorMs: 150,
      stallMs: 420,
      notice,
    });
  });

  it('should drop the notice once the companion stops repeating it', () => {
    const notice = { kind: 'running_low', noticeId: 1, leftMs: 90, restartHelps: true } as const;
    applySpeakerHealthEvent(healthEvent(KITCHEN, { state: 'low', notice }));
    applySpeakerHealthEvent(healthEvent(KITCHEN, { timestamp: NOW + REPORT_MS }));

    expect(getSpeakerHealth()[KITCHEN]?.notice).toBeUndefined();
  });
});

describe('clearing', () => {
  it('should drop the reading when the speaker leaves its cast and tell the popup', () => {
    registerSession(1, 'stream-1', [KITCHEN, OFFICE], ['Kitchen', 'Office'], ENCODER, false, 'tab');
    applySpeakerHealthEvent(healthEvent(KITCHEN, { state: 'low' }));
    applySpeakerHealthEvent(healthEvent(OFFICE));
    notifications.length = 0;

    removeSpeakerFromSession(1, KITCHEN);

    expect(Object.keys(getSpeakerHealth())).toEqual([OFFICE]);
    expect(healthBroadcasts()).toEqual([
      { type: 'SPEAKER_HEALTH_CHANGED', speakers: getSpeakerHealth() },
    ]);
  });

  it('should drop every reading and tell the popup when the connection is lost', () => {
    registerSession(1, 'stream-1', [KITCHEN], ['Kitchen'], ENCODER, false, 'tab');
    applySpeakerHealthEvent(healthEvent(KITCHEN, { state: 'low' }));
    notifications.length = 0;

    handleWsTemporarilyDisconnected();

    expect(getSpeakerHealth()).toEqual({});
    expect(healthBroadcasts()).toEqual([{ type: 'SPEAKER_HEALTH_CHANGED', speakers: {} }]);
  });
});
