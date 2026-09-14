import { describe, expect, it } from 'bun:test';

import {
  BroadcastEventSchema,
  LatencyEventSchema,
  parseSonosEvent,
  SpeakerRemovalReasonSchema,
  StreamEventSchema,
  NetworkEventSchema,
  type LatencyEvent,
  type SonosEvent,
  type StreamEvent,
} from './events.js';

const SPEAKER = '192.168.1.10';
const NOW = 1_700_000_000_000;

describe('parseSonosEvent', () => {
  it('should return a typed transportState event', () => {
    const event: SonosEvent = {
      type: 'transportState',
      speakerIp: SPEAKER,
      state: 'Playing',
      timestamp: NOW,
    };

    expect(parseSonosEvent(event)).toEqual(event);
  });

  it('should keep the optional fixed flag on groupVolume events', () => {
    const event: SonosEvent = {
      type: 'groupVolume',
      speakerIp: SPEAKER,
      volume: 25,
      fixed: true,
      timestamp: NOW,
    };

    expect(parseSonosEvent(event)).toEqual(event);
  });

  it('should accept groupVolume events that omit the fixed flag', () => {
    const event: SonosEvent = {
      type: 'groupVolume',
      speakerIp: SPEAKER,
      volume: 25,
      timestamp: NOW,
    };

    expect(parseSonosEvent(event)).toEqual(event);
  });

  it('should parse zoneGroupsUpdated with its nested groups', () => {
    const event: SonosEvent = {
      type: 'zoneGroupsUpdated',
      groups: [
        {
          id: 'g1',
          name: 'Kitchen',
          coordinatorUuid: 'RINCON_1',
          coordinatorIp: SPEAKER,
          members: [{ uuid: 'RINCON_1', ip: SPEAKER, zoneName: 'Kitchen' }],
        },
      ],
      timestamp: NOW,
    };

    expect(parseSonosEvent(event)).toEqual(event);
  });

  it('should return null for an event type it does not know', () => {
    expect(parseSonosEvent({ type: 'bass', speakerIp: SPEAKER, timestamp: NOW })).toBeNull();
  });

  it('should return null when a required field is missing', () => {
    expect(
      parseSonosEvent({ type: 'transportState', speakerIp: SPEAKER, timestamp: NOW }),
    ).toBeNull();
  });

  it('should return null for an unknown transport state', () => {
    const event = {
      type: 'transportState',
      speakerIp: SPEAKER,
      state: 'Buffering',
      timestamp: NOW,
    };

    expect(parseSonosEvent(event)).toBeNull();
  });

  it('should return null for non-object input', () => {
    expect(parseSonosEvent('transportState')).toBeNull();
    expect(parseSonosEvent(null)).toBeNull();
  });
});

describe('StreamEventSchema', () => {
  it('should accept created and ended events that only name the stream', () => {
    expect(
      StreamEventSchema.safeParse({ type: 'created', streamId: 's1', timestamp: NOW }).success,
    ).toBe(true);
    expect(
      StreamEventSchema.safeParse({ type: 'ended', streamId: 's1', timestamp: NOW }).success,
    ).toBe(true);
  });

  it('should require the stream URL on playbackStarted', () => {
    const withoutUrl = {
      type: 'playbackStarted',
      streamId: 's1',
      speakerIp: SPEAKER,
      timestamp: NOW,
    };
    const withUrl = { ...withoutUrl, streamUrl: 'http://companion/stream/s1' };

    expect(StreamEventSchema.safeParse(withUrl).success).toBe(true);
    expect(StreamEventSchema.safeParse(withoutUrl).success).toBe(false);
  });

  it('should accept playbackStopped without a reason for older companions', () => {
    const event: StreamEvent = {
      type: 'playbackStopped',
      streamId: 's1',
      speakerIp: SPEAKER,
      timestamp: NOW,
    };

    expect(StreamEventSchema.parse(event)).toEqual(event);
  });

  it('should accept speaker_taken_over as a playbackStopped reason', () => {
    const event = {
      type: 'playbackStopped',
      streamId: 's1',
      speakerIp: SPEAKER,
      reason: 'speaker_taken_over',
      timestamp: NOW,
    };

    const parsed = StreamEventSchema.parse(event);
    expect(parsed.type === 'playbackStopped' && parsed.reason).toBe('speaker_taken_over');
  });

  it('should reject a playbackStopped reason it does not know', () => {
    const event = {
      type: 'playbackStopped',
      streamId: 's1',
      speakerIp: SPEAKER,
      reason: 'meteor_strike',
      timestamp: NOW,
    };

    expect(StreamEventSchema.safeParse(event).success).toBe(false);
  });

  it('should require an error message on playbackStopFailed', () => {
    const base = { type: 'playbackStopFailed', streamId: 's1', speakerIp: SPEAKER, timestamp: NOW };

    expect(StreamEventSchema.safeParse({ ...base, error: 'timeout' }).success).toBe(true);
    expect(StreamEventSchema.safeParse(base).success).toBe(false);
  });

  it('should reject an unknown stream event type', () => {
    expect(
      StreamEventSchema.safeParse({ type: 'paused', streamId: 's1', timestamp: NOW }).success,
    ).toBe(false);
  });
});

describe('SpeakerRemovalReasonSchema', () => {
  it('should accept every reason the companion can send for a speaker', () => {
    for (const reason of [
      'source_changed',
      'playback_stopped',
      'speaker_stopped',
      'speaker_taken_over',
      'user_removed',
    ]) {
      expect(SpeakerRemovalReasonSchema.safeParse(reason).success).toBe(true);
    }
  });

  it('should reject the cast-level stream_ended reason', () => {
    expect(SpeakerRemovalReasonSchema.safeParse('stream_ended').success).toBe(false);
  });
});

describe('BroadcastEventSchema', () => {
  it('should pass the nested event fields through for each category', () => {
    const sonos = {
      category: 'sonos',
      type: 'groupMute',
      speakerIp: SPEAKER,
      muted: true,
      timestamp: NOW,
    } as const;
    const stream = { category: 'stream', type: 'ended', streamId: 's1', timestamp: NOW } as const;
    const latency = {
      category: 'latency',
      type: 'stale',
      streamId: 's1',
      speakerIp: SPEAKER,
      epochId: 2,
      timestamp: NOW,
    } as const;

    expect(BroadcastEventSchema.parse(sonos)).toEqual(sonos);
    expect(BroadcastEventSchema.parse(stream)).toEqual(stream);
    expect(BroadcastEventSchema.parse(latency)).toEqual(latency);
  });

  it('should reject an unknown category', () => {
    expect(BroadcastEventSchema.safeParse({ category: 'weather', type: 'rain' }).success).toBe(
      false,
    );
  });
});

describe('LatencyEventSchema', () => {
  const updated: LatencyEvent = {
    type: 'updated',
    streamId: 's1',
    speakerIp: SPEAKER,
    epochId: 0,
    latencyMs: 180,
    jitterMs: 12,
    confidence: 0.75,
    timestamp: NOW,
  };

  it('should accept a measurement with confidence inside [0, 1]', () => {
    expect(LatencyEventSchema.parse(updated)).toEqual(updated);
  });

  it('should reject confidence outside [0, 1]', () => {
    expect(LatencyEventSchema.safeParse({ ...updated, confidence: 1.5 }).success).toBe(false);
    expect(LatencyEventSchema.safeParse({ ...updated, confidence: -0.1 }).success).toBe(false);
  });

  it('should reject negative or fractional epoch and latency values', () => {
    expect(LatencyEventSchema.safeParse({ ...updated, epochId: -1 }).success).toBe(false);
    expect(LatencyEventSchema.safeParse({ ...updated, latencyMs: 12.5 }).success).toBe(false);
  });

  it('should accept a stale event that carries no measurements', () => {
    const stale: LatencyEvent = {
      type: 'stale',
      streamId: 's1',
      speakerIp: SPEAKER,
      epochId: 3,
      timestamp: NOW,
    };

    expect(LatencyEventSchema.parse(stale)).toEqual(stale);
  });
});

describe('NetworkEventSchema', () => {
  it('should parse a speaker link quality event', () => {
    const parsed = NetworkEventSchema.safeParse({
      type: 'speakerLinkQuality',
      speakerIp: '192.168.1.10',
      quality: 'poor',
      rttMedianMs: 12,
      rttMaxMs: 215,
      spikesPerMinute: 7,
      failuresPerMinute: 1,
      jitterBufferMs: 200,
      suggestedJitterBufferMs: 500,
      timestamp: NOW,
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.type === 'speakerLinkQuality') {
      expect(parsed.data.quality).toBe('poor');
    }
  });

  it('should reject a link quality it does not know', () => {
    const parsed = NetworkEventSchema.safeParse({
      type: 'speakerLinkQuality',
      speakerIp: '192.168.1.10',
      quality: 'terrible',
      rttMedianMs: 12,
      rttMaxMs: 215,
      spikesPerMinute: 7,
      failuresPerMinute: 1,
      jitterBufferMs: 200,
      timestamp: NOW,
    });
    expect(parsed.success).toBe(false);
  });

  it('should still parse the health change event', () => {
    expect(
      NetworkEventSchema.safeParse({ type: 'healthChanged', health: 'degraded', timestamp: NOW })
        .success,
    ).toBe(true);
  });

  it('should accept network and topology broadcast categories', () => {
    expect(BroadcastEventSchema.safeParse({ category: 'network', type: 'x' }).success).toBe(true);
    expect(BroadcastEventSchema.safeParse({ category: 'topology', type: 'x' }).success).toBe(true);
  });
});
