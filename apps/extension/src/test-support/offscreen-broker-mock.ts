/**
 * Replaces the offscreen broker for every extension test.
 *
 * Loaded through `bunfig.toml` (`[test] preload`). `mock.module` in bun is
 * process-wide and survives across test files in whatever order bun runs
 * them, so a mock installed inside one test file would silently reach any
 * file that runs after it. Installing it here makes that global scope
 * deliberate: no unit test ever wants the real broker, which talks to an
 * offscreen document over `chrome.runtime.sendMessage`.
 *
 * Tests inspect and reset what the mock recorded through `brokerCalls`.
 */

import { mock } from 'bun:test';
import type { SonosStateSnapshot, StartVolume } from '@thaumic-cast/protocol';
import type { PlaybackRequest } from '../lib/messages';

/** The arguments of one `startPlayback` call. */
export interface StartPlaybackCall {
  tabId: number;
  speakerIps: string[];
  startVolume: StartVolume | undefined;
  /** The rooms, when the request names them (a companion that regroups). */
  rooms?: string[];
}

/** Calls the mocked broker received, oldest first. */
export const brokerCalls = {
  /** Tab ids passed to `stopSession`. */
  stoppedTabs: [] as number[],
  /** Snapshots passed to `syncSonosState`. */
  syncedStates: [] as SonosStateSnapshot[],
  /** Calls to `startPlayback`. */
  startedPlayback: [] as StartPlaybackCall[],
  /** Tab ids passed to `startCapture`. */
  startedCapture: [] as number[],
};

/** One speaker's answer to a `startPlayback` call. */
export interface PlaybackResult {
  speakerIp: string;
  success: boolean;
  error?: string;
}

/**
 * How the mocked `startPlayback` answers: by default it resolves with nothing,
 * as an offscreen document that did not answer. Set `playbackResult` to answer
 * each speaker.
 */
export const brokerReplies = {
  playbackResult: undefined as ((speakerIp: string) => PlaybackResult) | undefined,
};

/**
 * Empties every recorded call and answer.
 */
export function resetBrokerCalls(): void {
  brokerCalls.stoppedTabs.length = 0;
  brokerCalls.syncedStates.length = 0;
  brokerCalls.startedPlayback.length = 0;
  brokerCalls.startedCapture.length = 0;
  brokerReplies.playbackResult = undefined;
}

mock.module('../background/offscreen-broker', () => ({
  offscreenBroker: {
    async startCapture(tabId: number): Promise<{ success: boolean; streamId: string }> {
      brokerCalls.startedCapture.push(tabId);
      return { success: true, streamId: `stream-${tabId}` };
    },
    async stopSession(tabId: number): Promise<void> {
      brokerCalls.stoppedTabs.push(tabId);
    },
    syncSonosState(state: SonosStateSnapshot): void {
      brokerCalls.syncedStates.push(state);
    },
    async startPlayback(
      tabId: number,
      request: PlaybackRequest,
    ): Promise<{ success: boolean; results: PlaybackResult[] } | undefined> {
      const { speakerIps, startVolume, rooms } = request;
      brokerCalls.startedPlayback.push({
        tabId,
        speakerIps,
        startVolume,
        ...(rooms ? { rooms } : {}),
      });
      const answer = brokerReplies.playbackResult;
      if (!answer) return undefined;
      const results = speakerIps.map(answer);
      return { success: results.some((r) => r.success), results };
    },
  },
}));
