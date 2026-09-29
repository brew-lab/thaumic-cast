import { describe, expect, it } from 'bun:test';

import {
  CastAutoStoppedMessageSchema,
  NetworkEventMessageSchema,
  RawMediaStateSchema,
  SpeakerIpSchema,
  SpeakerRemovedMessageSchema,
  StartCastMessageSchema,
  StartPlaybackMessageSchema,
  StopCastMessageSchema,
  TabIdSchema,
  TopologyEventMessageSchema,
  VolumeSchema,
  WsConnectedMessageSchema,
  WsStateChangedMessageSchema,
} from './message-schemas';

const SPEAKER = '192.168.1.10';

describe('primitive schemas', () => {
  it('should only accept dotted-quad speaker addresses', () => {
    expect(SpeakerIpSchema.safeParse(SPEAKER).success).toBe(true);
    expect(SpeakerIpSchema.safeParse('sonos.local').success).toBe(false);
    expect(SpeakerIpSchema.safeParse('fe80::1').success).toBe(false);
    // Digits and dots alone are not enough: it has to be four octets.
    expect(SpeakerIpSchema.safeParse('1.2.3').success).toBe(false);
    expect(SpeakerIpSchema.safeParse('1.2.3.4.5').success).toBe(false);
    expect(SpeakerIpSchema.safeParse('1..2.3.4').success).toBe(false);
  });

  it('should only accept positive integer tab ids', () => {
    expect(TabIdSchema.safeParse(1).success).toBe(true);
    expect(TabIdSchema.safeParse(0).success).toBe(false);
    expect(TabIdSchema.safeParse(1.5).success).toBe(false);
  });

  it('should keep volume to whole numbers between 0 and 100', () => {
    expect(VolumeSchema.safeParse(0).success).toBe(true);
    expect(VolumeSchema.safeParse(100).success).toBe(true);
    expect(VolumeSchema.safeParse(101).success).toBe(false);
    expect(VolumeSchema.safeParse(-1).success).toBe(false);
    expect(VolumeSchema.safeParse(33.3).success).toBe(false);
  });
});

describe('StartCastMessageSchema', () => {
  it('should require at least one valid speaker', () => {
    const message = (speakerIps: string[]) => ({ type: 'START_CAST', payload: { speakerIps } });

    expect(StartCastMessageSchema.safeParse(message([SPEAKER])).success).toBe(true);
    expect(StartCastMessageSchema.safeParse(message([])).success).toBe(false);
    expect(StartCastMessageSchema.safeParse(message(['kitchen'])).success).toBe(false);
  });

  it('should let the background choose the encoder when none is given', () => {
    const parsed = StartCastMessageSchema.parse({
      type: 'START_CAST',
      payload: { speakerIps: [SPEAKER] },
    });

    expect(parsed.payload.encoderConfig).toBeUndefined();
  });
});

describe('StopCastMessageSchema', () => {
  it('should accept a bare stop as well as a tab-specific stop', () => {
    expect(StopCastMessageSchema.safeParse({ type: 'STOP_CAST' }).success).toBe(true);
    expect(StopCastMessageSchema.safeParse({ type: 'STOP_CAST', payload: {} }).success).toBe(true);
    expect(
      StopCastMessageSchema.safeParse({ type: 'STOP_CAST', payload: { tabId: 4 } }).success,
    ).toBe(true);
  });
});

describe('StartPlaybackMessageSchema', () => {
  it('should default sync and video sync flags to off', () => {
    const parsed = StartPlaybackMessageSchema.parse({
      type: 'START_PLAYBACK',
      payload: { tabId: 4, speakerIps: [SPEAKER] },
    });

    expect(parsed.payload.syncSpeakers).toBe(false);
    expect(parsed.payload.videoSyncEnabled).toBe(false);
  });
});

describe('removal reasons', () => {
  it('should accept cast-level reasons only on CAST_AUTO_STOPPED', () => {
    const autoStopped = (reason: string) => ({
      type: 'CAST_AUTO_STOPPED',
      tabId: 4,
      speakerIp: SPEAKER,
      reason,
    });
    const removed = (reason: string) => ({
      type: 'SPEAKER_REMOVED',
      tabId: 4,
      speakerIp: SPEAKER,
      reason,
    });

    expect(CastAutoStoppedMessageSchema.safeParse(autoStopped('stream_ended')).success).toBe(true);
    expect(CastAutoStoppedMessageSchema.safeParse(autoStopped('device_disconnected')).success).toBe(
      true,
    );
    expect(SpeakerRemovedMessageSchema.safeParse(removed('stream_ended')).success).toBe(false);
  });

  it('should accept speaker_taken_over on both removal messages', () => {
    const autoStopped = {
      type: 'CAST_AUTO_STOPPED',
      tabId: 4,
      speakerIp: SPEAKER,
      reason: 'speaker_taken_over',
    };
    const removed = {
      type: 'SPEAKER_REMOVED',
      tabId: 4,
      speakerIp: SPEAKER,
      reason: 'speaker_taken_over',
    };

    expect(CastAutoStoppedMessageSchema.safeParse(autoStopped).success).toBe(true);
    expect(SpeakerRemovedMessageSchema.safeParse(removed).success).toBe(true);
  });

  it('should accept continuation_failed on both removal messages', () => {
    const autoStopped = {
      type: 'CAST_AUTO_STOPPED',
      tabId: 4,
      speakerIp: SPEAKER,
      reason: 'continuation_failed',
    };
    const removed = {
      type: 'SPEAKER_REMOVED',
      tabId: 4,
      speakerIp: SPEAKER,
      reason: 'continuation_failed',
    };

    expect(CastAutoStoppedMessageSchema.safeParse(autoStopped).success).toBe(true);
    expect(SpeakerRemovedMessageSchema.safeParse(removed).success).toBe(true);
  });

  it('should reject a reason neither message knows', () => {
    const removed = { type: 'SPEAKER_REMOVED', tabId: 4, speakerIp: SPEAKER, reason: 'gremlins' };

    expect(SpeakerRemovedMessageSchema.safeParse(removed).success).toBe(false);
  });
});

describe('WsStateChangedMessageSchema', () => {
  it('should accept a snapshot from a companion that predates sessions', () => {
    const message = {
      type: 'WS_STATE_CHANGED',
      state: { groups: [], transportStates: {}, groupVolumes: {}, groupMutes: {} },
    };

    const parsed = WsStateChangedMessageSchema.parse(message);
    expect(parsed.state.sessions).toBeUndefined();
    expect(parsed.state.groupVolumeFixed).toEqual({});
  });
});

describe('RawMediaStateSchema', () => {
  it('should default the MediaSession fields a page never set', () => {
    expect(RawMediaStateSchema.parse({ title: 'Song' })).toEqual({
      title: 'Song',
      supportedActions: [],
      playbackState: 'none',
    });
  });

  it('should reject an action the MediaSession API does not define', () => {
    expect(RawMediaStateSchema.safeParse({ supportedActions: ['rewind'] }).success).toBe(false);
  });
});

describe('NetworkEventMessageSchema', () => {
  const message = (payload: Record<string, unknown>) => ({
    type: 'NETWORK_EVENT',
    payload: { category: 'network', timestamp: 1, ...payload },
  });
  it('should accept healthChanged as before', () => {
    const parsed = NetworkEventMessageSchema.parse(
      message({ type: 'healthChanged', health: 'degraded', reason: 'vpn' }),
    );

    expect(parsed.payload).toMatchObject({ type: 'healthChanged', health: 'degraded' });
  });

  it('should tag the retired speakerLinkQuality event as unrecognized', () => {
    // An older companion still sends it; it must not fail validation.
    const parsed = NetworkEventMessageSchema.parse(
      message({ type: 'speakerLinkQuality', speakerIp: SPEAKER, quality: 'poor' }),
    );

    expect(parsed.payload).toEqual({ type: 'unrecognized', eventType: 'speakerLinkQuality' });
  });

  it('should accept speakerHealth with the protocol fields', () => {
    const parsed = NetworkEventMessageSchema.parse(
      message({
        type: 'speakerHealth',
        streamId: 'stream-1',
        speakerIp: SPEAKER,
        epochId: 2,
        state: 'low',
        reserveMs: 310,
        reserveP10Ms: 180,
        reserveAcked: true,
        targetMs: 520,
      }),
    );

    expect(parsed.payload).toMatchObject({
      type: 'speakerHealth',
      speakerIp: SPEAKER,
      state: 'low',
      reserveP10Ms: 180,
    });
  });

  it('should carry the companion notice on speakerHealth', () => {
    const notice = {
      kind: 'head_start_ran_out',
      noticeId: 4,
      stallMs: 620,
      leftMs: -120,
      headStartMs: 500,
      suggestedHeadStartMs: 750,
      restartHelps: false,
    };
    const parsed = NetworkEventMessageSchema.parse(
      message({
        type: 'speakerHealth',
        streamId: 'stream-1',
        speakerIp: SPEAKER,
        epochId: 2,
        state: 'low',
        reserveAcked: true,
        headStartMs: 500,
        floorMs: 150,
        notice,
      }),
    );

    expect(parsed.payload).toMatchObject({ type: 'speakerHealth', floorMs: 150, notice });
  });

  it('should reject a speakerHealth event with an unknown state', () => {
    expect(
      NetworkEventMessageSchema.safeParse(
        message({
          type: 'speakerHealth',
          streamId: 'stream-1',
          speakerIp: SPEAKER,
          epochId: 2,
          state: 'empty',
          reserveAcked: false,
        }),
      ).success,
    ).toBe(false);
  });

  it('should tag an unknown event type as unrecognized instead of failing', () => {
    const parsed = NetworkEventMessageSchema.parse(message({ type: 'somethingNewer', extra: 1 }));

    expect(parsed.payload).toEqual({ type: 'unrecognized', eventType: 'somethingNewer' });
  });
});

describe('TopologyEventMessageSchema', () => {
  it('should accept a groupsDiscovered event', () => {
    const parsed = TopologyEventMessageSchema.parse({
      type: 'TOPOLOGY_EVENT',
      payload: { type: 'groupsDiscovered', groups: [], timestamp: 1 },
    });

    expect(parsed.payload).toEqual({ type: 'groupsDiscovered', groups: [], timestamp: 1 });
  });

  it('should tag a memberChanged event as unrecognized instead of failing', () => {
    const parsed = TopologyEventMessageSchema.parse({
      type: 'TOPOLOGY_EVENT',
      payload: {
        type: 'memberChanged',
        change: { kind: 'satelliteMissing', primaryUuid: 'RINCON_A', uuid: 'RINCON_B', role: 'LR' },
        timestamp: 1,
      },
    });

    expect(parsed.payload).toEqual({ type: 'unrecognized', eventType: 'memberChanged' });
  });

  it('should reject a malformed groupsDiscovered event', () => {
    expect(
      TopologyEventMessageSchema.safeParse({
        type: 'TOPOLOGY_EVENT',
        payload: { type: 'groupsDiscovered', timestamp: 1 },
      }).success,
    ).toBe(false);
  });
});

describe('WsConnectedMessageSchema', () => {
  const base = {
    type: 'WS_CONNECTED',
    state: { groups: [], transportStates: {}, groupVolumes: {}, groupMutes: {} },
    appVersion: '1.0.0',
    protocolVersion: '0.5.0',
  };

  it('should accept the companion audio settings, null, or their absence', () => {
    const companionAudio = { headStartMs: 250, headStartFixed: false, speakerMonitor: true };

    expect(WsConnectedMessageSchema.parse({ ...base, companionAudio }).companionAudio).toEqual(
      companionAudio,
    );
    expect(WsConnectedMessageSchema.parse({ ...base, companionAudio: null }).companionAudio).toBe(
      null,
    );
    expect(WsConnectedMessageSchema.parse(base).companionAudio).toBeUndefined();
  });
});
