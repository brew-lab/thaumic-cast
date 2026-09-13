import { beforeEach, describe, expect, it } from 'bun:test';
import {
  createEmptySonosState,
  type PlaybackSession,
  type ZoneGroup,
} from '@thaumic-cast/protocol';

import {
  addRemoteSession,
  getSonosState,
  removeRemoteSessionForSpeaker,
  removeRemoteSessionsForStream,
  setSonosState,
  updateGroups,
  updateMute,
  updateTransportState,
  updateVolume,
  updateVolumeFixed,
} from './sonos-state';

const SPEAKER_A = '192.168.1.10';
const SPEAKER_B = '192.168.1.11';

function remote(speakerIp: string, streamId: string): PlaybackSession {
  return { streamId, speakerIp, streamUrl: '', redacted: true };
}

function own(speakerIp: string, streamId: string): PlaybackSession {
  return { streamId, speakerIp, streamUrl: `http://companion/stream/${streamId}` };
}

function group(id: string, coordinatorIp: string): ZoneGroup {
  return {
    id,
    name: id,
    coordinatorUuid: `RINCON_${id}`,
    coordinatorIp,
    members: [{ uuid: `RINCON_${id}`, ip: coordinatorIp, zoneName: id }],
  };
}

beforeEach(() => {
  setSonosState({
    ...createEmptySonosState(),
    groupVolumes: { [SPEAKER_A]: 20 },
    groupMutes: { [SPEAKER_A]: false },
    transportStates: { [SPEAKER_A]: 'Playing' },
  });
});

describe('addRemoteSession', () => {
  it('should record another client’s session as redacted with no stream URL', () => {
    addRemoteSession('alias-1', SPEAKER_A);

    expect(getSonosState().sessions).toEqual([remote(SPEAKER_A, 'alias-1')]);
  });

  it('should replace an existing remote entry for the same speaker', () => {
    addRemoteSession('alias-1', SPEAKER_A);
    addRemoteSession('alias-2', SPEAKER_A);

    expect(getSonosState().sessions).toEqual([remote(SPEAKER_A, 'alias-2')]);
  });

  it('should leave remote entries for other speakers alone', () => {
    addRemoteSession('alias-1', SPEAKER_A);
    addRemoteSession('alias-2', SPEAKER_B);

    expect(getSonosState().sessions).toEqual([
      remote(SPEAKER_A, 'alias-1'),
      remote(SPEAKER_B, 'alias-2'),
    ]);
  });
});

describe('removeRemoteSessionForSpeaker', () => {
  it('should drop the remote entry for that speaker only', () => {
    addRemoteSession('alias-1', SPEAKER_A);
    addRemoteSession('alias-2', SPEAKER_B);

    removeRemoteSessionForSpeaker(SPEAKER_A);

    expect(getSonosState().sessions).toEqual([remote(SPEAKER_B, 'alias-2')]);
  });

  it('should never remove this client’s own session on that speaker', () => {
    setSonosState({ ...getSonosState(), sessions: [own(SPEAKER_A, 'mine')] });

    removeRemoteSessionForSpeaker(SPEAKER_A);

    expect(getSonosState().sessions).toEqual([own(SPEAKER_A, 'mine')]);
  });

  it('should keep the same state object when nothing matched', () => {
    addRemoteSession('alias-1', SPEAKER_A);
    const before = getSonosState();

    removeRemoteSessionForSpeaker(SPEAKER_B);

    expect(getSonosState()).toBe(before);
  });
});

describe('removeRemoteSessionsForStream', () => {
  it('should drop every speaker the aliased stream was playing on', () => {
    setSonosState({
      ...getSonosState(),
      sessions: [
        remote(SPEAKER_A, 'alias-1'),
        remote(SPEAKER_B, 'alias-1'),
        remote('10.0.0.3', 'alias-2'),
      ],
    });

    removeRemoteSessionsForStream('alias-1');

    expect(getSonosState().sessions).toEqual([remote('10.0.0.3', 'alias-2')]);
  });

  it('should never remove this client’s own session even when the ids collide', () => {
    setSonosState({
      ...getSonosState(),
      sessions: [own(SPEAKER_A, 'shared-id'), remote(SPEAKER_B, 'shared-id')],
    });

    removeRemoteSessionsForStream('shared-id');

    expect(getSonosState().sessions).toEqual([own(SPEAKER_A, 'shared-id')]);
  });
});

describe('field updates', () => {
  it('should replace the groups without touching the rest of the snapshot', () => {
    const before = getSonosState();
    const groups = [group('kitchen', SPEAKER_A)];

    const after = updateGroups(groups);

    expect(after).not.toBe(before);
    expect(after.groups).toEqual(groups);
    expect(before.groups).toEqual([]);
    expect(after.groupVolumes).toEqual(before.groupVolumes);
  });

  it('should set one speaker’s volume and keep the others', () => {
    const before = getSonosState();

    const after = updateVolume(SPEAKER_B, 55);

    expect(after.groupVolumes).toEqual({ [SPEAKER_A]: 20, [SPEAKER_B]: 55 });
    expect(before.groupVolumes).toEqual({ [SPEAKER_A]: 20 });
  });

  it('should set one speaker’s mute state and keep the others', () => {
    const before = getSonosState();

    const after = updateMute(SPEAKER_B, true);

    expect(after.groupMutes).toEqual({ [SPEAKER_A]: false, [SPEAKER_B]: true });
    expect(before.groupMutes).toEqual({ [SPEAKER_A]: false });
  });

  it('should set one speaker’s transport state and keep the others', () => {
    const before = getSonosState();

    const after = updateTransportState(SPEAKER_A, 'Stopped');

    expect(after.transportStates).toEqual({ [SPEAKER_A]: 'Stopped' });
    expect(before.transportStates).toEqual({ [SPEAKER_A]: 'Playing' });
  });

  it('should record fixed-volume speakers separately from their volume', () => {
    const after = updateVolumeFixed(SPEAKER_A, true);

    expect(after.groupVolumeFixed).toEqual({ [SPEAKER_A]: true });
    expect(after.groupVolumes).toEqual({ [SPEAKER_A]: 20 });
  });

  it('should expose the latest snapshot through getSonosState', () => {
    const after = updateVolume(SPEAKER_A, 1);

    expect(getSonosState()).toBe(after);
  });
});
