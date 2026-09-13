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
import type { SonosStateSnapshot } from '@thaumic-cast/protocol';

/** Calls the mocked broker received, oldest first. */
export const brokerCalls = {
  /** Tab ids passed to `stopSession`. */
  stoppedTabs: [] as number[],
  /** Snapshots passed to `syncSonosState`. */
  syncedStates: [] as SonosStateSnapshot[],
};

/**
 * Empties every recorded call.
 */
export function resetBrokerCalls(): void {
  brokerCalls.stoppedTabs.length = 0;
  brokerCalls.syncedStates.length = 0;
}

mock.module('../background/offscreen-broker', () => ({
  offscreenBroker: {
    async stopSession(tabId: number): Promise<void> {
      brokerCalls.stoppedTabs.push(tabId);
    },
    syncSonosState(state: SonosStateSnapshot): void {
      brokerCalls.syncedStates.push(state);
    },
    async startPlayback(): Promise<void> {},
  },
}));
