import { describe, expect, it } from 'bun:test';

import {
  BroadcastEventSchema,
  LatencyEventSchema,
  parseSonosEvent,
  SpeakerRemovalReasonSchema,
  StreamEventSchema,
  NetworkEventSchema,
  SpeakerHealthStateSchema,
  SpeakerNoticeKindSchema,
  type LatencyEvent,
  type NetworkEvent,
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

  it('should parse ingestGaps exactly as thaumic-core serializes it', () => {
    const withSuggestion = {
      type: 'ingestGaps',
      streamId: 's1',
      gapsLastMinute: 2,
      worstGapMs: 280,
      smoothingMs: 200,
      suggestedSmoothingMs: 500,
      timestamp: NOW,
    } satisfies StreamEvent;
    expect(StreamEventSchema.parse(withSuggestion)).toEqual(withSuggestion);

    // No step covers the gap: the suggestion is omitted.
    const parsed = StreamEventSchema.parse({
      ...withSuggestion,
      worstGapMs: 620,
      suggestedSmoothingMs: undefined,
    });
    expect(parsed.type === 'ingestGaps' && parsed.suggestedSmoothingMs).toBeUndefined();
  });

  it('should parse companionAudioChanged with its settings flattened in', () => {
    const event = {
      type: 'companionAudioChanged',
      headStartMs: 750,
      headStartFixed: true,
      speakerMonitor: false,
      timestamp: NOW,
    } satisfies StreamEvent;
    expect(StreamEventSchema.parse(event)).toEqual(event);
    expect(StreamEventSchema.safeParse({ ...event, headStartMs: 2001 }).success).toBe(false);
  });

  it('should degrade a drift mode it does not know instead of failing', () => {
    const parsed = StreamEventSchema.parse({
      type: 'companionAudioChanged',
      headStartMs: 0,
      headStartFixed: false,
      speakerMonitor: true,
      driftCompensation: 'turbo',
      timestamp: NOW,
    });
    expect(parsed.type === 'companionAudioChanged' && parsed.driftCompensation).toBeUndefined();
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
  const draining = {
    type: 'speakerHealth',
    streamId: 's1',
    speakerIp: SPEAKER,
    epochId: 3,
    state: 'draining',
    reserveMs: 512,
    reservePrecisionMs: 34,
    reserveMinMs: 431,
    reserveP10Ms: 470,
    reserveAcked: true,
    targetMs: 540,
    clockPpm: 39.75,
    clockSePpm: 7.25,
    headStartMs: 500,
    headStartConfiguredMs: 500,
    floorMs: 150,
    stallMs: 40,
    timeToFloorS: 900,
    notice: {
      kind: 'drift_uncorrected',
      noticeId: 2,
      headStartMs: 500,
      minutes: 15,
      restartHelps: true,
    },
    timestamp: NOW,
  } satisfies NetworkEvent;

  it('should parse a speaker health event with every figure', () => {
    expect(NetworkEventSchema.parse(draining)).toEqual(draining);
  });

  it('should parse a speaker health event that has no figures yet', () => {
    const locking: NetworkEvent = {
      type: 'speakerHealth',
      streamId: 's1',
      speakerIp: SPEAKER,
      epochId: 3,
      state: 'locking',
      reserveAcked: false,
      timestamp: NOW,
    };
    expect(NetworkEventSchema.parse(locking)).toEqual(locking);
  });

  it('should accept a reserve below zero and a speaker slower than the companion', () => {
    // The reserve's zero is only approximate, and a slow speaker fills it.
    const parsed = NetworkEventSchema.safeParse({ ...draining, reserveMs: -20, clockPpm: -40.5 });
    expect(parsed.success).toBe(true);
  });

  it('should reject a speaker health state it does not know', () => {
    expect(NetworkEventSchema.safeParse({ ...draining, state: 'empty' }).success).toBe(false);
  });

  it('should reject fractional reserve figures', () => {
    expect(NetworkEventSchema.safeParse({ ...draining, reserveMs: 512.5 }).success).toBe(false);
    expect(NetworkEventSchema.safeParse({ ...draining, timeToFloorS: -1 }).success).toBe(false);
  });

  it('should know every state the companion sends', () => {
    // Mirrors SpeakerHealthState in thaumic-core's events module.
    expect(SpeakerHealthStateSchema.options).toEqual([
      'locking',
      'ok',
      'draining',
      'low',
      'paused',
      'stale',
      'dormant',
    ]);
  });

  it('should parse the notice exactly as thaumic-core serializes it', () => {
    // Mirrors the wire test in thaumic-core's events module: optional figures
    // are omitted, not null.
    const ranOut = {
      ...draining,
      state: 'low',
      notice: {
        kind: 'head_start_ran_out',
        noticeId: 7,
        stallMs: 620,
        leftMs: -120,
        headStartMs: 500,
        suggestedHeadStartMs: 750,
        restartHelps: true,
      },
    } satisfies NetworkEvent;
    expect(NetworkEventSchema.parse(ranOut)).toEqual(ranOut);
  });

  it('should drop a notice it cannot read and keep the rest of the report', () => {
    const parsed = NetworkEventSchema.parse({
      ...draining,
      notice: { kind: 'speaker_on_fire', noticeId: 1, restartHelps: false },
    });
    expect(parsed.type === 'speakerHealth' && parsed.notice).toBeUndefined();
    expect(parsed.type === 'speakerHealth' && parsed.floorMs).toBe(150);
  });

  it('should know every notice kind the companion sends', () => {
    // Mirrors SpeakerNoticeKind in thaumic-core's speaker monitor, plus the
    // drift correction kind that arrives with it.
    expect(SpeakerNoticeKindSchema.options).toEqual([
      'head_start_ran_out',
      'head_start_close',
      'head_start_no_remedy',
      'running_low',
      'drift_uncorrected',
      'drift_saturated',
    ]);
  });

  it('should no longer know the link quality event', () => {
    const parsed = NetworkEventSchema.safeParse({
      type: 'speakerLinkQuality',
      speakerIp: SPEAKER,
      quality: 'poor',
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
