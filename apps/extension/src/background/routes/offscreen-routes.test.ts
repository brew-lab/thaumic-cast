import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createEncoderConfig } from '@thaumic-cast/protocol';

import type { BackgroundToPopupMessage } from '../../lib/messages';
import { resetChromeStub } from '../../test-support/chrome-stub';
import { notificationService } from '../notification-service';
import { dispatch } from '../router';
import { clearAllSessions, registerSession } from '../session-manager';
import { clearAllSpeakerHealth, getSpeakerHealth } from '../speaker-health-state';
import { clearAllIngestGaps, getIngestGaps } from '../ingest-gaps-state';
import { clearConnectionState, getConnectionState } from '../connection-state';
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

function streamEvent(payload: Record<string, unknown>): Promise<unknown> {
  return dispatch(
    { type: 'SONOS_EVENT', payload: { category: 'stream', ...payload } } as never,
    SENDER,
  );
}

function speakerHealthPayload(fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'speakerHealth',
    streamId: 'stream-1',
    speakerIp: KITCHEN,
    epochId: 1,
    state: 'low',
    reserveMs: 310,
    reserveP10Ms: 180,
    reserveAcked: true,
    targetMs: 520,
    timestamp: NOW,
    ...fields,
  };
}

const notifications: BackgroundToPopupMessage[] = [];
let unsubscribe = (): void => {};

beforeEach(() => {
  resetChromeStub();
  clearAllSessions();
  clearAllSpeakerHealth();
  clearAllIngestGaps();
  clearConnectionState();
  notifications.length = 0;
  unsubscribe = notificationService.subscribe((msg) => notifications.push(msg));
});

afterEach(() => {
  unsubscribe();
});

describe('NETWORK_EVENT route', () => {
  it('should turn a speakerHealth event for a casting speaker into a popup notification', async () => {
    registerSession(1, 'stream-1', [KITCHEN], ['Kitchen'], ENCODER, false, 'tab');
    notifications.length = 0;

    const result = await networkEvent(speakerHealthPayload());

    expect(result).toEqual({ success: true });
    expect(notifications).toEqual([
      {
        type: 'SPEAKER_HEALTH_CHANGED',
        speakers: {
          [KITCHEN]: {
            streamId: 'stream-1',
            epochId: 1,
            state: 'low',
            reserveMs: 310,
            reserveP10Ms: 180,
            reserveAcked: true,
            targetMs: 520,
            updatedAt: NOW,
          },
        },
      },
    ]);
  });

  it('should ignore speaker health for a stream the speaker is not casting', async () => {
    registerSession(1, 'stream-2', [KITCHEN], ['Kitchen'], ENCODER, false, 'tab');
    notifications.length = 0;

    await networkEvent(speakerHealthPayload());
    await networkEvent(speakerHealthPayload({ speakerIp: '192.168.1.99' }));

    expect(getSpeakerHealth()).toEqual({});
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

    await expect(networkEvent(speakerHealthPayload({ state: 'terrible' }))).rejects.toThrow();
    expect(notifications).toEqual([]);
  });
});

describe('SONOS_EVENT route (notice-related stream events)', () => {
  const gaps = {
    type: 'ingestGaps',
    streamId: 'stream-1',
    gapsLastMinute: 3,
    worstGapMs: 280,
    smoothingMs: 200,
    suggestedSmoothingMs: 500,
    timestamp: NOW,
  };

  it('should keep an ingestGaps report for an active cast and tell the popup', async () => {
    registerSession(1, 'stream-1', [KITCHEN], ['Kitchen'], ENCODER, false, 'tab');
    notifications.length = 0;

    await streamEvent(gaps);

    expect(getIngestGaps()['stream-1']).toMatchObject({
      gapsLastMinute: 3,
      worstGapMs: 280,
      smoothingMs: 200,
      suggestedSmoothingMs: 500,
    });
    expect(notifications).toEqual([{ type: 'INGEST_GAPS_CHANGED', streams: getIngestGaps() }]);
  });

  it('should ignore ingestGaps for a stream that is not an active cast', async () => {
    await streamEvent(gaps);

    expect(getIngestGaps()).toEqual({});
    expect(notifications).toEqual([]);
  });

  it('should drop the report when its cast ends', async () => {
    registerSession(1, 'stream-1', [KITCHEN], ['Kitchen'], ENCODER, false, 'tab');
    await streamEvent(gaps);

    clearAllSessions();

    expect(getIngestGaps()).toEqual({});
  });

  it('should record companionAudioChanged and tell the popup', async () => {
    await streamEvent({
      type: 'companionAudioChanged',
      headStartMs: 750,
      headStartFixed: false,
      speakerMonitor: true,
      timestamp: NOW,
    });

    const audio = { headStartMs: 750, headStartFixed: false, speakerMonitor: true };
    expect(getConnectionState().companionAudio).toEqual(audio);
    expect(notifications).toEqual([{ type: 'COMPANION_AUDIO_CHANGED', audio }]);
  });

  it('should drop a malformed companionAudioChanged without touching the settings', async () => {
    await streamEvent({ type: 'companionAudioChanged', headStartMs: 'lots', timestamp: NOW });

    expect(getConnectionState().companionAudio).toBeNull();
    expect(notifications).toEqual([]);
  });
});

describe('WS_CONNECTED route', () => {
  const state = {
    groups: [],
    transportStates: {},
    groupVolumes: {},
    groupMutes: {},
    groupVolumeFixed: {},
  };

  it('should record the companion audio settings from INITIAL_STATE', async () => {
    const companionAudio = { headStartMs: 500, headStartFixed: true, speakerMonitor: true };
    await dispatch(
      {
        type: 'WS_CONNECTED',
        state,
        appType: 'desktop',
        appVersion: '1.0.0',
        protocolVersion: '0.5.0',
        companionAudio,
      } as never,
      SENDER,
    );

    expect(getConnectionState().companionAudio).toEqual(companionAudio);
    expect(notifications).toContainEqual({
      type: 'COMPANION_AUDIO_CHANGED',
      audio: companionAudio,
    });
  });

  it('should clear stale settings when a companion does not report them', async () => {
    await dispatch(
      {
        type: 'WS_CONNECTED',
        state,
        appType: 'server',
        appVersion: null,
        protocolVersion: null,
      } as never,
      SENDER,
    );

    expect(getConnectionState().companionAudio).toBeNull();
  });
});
