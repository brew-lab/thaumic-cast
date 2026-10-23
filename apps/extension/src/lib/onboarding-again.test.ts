import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { chromeStorageData, resetChromeStub } from '../test-support/chrome-stub';
import en from '../locales/en.json';
import { onboardingAgainNote, showOnboardingAgain } from './onboarding-again';
import { completeOnboarding, loadOnboardingState, skipOnboarding } from './settings';

type Action = Record<string, unknown>;
const action = chrome.action as unknown as Action;

const ONBOARDING_KEY = 'extensionOnboarding';
const MIGRATION_KEY = 'syncToLocalMigrationComplete';

/** A user who finished the onboarding, with settings and a saved set beside it. */
function seedFinished(): void {
  chromeStorageData.local[MIGRATION_KEY] = true;
  chromeStorageData.local[ONBOARDING_KEY] = {
    completed: true,
    completedAt: '2026-10-01T00:00:00.000Z',
    skipped: true,
    stepsCompleted: { welcome: true, desktopConnection: true, speakerDiscovery: true, ready: true },
    completedVersion: '1.0.0',
  };
  chromeStorageData.local.extensionSettings = { theme: 'dark' };
  chromeStorageData.local.roomSets = [{ id: 'a', name: 'Downstairs' }];
}

beforeEach(() => {
  resetChromeStub();
  seedFinished();
});

afterEach(() => {
  delete action.openPopup;
});

describe('showOnboardingAgain', () => {
  it('should reset the onboarding to its first step and open the popup', async () => {
    const opened: string[] = [];
    action.openPopup = async () => {
      // The popup reads the state as it opens, so it must be reset first.
      opened.push(JSON.stringify(chromeStorageData.local[ONBOARDING_KEY]));
    };
    expect(await showOnboardingAgain()).toBe('opened');
    expect(opened).toHaveLength(1);
    const state = await loadOnboardingState();
    expect(state.completed).toBe(false);
    expect(state.skipped).toBe(false);
    expect(state.completedAt).toBeNull();
    expect(Object.values(state.stepsCompleted)).toEqual([false, false, false, false]);
    expect(JSON.parse(opened[0]!).completed).toBe(false);
  });

  it('should leave the settings and saved sets alone', async () => {
    action.openPopup = async () => {};
    await showOnboardingAgain();
    expect(chromeStorageData.local.extensionSettings).toEqual({ theme: 'dark' });
    expect(chromeStorageData.local.roomSets).toEqual([{ id: 'a', name: 'Downstairs' }]);
  });

  it('should say toolbar when the browser has no openPopup, with the reset made', async () => {
    expect(await showOnboardingAgain()).toBe('toolbar');
    expect((await loadOnboardingState()).completed).toBe(false);
  });

  it('should say toolbar when the browser refuses to open the popup', async () => {
    action.openPopup = async () => {
      throw new Error('Could not find an active browser window.');
    };
    expect(await showOnboardingAgain()).toBe('toolbar');
    expect((await loadOnboardingState()).completed).toBe(false);
  });

  it('should be finished or skipped again as the first time', async () => {
    await showOnboardingAgain();
    await completeOnboarding();
    expect((await loadOnboardingState()).completed).toBe(true);
    await showOnboardingAgain();
    await skipOnboarding();
    const state = await loadOnboardingState();
    expect(state.completed && state.skipped).toBe(true);
  });

  it('should throw when the state cannot be written, and not open the popup', async () => {
    let opened = false;
    action.openPopup = async () => {
      opened = true;
    };
    const local = chrome.storage.local as unknown as Record<string, unknown>;
    const set = local.set;
    local.set = async () => {
      throw new Error('QUOTA_BYTES quota exceeded');
    };
    try {
      await expect(showOnboardingAgain()).rejects.toThrow('quota');
      expect(opened).toBe(false);
    } finally {
      local.set = set;
    }
  });
});

describe('onboardingAgainNote', () => {
  it('should add no note when the popup opened', () => {
    expect(onboardingAgainNote('opened')).toBeNull();
  });

  it('should say to open Thaumic Cast from the toolbar when it could not open', () => {
    const key = onboardingAgainNote('toolbar');
    expect(key).toBe('about_introduction_toolbar');
    expect((en as Record<string, string>)[key!]).toBe(
      'Open Thaumic Cast from the toolbar to start.',
    );
  });
});
