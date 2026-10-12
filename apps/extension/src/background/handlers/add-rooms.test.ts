import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createEmptySonosState, createEncoderConfig, type ZoneGroup } from '@thaumic-cast/protocol';

import { resetChromeStub } from '../../test-support/chrome-stub';
// The broker is mocked for every test file: test-support/offscreen-broker-mock.ts.
import {
  brokerCalls,
  brokerReplies,
  resetBrokerCalls,
} from '../../test-support/offscreen-broker-mock';
import { clearConnectionState, setDesktopApp } from '../connection-state';
import { clearAllSessions, getActiveCasts, getSession, registerSession } from '../session-manager';
import { setSonosState } from '../sonos-state';
import { handleAddRooms } from './cast';

const ENCODER = createEncoderConfig({ codec: 'pcm' });
const KITCHEN = '192.168.1.10';
const PATIO = '192.168.1.11';
const STUDY = '192.168.1.12';
const OFFICE = '192.168.1.13';

/**
 * A Sonos group.
 * @param members - Room names and IPs, the coordinator first
 * @returns The group
 */
function group(...members: [string, string][]): ZoneGroup {
  const [coordinatorName, coordinatorIp] = members[0];
  return {
    id: `${coordinatorName}:1`,
    name: coordinatorName,
    coordinatorUuid: `RINCON_${coordinatorName.toUpperCase()}`,
    coordinatorIp,
    members: members.map(([name, ip]) => ({
      uuid: `RINCON_${name.toUpperCase()}`,
      ip,
      zoneName: name,
    })),
  };
}

const add = (roomIds: string[], startLevels?: Record<string, number>) =>
  handleAddRooms({ type: 'ADD_ROOMS', payload: { tabId: 1, roomIds, startLevels } });

beforeEach(() => {
  resetChromeStub();
  resetBrokerCalls();
  clearAllSessions();
  setSonosState({
    ...createEmptySonosState(),
    groups: [
      group(['Kitchen', KITCHEN], ['Patio', PATIO]),
      group(['Study', STUDY]),
      group(['Office', OFFICE]),
    ],
  });
  registerSession(1, 'stream-1', [KITCHEN], ['Kitchen'], ENCODER, false, 'tab', false, {
    ids: ['RINCON_KITCHEN'],
    targets: { RINCON_KITCHEN: KITCHEN },
  });
});

describe('handleAddRooms with an older companion', () => {
  it('should play an added room on its own stream, not joined, at its start level', async () => {
    brokerReplies.playbackResult = (speakerIp) => ({ speakerIp, success: true });

    const response = await add(['RINCON_STUDY'], { RINCON_STUDY: 25 });

    expect(response).toEqual({ success: true, rooms: [{ roomId: 'RINCON_STUDY', joined: true }] });
    expect(brokerCalls.startedPlayback).toEqual([
      { tabId: 1, speakerIps: [STUDY], startVolume: { limit: 30, rooms: { RINCON_STUDY: 25 } } },
    ]);
    expect(getSession(1)?.speakerIps).toEqual([KITCHEN, STUDY]);
    expect(getActiveCasts()[0].roomIds).toEqual(['RINCON_KITCHEN', 'RINCON_STUDY']);
  });

  it('should add a room whose group already plays the cast without starting anything', async () => {
    const response = await add(['RINCON_PATIO']);

    expect(response).toEqual({ success: true, rooms: [{ roomId: 'RINCON_PATIO', joined: true }] });
    expect(brokerCalls.startedPlayback).toEqual([]);
    expect(getActiveCasts()[0].roomIds).toEqual(['RINCON_KITCHEN', 'RINCON_PATIO']);
  });

  it('should say which rooms did not join, and keep the others', async () => {
    brokerReplies.playbackResult = (speakerIp) =>
      speakerIp === STUDY
        ? { speakerIp, success: true }
        : { speakerIp, success: false, error: 'No answer' };

    const response = await add(['RINCON_STUDY', 'RINCON_OFFICE']);

    expect(response).toEqual({
      success: true,
      rooms: [
        { roomId: 'RINCON_STUDY', joined: true },
        { roomId: 'RINCON_OFFICE', joined: false, error: 'No answer' },
      ],
    });
    expect(getSession(1)?.speakerIps).toEqual([KITCHEN, STUDY]);
  });

  it('should fail every room when the offscreen document does not answer', async () => {
    const response = await add(['RINCON_STUDY']);

    expect(response).toEqual({
      success: false,
      rooms: [{ roomId: 'RINCON_STUDY', joined: false, error: 'error_playback_failed' }],
    });
    expect(getSession(1)?.speakerIps).toEqual([KITCHEN]);
  });

  it('should refuse a cast that is not running, or rooms that are not here', async () => {
    expect(
      await handleAddRooms({ type: 'ADD_ROOMS', payload: { tabId: 9, roomIds: ['RINCON_STUDY'] } }),
    ).toMatchObject({ success: false, rooms: [] });
    expect(await add(['RINCON_GONE'])).toMatchObject({
      success: false,
      error: 'error_no_speakers_selected',
    });
  });
});

describe('handleAddRooms with a companion that regroups', () => {
  beforeEach(() => {
    clearConnectionState();
    setDesktopApp('http://localhost:49400', 10, 'desktop', undefined, true);
    clearAllSessions();
    // Kitchen and Study were cast as one Sonos group.
    registerSession(
      1,
      'stream-1',
      [KITCHEN, STUDY],
      ['Kitchen', 'Study'],
      ENCODER,
      true,
      'tab',
      false,
      {
        ids: ['RINCON_KITCHEN', 'RINCON_STUDY'],
        targets: { RINCON_KITCHEN: KITCHEN, RINCON_STUDY: STUDY },
      },
    );
  });

  afterEach(() => clearConnectionState());

  it("should send a grouped room by its own IP and UUID, to join the cast's group", async () => {
    brokerReplies.playbackResult = (speakerIp) => ({ speakerIp, success: true });

    // Patio is in Kitchen's old Sonos group, which the cast did not take.
    const response = await add(['RINCON_PATIO'], { RINCON_PATIO: 20 });

    expect(response).toEqual({ success: true, rooms: [{ roomId: 'RINCON_PATIO', joined: true }] });
    expect(brokerCalls.startedPlayback).toEqual([
      {
        tabId: 1,
        speakerIps: [PATIO],
        rooms: ['RINCON_PATIO'],
        startVolume: { limit: 30, rooms: { RINCON_PATIO: 20 } },
      },
    ]);
    expect(getSession(1)?.speakerIps).toEqual([KITCHEN, STUDY, PATIO]);
    expect(getSession(1)?.speakerNames).toEqual(['Kitchen', 'Study', 'Patio']);
    expect(getSession(1)?.roomTargets.RINCON_PATIO).toBe(PATIO);
  });

  it('should add a room already in the cast at once, and say which rooms did not join', async () => {
    brokerReplies.playbackResult = (speakerIp) => ({
      speakerIp,
      success: false,
      error: 'Failed to join group: refused',
    });

    const response = await add(['RINCON_STUDY', 'RINCON_OFFICE']);

    expect(response).toEqual({
      success: true,
      rooms: [
        { roomId: 'RINCON_STUDY', joined: true },
        { roomId: 'RINCON_OFFICE', joined: false, error: 'Failed to join group: refused' },
      ],
    });
    expect(brokerCalls.startedPlayback.map((call) => call.rooms)).toEqual([['RINCON_OFFICE']]);
    expect(getSession(1)?.speakerIps).toEqual([KITCHEN, STUDY]);
  });

  it('should keep the older way for a cast that was not played as one group', async () => {
    brokerReplies.playbackResult = (speakerIp) => ({ speakerIp, success: true });
    clearAllSessions();
    registerSession(1, 'stream-1', [KITCHEN], ['Kitchen'], ENCODER, false, 'tab', false, {
      ids: ['RINCON_KITCHEN'],
      targets: { RINCON_KITCHEN: KITCHEN },
    });

    await add(['RINCON_STUDY']);

    expect(brokerCalls.startedPlayback[0].rooms).toBeUndefined();
  });
});
