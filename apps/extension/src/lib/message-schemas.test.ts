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
  VolumeSchema,
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
  const linkQuality = (fields: Record<string, unknown> = {}) =>
    message({
      type: 'speakerLinkQuality',
      speakerIp: SPEAKER,
      quality: 'degraded',
      rttMedianMs: 3,
      rttMaxMs: 40,
      spikesPerMinute: 2,
      failuresPerMinute: 0,
      ...fields,
    });

  it('should accept healthChanged as before', () => {
    const parsed = NetworkEventMessageSchema.parse(
      message({ type: 'healthChanged', health: 'degraded', reason: 'vpn' }),
    );

    expect(parsed.payload).toMatchObject({ type: 'healthChanged', health: 'degraded' });
  });

  it('should accept speakerLinkQuality with the protocol fields', () => {
    const parsed = NetworkEventMessageSchema.parse(linkQuality());

    expect(parsed.payload).toMatchObject({
      type: 'speakerLinkQuality',
      speakerIp: SPEAKER,
      quality: 'degraded',
      spikesPerMinute: 2,
    });
  });

  it('should reject a speakerLinkQuality event with an unknown quality', () => {
    expect(NetworkEventMessageSchema.safeParse(linkQuality({ quality: 'awful' })).success).toBe(
      false,
    );
  });

  it('should tag an unknown event type as unrecognized instead of failing', () => {
    const parsed = NetworkEventMessageSchema.parse(message({ type: 'somethingNewer', extra: 1 }));

    expect(parsed.payload).toEqual({ type: 'unrecognized', eventType: 'somethingNewer' });
  });
});
