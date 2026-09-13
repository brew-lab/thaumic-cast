import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  createEmptySonosState,
  createEncoderConfig,
  type BroadcastEvent,
  type SonosStateSnapshot,
} from '@thaumic-cast/protocol';

import type { BackgroundToPopupMessage } from '../lib/messages';
import { resetChromeStub, tabMessages } from '../test-support/chrome-stub';
import { notificationService } from './notification-service';
import { clearAllSessions, getSession, hasSession, registerSession } from './session-manager';
import { getSonosState, setSonosState } from './sonos-state';

/** Calls made to the offscreen broker, which would otherwise reach a real offscreen document. */
const broker = {
  stoppedTabs: [] as number[],
  syncedStates: [] as SonosStateSnapshot[],
};

mock.module('./offscreen-broker', () => ({
  offscreenBroker: {
    async stopSession(tabId: number): Promise<void> {
      broker.stoppedTabs.push(tabId);
    },
    syncSonosState(state: SonosStateSnapshot): void {
      broker.syncedStates.push(state);
    },
    async startPlayback(): Promise<void> {},
  },
}));

const { handleSonosEvent } = await import('./sonos-event-handlers');

const ENCODER = createEncoderConfig({ codec: 'pcm' });
const NOW = 1_700_000_000_000;

/**
 * Speaker removal is de-duplicated per address for two seconds, so every test
 * that removes a speaker gets addresses nobody else used.
 */
let ipCounter = 0;
function freshIp(): string {
  ipCounter += 1;
  return `10.1.${Math.floor(ipCounter / 256)}.${ipCounter % 256}`;
}

function streamEvent(fields: Record<string, unknown>): BroadcastEvent {
  return { category: 'stream', timestamp: NOW, ...fields } as unknown as BroadcastEvent;
}

function sonosEvent(fields: Record<string, unknown>): BroadcastEvent {
  return { category: 'sonos', timestamp: NOW, ...fields } as unknown as BroadcastEvent;
}

function registerOwnCast(tabId: number, streamId: string, speakerIps: string[]): void {
  // Distinct arrays: the session manager splices speakers and names in place.
  const speakerNames = speakerIps.map((ip) => `Speaker ${ip}`);
  registerSession(tabId, streamId, speakerIps, speakerNames, ENCODER, false, 'tab');
}

const notifications: BackgroundToPopupMessage[] = [];
let unsubscribe = (): void => {};

beforeEach(() => {
  resetChromeStub();
  clearAllSessions();
  setSonosState(createEmptySonosState());
  broker.stoppedTabs.length = 0;
  broker.syncedStates.length = 0;
  notifications.length = 0;
  unsubscribe = notificationService.subscribe((msg) => notifications.push(msg));
});

afterEach(() => {
  unsubscribe();
});

describe('stream events for other clients’ streams', () => {
  it('should record a remote session on playbackStarted and push the new state to the popup', async () => {
    const speakerIp = freshIp();

    await handleSonosEvent(
      streamEvent({ type: 'playbackStarted', streamId: 'alias-1', speakerIp, streamUrl: '' }),
    );

    expect(getSonosState().sessions).toEqual([
      { streamId: 'alias-1', speakerIp, streamUrl: '', redacted: true },
    ]);
    expect(notifications).toEqual([{ type: 'WS_STATE_CHANGED', state: getSonosState() }]);
  });

  it('should ignore playbackStarted for this client’s own stream', async () => {
    const speakerIp = freshIp();
    registerOwnCast(1, 'own-stream', [speakerIp]);
    notifications.length = 0;

    await handleSonosEvent(
      streamEvent({ type: 'playbackStarted', streamId: 'own-stream', speakerIp, streamUrl: '' }),
    );

    expect(getSonosState().sessions).toBeUndefined();
    expect(notifications).toEqual([]);
  });

  it('should forget the speaker’s remote session on playbackStopped', async () => {
    const stopped = freshIp();
    const stillPlaying = freshIp();
    await handleSonosEvent(
      streamEvent({
        type: 'playbackStarted',
        streamId: 'alias-1',
        speakerIp: stopped,
        streamUrl: '',
      }),
    );
    await handleSonosEvent(
      streamEvent({
        type: 'playbackStarted',
        streamId: 'alias-1',
        speakerIp: stillPlaying,
        streamUrl: '',
      }),
    );
    notifications.length = 0;

    await handleSonosEvent(
      streamEvent({ type: 'playbackStopped', streamId: 'alias-1', speakerIp: stopped }),
    );

    expect(getSonosState().sessions?.map((s) => s.speakerIp)).toEqual([stillPlaying]);
    expect(notifications).toEqual([{ type: 'WS_STATE_CHANGED', state: getSonosState() }]);
  });

  it('should forget every speaker of an aliased stream when it ends', async () => {
    const first = freshIp();
    const second = freshIp();
    const other = freshIp();
    await handleSonosEvent(
      streamEvent({
        type: 'playbackStarted',
        streamId: 'alias-1',
        speakerIp: first,
        streamUrl: '',
      }),
    );
    await handleSonosEvent(
      streamEvent({
        type: 'playbackStarted',
        streamId: 'alias-1',
        speakerIp: second,
        streamUrl: '',
      }),
    );
    await handleSonosEvent(
      streamEvent({
        type: 'playbackStarted',
        streamId: 'alias-2',
        speakerIp: other,
        streamUrl: '',
      }),
    );
    notifications.length = 0;

    await handleSonosEvent(streamEvent({ type: 'ended', streamId: 'alias-1' }));

    expect(getSonosState().sessions?.map((s) => s.speakerIp)).toEqual([other]);
    expect(notifications).toEqual([{ type: 'WS_STATE_CHANGED', state: getSonosState() }]);
    expect(broker.stoppedTabs).toEqual([]);
  });
});

describe('stream events for this client’s own cast', () => {
  it('should drop a taken-over speaker from a multi-speaker cast and keep casting', async () => {
    const taken = freshIp();
    const kept = freshIp();
    registerOwnCast(1, 'own-stream', [taken, kept]);
    notifications.length = 0;

    await handleSonosEvent(
      streamEvent({
        type: 'playbackStopped',
        streamId: 'own-stream',
        speakerIp: taken,
        reason: 'speaker_taken_over',
      }),
    );

    expect(getSession(1)?.speakerIps).toEqual([kept]);
    expect(broker.stoppedTabs).toEqual([]);
    expect(notifications).toContainEqual({
      type: 'SPEAKER_REMOVED',
      tabId: 1,
      speakerIp: taken,
      reason: 'speaker_taken_over',
    });
  });

  it('should stop the cast when its only speaker is taken over', async () => {
    const taken = freshIp();
    registerOwnCast(1, 'own-stream', [taken]);
    notifications.length = 0;

    await handleSonosEvent(
      streamEvent({
        type: 'playbackStopped',
        streamId: 'own-stream',
        speakerIp: taken,
        reason: 'speaker_taken_over',
      }),
    );

    expect(hasSession(1)).toBe(false);
    expect(broker.stoppedTabs).toEqual([1]);
    expect(notifications).toContainEqual({
      type: 'CAST_AUTO_STOPPED',
      tabId: 1,
      speakerIp: taken,
      reason: 'speaker_taken_over',
    });
  });

  it('should degrade a reason this build does not know to playback_stopped', async () => {
    const speakerIp = freshIp();
    registerOwnCast(1, 'own-stream', [speakerIp, freshIp()]);

    await handleSonosEvent(
      streamEvent({
        type: 'playbackStopped',
        streamId: 'own-stream',
        speakerIp,
        reason: 'solar_flare',
      }),
    );

    expect(notifications).toContainEqual({
      type: 'SPEAKER_REMOVED',
      tabId: 1,
      speakerIp,
      reason: 'playback_stopped',
    });
  });

  it('should ignore playbackStopped for a speaker the stream never played on', async () => {
    const casting = freshIp();
    registerOwnCast(1, 'own-stream', [casting]);
    notifications.length = 0;

    await handleSonosEvent(
      streamEvent({ type: 'playbackStopped', streamId: 'own-stream', speakerIp: freshIp() }),
    );

    expect(getSession(1)?.speakerIps).toEqual([casting]);
    expect(notifications).toEqual([]);
  });

  it('should stop the cast and report stream_ended when the companion ends the stream', async () => {
    const first = freshIp();
    registerOwnCast(3, 'own-stream', [first, freshIp()]);
    notifications.length = 0;

    await handleSonosEvent(streamEvent({ type: 'ended', streamId: 'own-stream' }));

    expect(hasSession(3)).toBe(false);
    expect(broker.stoppedTabs).toEqual([3]);
    expect(notifications).toContainEqual({
      type: 'CAST_AUTO_STOPPED',
      tabId: 3,
      speakerIp: first,
      reason: 'stream_ended',
    });
  });

  it('should tell the popup when a speaker could not be stopped', async () => {
    const speakerIp = freshIp();
    registerOwnCast(1, 'own-stream', [speakerIp]);
    notifications.length = 0;

    await handleSonosEvent(
      streamEvent({
        type: 'playbackStopFailed',
        streamId: 'own-stream',
        speakerIp,
        error: 'timeout',
      }),
    );

    expect(hasSession(1)).toBe(true);
    expect(notifications).toEqual([
      { type: 'SPEAKER_STOP_FAILED', tabId: 1, speakerIp, error: 'timeout' },
    ]);
  });

  it('should ignore playbackStopFailed for a stream it does not own', async () => {
    await handleSonosEvent(
      streamEvent({
        type: 'playbackStopFailed',
        streamId: 'alias-1',
        speakerIp: freshIp(),
        error: 'timeout',
      }),
    );

    expect(notifications).toEqual([]);
  });
});

describe('sonos events', () => {
  it('should apply group volume and the fixed flag and notify the popup', async () => {
    const speakerIp = freshIp();

    await handleSonosEvent(sonosEvent({ type: 'groupVolume', speakerIp, volume: 42, fixed: true }));

    expect(getSonosState().groupVolumes[speakerIp]).toBe(42);
    expect(getSonosState().groupVolumeFixed[speakerIp]).toBe(true);
    expect(notifications).toEqual([{ type: 'VOLUME_UPDATE', speakerIp, volume: 42, fixed: true }]);
  });

  it('should apply group mute and notify the popup', async () => {
    const speakerIp = freshIp();

    await handleSonosEvent(sonosEvent({ type: 'groupMute', speakerIp, muted: true }));

    expect(getSonosState().groupMutes[speakerIp]).toBe(true);
    expect(notifications).toEqual([{ type: 'MUTE_UPDATE', speakerIp, muted: true }]);
  });

  it('should replace the zone groups and push the whole state to the popup', async () => {
    const coordinatorIp = freshIp();
    const groups = [
      {
        id: 'g1',
        name: 'Kitchen',
        coordinatorUuid: 'RINCON_1',
        coordinatorIp,
        members: [{ uuid: 'RINCON_1', ip: coordinatorIp, zoneName: 'Kitchen' }],
      },
    ];

    await handleSonosEvent(sonosEvent({ type: 'zoneGroupsUpdated', groups }));

    expect(getSonosState().groups).toEqual(groups);
    expect(notifications).toEqual([{ type: 'WS_STATE_CHANGED', state: getSonosState() }]);
  });

  it('should debounce transport state and keep only the last value per speaker', async () => {
    const speakerIp = freshIp();

    await handleSonosEvent(
      sonosEvent({ type: 'transportState', speakerIp, state: 'Transitioning' }),
    );
    await handleSonosEvent(sonosEvent({ type: 'transportState', speakerIp, state: 'Playing' }));
    expect(getSonosState().transportStates[speakerIp]).toBeUndefined();

    await Bun.sleep(600);

    expect(getSonosState().transportStates[speakerIp]).toBe('Playing');
    expect(notifications).toEqual([
      { type: 'TRANSPORT_STATE_UPDATE', speakerIp, state: 'Playing' },
    ]);
    expect(broker.syncedStates).toHaveLength(1);
  });
});

describe('latency events', () => {
  it('should forward measurements to the casting tab and the popup', async () => {
    const speakerIp = freshIp();
    registerOwnCast(4, 'own-stream', [speakerIp]);
    const event = {
      category: 'latency' as const,
      type: 'updated' as const,
      streamId: 'own-stream',
      speakerIp,
      epochId: 1,
      latencyMs: 150,
      jitterMs: 5,
      confidence: 0.9,
      timestamp: NOW,
    };
    notifications.length = 0;

    await handleSonosEvent(event);

    expect(tabMessages).toEqual([{ tabId: 4, message: { type: 'LATENCY_EVENT', payload: event } }]);
    expect(notifications).toEqual([
      {
        type: 'LATENCY_UPDATE',
        streamId: 'own-stream',
        speakerIp,
        epochId: 1,
        latencyMs: 150,
        jitterMs: 5,
        confidence: 0.9,
      },
    ]);
  });

  it('should ignore latency events for streams it does not own', async () => {
    await handleSonosEvent({
      category: 'latency',
      type: 'stale',
      streamId: 'alias-1',
      speakerIp: freshIp(),
      epochId: 1,
      timestamp: NOW,
    });

    expect(tabMessages).toEqual([]);
    expect(notifications).toEqual([]);
  });
});
