import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import {
  ONBOARDING_STATE_CHANGE_EVENT,
  completeOnboarding,
  getOnboardingState,
  isFirstRun,
  restartOnboarding,
  skipOnboarding,
} from './onboarding';

const KEY = 'thaumic-cast-onboarding';
const store = new Map<string, string>();
const events: string[] = [];
const globals = globalThis as Record<string, unknown>;

beforeEach(() => {
  store.clear();
  events.length = 0;
  globals.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  };
  globals.window = { dispatchEvent: (e: Event) => events.push(e.type) };
  store.set('thaumic-cast-theme', 'dark');
  store.set(
    KEY,
    JSON.stringify({
      completed: true,
      completedAt: '2026-10-01T00:00:00.000Z',
      skipped: true,
      stepsCompleted: {
        welcome: true,
        firewallWarning: true,
        speakerDiscovery: false,
        extensionConnection: false,
        ready: false,
      },
      completedVersion: '1.0.0',
    }),
  );
});

afterEach(() => {
  delete globals.localStorage;
  delete globals.window;
});

describe('restartOnboarding', () => {
  it('should put the onboarding back to a first run, from its first step', () => {
    expect(isFirstRun()).toBe(false);
    restartOnboarding();
    const state = getOnboardingState();
    expect(isFirstRun()).toBe(true);
    expect(state.completedAt).toBeNull();
    expect(state.completedVersion).toBeNull();
    expect(Object.values(state.stepsCompleted).every((done) => !done)).toBe(true);
  });

  it('should tell the app at once, so it shows the onboarding', () => {
    restartOnboarding();
    expect(events).toEqual([ONBOARDING_STATE_CHANGE_EVENT]);
  });

  it('should leave the settings alone', () => {
    restartOnboarding();
    expect(store.get('thaumic-cast-theme')).toBe('dark');
  });

  it('should be finished or skipped again as on a first run', () => {
    restartOnboarding();
    completeOnboarding();
    expect(isFirstRun()).toBe(false);
    restartOnboarding();
    skipOnboarding();
    expect(getOnboardingState().skipped).toBe(true);
    expect(isFirstRun()).toBe(false);
  });
});
