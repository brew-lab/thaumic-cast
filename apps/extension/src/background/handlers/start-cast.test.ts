import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createEmptySonosState, type ZoneGroup } from '@thaumic-cast/protocol';

import { resetChromeStub } from '../../test-support/chrome-stub';
// The broker is mocked for every test file: test-support/offscreen-broker-mock.ts.
import {
  brokerCalls,
  brokerReplies,
  resetBrokerCalls,
} from '../../test-support/offscreen-broker-mock';
import { setCachedCodecSupport } from '../../lib/codec-cache';
import { clearConnectionState, setConnected, setDesktopApp } from '../connection-state';
import { clearAllSessions, getActiveCasts, getSession } from '../session-manager';
import { setSonosState } from '../sonos-state';
import { handleStartCast } from './cast';

const KITCHEN = '192.168.1.10';
const PATIO = '192.168.1.11';
const STUDY = '192.168.1.12';
const APP_URL = 'http://localhost:49400';

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

/** The `chrome` stub, widened to the members this file adds for a cast. */
const chromeStub = chrome as unknown as Record<string, Record<string, unknown>>;
const realFetch = globalThis.fetch;

/**
 * Makes the companion at `APP_URL` answer discovery, saying whether it regroups.
 * @param regroup - The companion plays `rooms` as one Sonos group
 */
function companion(regroup: boolean): void {
  clearConnectionState();
  setDesktopApp(APP_URL, 10, 'desktop', undefined, regroup);
  setConnected(true);
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ service: 'thaumic-cast', regroup }), {
      status: 200,
    })) as unknown as typeof fetch;
}

const cast = (roomIds: string[], startLevels?: Record<string, number>) =>
  handleStartCast({ type: 'START_CAST', payload: { roomIds, startLevels } });

beforeEach(async () => {
  resetChromeStub();
  resetBrokerCalls();
  clearAllSessions();
  setSonosState({
    ...createEmptySonosState(),
    groups: [group(['Kitchen', KITCHEN], ['Patio', PATIO]), group(['Study', STUDY])],
  });
  chromeStub.tabs.query = async () => [{ id: 1, url: 'https://example.com/', title: 'Tab' }];
  chromeStub.tabCapture = {
    getMediaStreamId: (_options: unknown, callback: (id: string) => void) => callback('media-1'),
  };
  chromeStub.runtime.getContexts = async () => [{}];
  chromeStub.runtime.ContextType = { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' };
  await setCachedCodecSupport({
    supported: [{ codec: 'pcm', bitrate: 0, supported: true }],
    sampleRateSupport: [{ codec: 'pcm', sampleRate: 48000, supported: true }],
    availableCodecs: ['pcm'],
    defaultCodec: 'pcm',
    defaultBitrate: 0,
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete chromeStub.tabs.query;
  delete chromeStub.tabCapture;
  delete chromeStub.runtime.getContexts;
  delete chromeStub.runtime.ContextType;
  clearConnectionState();
  clearAllSessions();
});

describe('handleStartCast with a companion that regroups', () => {
  beforeEach(() => companion(true));

  it('should send the chosen rooms in order, by their own IPs and UUIDs, with their levels', async () => {
    brokerReplies.playbackResult = (speakerIp) => ({ speakerIp, success: true });

    // Patio leaves Kitchen's Sonos group to join Study.
    const response = await cast(['RINCON_STUDY', 'RINCON_PATIO'], { RINCON_PATIO: 20 });

    expect(response).toEqual({ success: true, tabId: 1, notJoined: undefined });
    expect(brokerCalls.startedPlayback).toEqual([
      {
        tabId: 1,
        speakerIps: [STUDY, PATIO],
        rooms: ['RINCON_STUDY', 'RINCON_PATIO'],
        startVolume: { limit: 30, rooms: { RINCON_PATIO: 20 } },
      },
    ]);
    expect(getSession(1)?.speakerIps).toEqual([PATIO, STUDY]);
    expect(getSession(1)?.speakerNames).toEqual(['Patio', 'Study']);
    expect(getActiveCasts()[0].roomIds).toEqual(['RINCON_STUDY', 'RINCON_PATIO']);
  });

  it('should cast the rooms that started and name the ones that did not join', async () => {
    brokerReplies.playbackResult = (speakerIp) =>
      speakerIp === STUDY
        ? { speakerIp, success: true }
        : { speakerIp, success: false, error: 'Failed to join group: refused' };

    const response = await cast(['RINCON_STUDY', 'RINCON_PATIO']);

    expect(response).toEqual({ success: true, tabId: 1, notJoined: ['RINCON_PATIO'] });
    expect(getSession(1)?.speakerIps).toEqual([STUDY]);
    expect(getActiveCasts()[0].roomIds).toEqual(['RINCON_STUDY']);
  });

  it('should stop the capture and fail when no room starts', async () => {
    brokerReplies.playbackResult = (speakerIp) => ({ speakerIp, success: false, error: 'No' });

    const response = await cast(['RINCON_STUDY']);

    expect(response).toMatchObject({ success: false, error: 'error_playback_failed' });
    expect(brokerCalls.stoppedTabs).toEqual([1]);
    expect(getSession(1)).toBeUndefined();
  });

  it('should name the Sonos UPnP switch when the speakers refuse control', async () => {
    brokerReplies.playbackResult = (speakerIp) => ({
      speakerIp,
      success: false,
      error: 'speakers_upnp_disabled',
    });

    const response = await cast(['RINCON_STUDY', 'RINCON_PATIO']);

    expect(response).toMatchObject({ success: false, error: 'error_upnp_disabled' });
    expect(brokerCalls.stoppedTabs).toEqual([1]);
    expect(getSession(1)).toBeUndefined();
  });

  it('should say FLAC needs UPnP when a household with it off refuses FLAC', async () => {
    brokerReplies.playbackResult = (speakerIp) => ({
      speakerIp,
      success: false,
      error: 'flac_needs_upnp',
    });

    const response = await cast(['RINCON_STUDY']);

    expect(response).toMatchObject({ success: false, error: 'error_flac_needs_upnp' });
    expect(brokerCalls.stoppedTabs).toEqual([1]);
    expect(getSession(1)).toBeUndefined();
  });
});

describe('handleStartCast with an older companion', () => {
  beforeEach(() => companion(false));

  it("should send each chosen room's coordinator and no rooms", async () => {
    brokerReplies.playbackResult = (speakerIp) => ({ speakerIp, success: true });

    const response = await cast(['RINCON_PATIO', 'RINCON_STUDY']);

    expect(response).toMatchObject({ success: true, tabId: 1 });
    expect(brokerCalls.startedPlayback).toHaveLength(1);
    expect(brokerCalls.startedPlayback[0].rooms).toBeUndefined();
    expect([...brokerCalls.startedPlayback[0].speakerIps].sort()).toEqual([KITCHEN, STUDY]);
  });
});
