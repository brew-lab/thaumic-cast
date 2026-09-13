import { describe, expect, it } from 'bun:test';

import {
  countRemoteStreams,
  createEmptySonosState,
  getSpeakerAvailability,
  getSpeakerStatus,
  InitialStatePayloadSchema,
  isRemoteSession,
  isSpeakerPlaying,
  PlaybackSessionSchema,
  SonosStateSnapshotSchema,
  type PlaybackSession,
  type SonosStateSnapshot,
  type TransportState,
} from './sonos.js';

const SPEAKER = '192.168.1.10';
const OTHER_SPEAKER = '192.168.1.11';

function snapshot(overrides: Partial<SonosStateSnapshot> = {}): SonosStateSnapshot {
  return { ...createEmptySonosState(), ...overrides };
}

function playing(...speakerIps: string[]): Record<string, TransportState> {
  return Object.fromEntries(speakerIps.map((ip) => [ip, 'Playing' as const]));
}

function remoteSession(speakerIp: string, streamId = `alias-${speakerIp}`): PlaybackSession {
  return { streamId, speakerIp, streamUrl: '', redacted: true };
}

function ownSession(speakerIp: string, streamId = 'own-stream'): PlaybackSession {
  return { streamId, speakerIp, streamUrl: `http://companion/stream/${streamId}` };
}

describe('getSpeakerAvailability', () => {
  it('should report available when the speaker has no transport state', () => {
    expect(getSpeakerAvailability(SPEAKER, snapshot(), [])).toBe('available');
  });

  it('should report available when the speaker is stopped or paused', () => {
    const stopped = snapshot({ transportStates: { [SPEAKER]: 'Stopped' } });
    const paused = snapshot({ transportStates: { [SPEAKER]: 'PAUSED_PLAYBACK' } });

    expect(getSpeakerAvailability(SPEAKER, stopped, [])).toBe('available');
    expect(getSpeakerAvailability(SPEAKER, paused, [])).toBe('available');
  });

  it('should report in_use when the speaker plays something no session accounts for', () => {
    const state = snapshot({ transportStates: playing(SPEAKER) });

    expect(getSpeakerAvailability(SPEAKER, state, [])).toBe('in_use');
  });

  it('should report casting when this client is casting to the speaker', () => {
    const state = snapshot({ transportStates: playing(SPEAKER) });

    expect(getSpeakerAvailability(SPEAKER, state, [SPEAKER])).toBe('casting');
  });

  it('should report remote_cast when another client holds the speaker', () => {
    const state = snapshot({
      transportStates: playing(SPEAKER),
      sessions: [remoteSession(SPEAKER)],
    });

    expect(getSpeakerAvailability(SPEAKER, state, [])).toBe('remote_cast');
  });

  it('should rank this client’s own cast above a remote session on the same speaker', () => {
    const state = snapshot({
      transportStates: playing(SPEAKER),
      sessions: [remoteSession(SPEAKER)],
    });

    expect(getSpeakerAvailability(SPEAKER, state, [SPEAKER])).toBe('casting');
  });

  it('should rank a remote session above plain in_use playback', () => {
    const state = snapshot({
      transportStates: playing(SPEAKER),
      sessions: [remoteSession(SPEAKER)],
    });

    expect(getSpeakerAvailability(SPEAKER, state, [])).not.toBe('in_use');
  });

  it('should retire a remote session once its speaker reads Stopped', () => {
    const state = snapshot({
      transportStates: { [SPEAKER]: 'Stopped' },
      sessions: [remoteSession(SPEAKER)],
    });

    expect(getSpeakerAvailability(SPEAKER, state, [])).toBe('available');
  });

  it('should keep a remote session while its speaker is still transitioning', () => {
    const state = snapshot({
      transportStates: { [SPEAKER]: 'Transitioning' },
      sessions: [remoteSession(SPEAKER)],
    });

    expect(getSpeakerAvailability(SPEAKER, state, [])).toBe('remote_cast');
  });

  it('should never treat a non-redacted session as another client’s cast', () => {
    const state = snapshot({
      transportStates: playing(SPEAKER),
      sessions: [ownSession(SPEAKER)],
    });

    expect(getSpeakerAvailability(SPEAKER, state, [])).toBe('in_use');
  });

  it('should only consider sessions that name the requested speaker', () => {
    const state = snapshot({
      transportStates: playing(SPEAKER, OTHER_SPEAKER),
      sessions: [remoteSession(OTHER_SPEAKER)],
    });

    expect(getSpeakerAvailability(SPEAKER, state, [])).toBe('in_use');
    expect(getSpeakerAvailability(OTHER_SPEAKER, state, [])).toBe('remote_cast');
  });
});

describe('countRemoteStreams', () => {
  it('should return zero when the snapshot carries no sessions', () => {
    expect(countRemoteStreams(snapshot())).toBe(0);
    expect(countRemoteStreams(snapshot({ sessions: [] }))).toBe(0);
  });

  it('should count one stream that plays on several speakers once', () => {
    const state = snapshot({
      transportStates: playing(SPEAKER, OTHER_SPEAKER),
      sessions: [remoteSession(SPEAKER, 'alias-1'), remoteSession(OTHER_SPEAKER, 'alias-1')],
    });

    expect(countRemoteStreams(state)).toBe(1);
  });

  it('should count distinct streams separately', () => {
    const state = snapshot({
      transportStates: playing(SPEAKER, OTHER_SPEAKER),
      sessions: [remoteSession(SPEAKER, 'alias-1'), remoteSession(OTHER_SPEAKER, 'alias-2')],
    });

    expect(countRemoteStreams(state)).toBe(2);
  });

  it('should ignore a session whose speaker has stopped', () => {
    const state = snapshot({
      transportStates: { [SPEAKER]: 'Stopped' },
      sessions: [remoteSession(SPEAKER)],
    });

    expect(countRemoteStreams(state)).toBe(0);
  });

  it('should still count a stream while at least one of its speakers plays', () => {
    const state = snapshot({
      transportStates: { [SPEAKER]: 'Stopped', [OTHER_SPEAKER]: 'Playing' },
      sessions: [remoteSession(SPEAKER, 'alias-1'), remoteSession(OTHER_SPEAKER, 'alias-1')],
    });

    expect(countRemoteStreams(state)).toBe(1);
  });

  it('should count a session whose speaker has no transport state yet', () => {
    const state = snapshot({ sessions: [remoteSession(SPEAKER)] });

    expect(countRemoteStreams(state)).toBe(1);
  });

  it('should ignore streams on speakers this client has taken over', () => {
    const state = snapshot({
      transportStates: playing(SPEAKER, OTHER_SPEAKER),
      sessions: [remoteSession(SPEAKER, 'alias-1'), remoteSession(OTHER_SPEAKER, 'alias-2')],
    });

    expect(countRemoteStreams(state, [SPEAKER])).toBe(1);
  });

  it('should ignore this client’s own sessions', () => {
    const state = snapshot({
      transportStates: playing(SPEAKER),
      sessions: [ownSession(SPEAKER)],
    });

    expect(countRemoteStreams(state)).toBe(0);
  });
});

describe('isRemoteSession', () => {
  it('should be true only when the companion flagged the session as redacted', () => {
    expect(isRemoteSession(remoteSession(SPEAKER))).toBe(true);
    expect(isRemoteSession(ownSession(SPEAKER))).toBe(false);
    expect(isRemoteSession({ ...ownSession(SPEAKER), redacted: false })).toBe(false);
  });
});

describe('transport state helpers', () => {
  it('should map transport states onto their display labels', () => {
    const state = snapshot({
      transportStates: { [SPEAKER]: 'PAUSED_PLAYBACK', [OTHER_SPEAKER]: 'Transitioning' },
    });

    expect(getSpeakerStatus(SPEAKER, state)).toBe('Paused');
    expect(getSpeakerStatus(OTHER_SPEAKER, state)).toBe('Loading');
    expect(getSpeakerStatus('10.0.0.1', state)).toBeUndefined();
  });

  it('should report playing only for the Playing state', () => {
    const state = snapshot({
      transportStates: { [SPEAKER]: 'Playing', [OTHER_SPEAKER]: 'Transitioning' },
    });

    expect(isSpeakerPlaying(SPEAKER, state)).toBe(true);
    expect(isSpeakerPlaying(OTHER_SPEAKER, state)).toBe(false);
    expect(isSpeakerPlaying('10.0.0.1', state)).toBe(false);
  });
});

describe('PlaybackSessionSchema', () => {
  it('should accept a session without the redacted flag', () => {
    const parsed = PlaybackSessionSchema.parse(ownSession(SPEAKER));

    expect(parsed).toEqual(ownSession(SPEAKER));
    expect('redacted' in parsed).toBe(false);
  });

  it('should preserve the redacted flag on another client’s session', () => {
    expect(PlaybackSessionSchema.parse(remoteSession(SPEAKER)).redacted).toBe(true);
  });

  it('should require streamUrl even for redacted sessions', () => {
    const withoutUrl = { streamId: 'alias-1', speakerIp: SPEAKER, redacted: true };

    expect(PlaybackSessionSchema.safeParse(withoutUrl).success).toBe(false);
  });
});

describe('SonosStateSnapshotSchema', () => {
  const legacySnapshot = {
    groups: [],
    transportStates: { [SPEAKER]: 'Playing' },
    groupVolumes: { [SPEAKER]: 30 },
    groupMutes: { [SPEAKER]: false },
  };

  it('should default groupVolumeFixed for companions that predate it', () => {
    expect(SonosStateSnapshotSchema.parse(legacySnapshot).groupVolumeFixed).toEqual({});
  });

  it('should leave sessions absent for companions that predate them', () => {
    const parsed = SonosStateSnapshotSchema.parse(legacySnapshot);

    expect(parsed.sessions).toBeUndefined();
    expect(countRemoteStreams(parsed)).toBe(0);
    expect(getSpeakerAvailability(SPEAKER, parsed, [])).toBe('in_use');
  });

  it('should round-trip a snapshot that carries every field', () => {
    const full = snapshot({
      groups: [
        {
          id: 'group-1',
          name: 'Kitchen',
          coordinatorUuid: 'RINCON_1',
          coordinatorIp: SPEAKER,
          members: [{ uuid: 'RINCON_1', ip: SPEAKER, zoneName: 'Kitchen', model: 'One' }],
        },
      ],
      transportStates: playing(SPEAKER),
      groupVolumes: { [SPEAKER]: 42 },
      groupMutes: { [SPEAKER]: true },
      groupVolumeFixed: { [SPEAKER]: false },
      sessions: [remoteSession(SPEAKER), ownSession(OTHER_SPEAKER)],
    });

    expect(SonosStateSnapshotSchema.parse(full)).toEqual(full);
  });

  it('should reject an unknown transport state', () => {
    const invalid = { ...legacySnapshot, transportStates: { [SPEAKER]: 'Rewinding' } };

    expect(SonosStateSnapshotSchema.safeParse(invalid).success).toBe(false);
  });
});

describe('InitialStatePayloadSchema', () => {
  const base = {
    groups: [],
    transportStates: {},
    groupVolumes: {},
    groupMutes: {},
  };

  it('should leave version metadata undefined for pre-0.4.0 companions', () => {
    const parsed = InitialStatePayloadSchema.parse(base);

    expect(parsed.protocolVersion).toBeUndefined();
    expect(parsed.appVersion).toBeUndefined();
    expect(parsed.appType).toBeUndefined();
  });

  it('should keep recognised version metadata', () => {
    const parsed = InitialStatePayloadSchema.parse({
      ...base,
      protocolVersion: '0.5.0',
      appVersion: '1.2.3',
      appType: 'server',
    });

    expect(parsed).toMatchObject({
      protocolVersion: '0.5.0',
      appVersion: '1.2.3',
      appType: 'server',
    });
  });

  it('should degrade an unrecognised appType to undefined instead of failing', () => {
    const parsed = InitialStatePayloadSchema.safeParse({ ...base, appType: 'cli' });

    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.appType).toBeUndefined();
  });
});

describe('createEmptySonosState', () => {
  it('should produce a snapshot with no groups, no state and no sessions', () => {
    const empty = createEmptySonosState();

    expect(empty.groups).toEqual([]);
    expect(empty.transportStates).toEqual({});
    expect(empty.sessions).toBeUndefined();
  });
});
