/** Onboarding step completion tracking */
export interface OnboardingSteps {
  welcome: boolean;
  firewallWarning: boolean;
  speakerDiscovery: boolean;
  extensionConnection: boolean;
  ready: boolean;
}

/** Desktop onboarding state */
export interface DesktopOnboarding {
  /** Whether onboarding has been completed (or skipped) */
  completed: boolean;
  /** When onboarding was completed (ISO string) */
  completedAt: string | null;
  /** Whether user explicitly skipped */
  skipped: boolean;
  /** Individual step completion tracking */
  stepsCompleted: OnboardingSteps;
  /** App version at completion */
  completedVersion: string | null;
}

const STORAGE_KEY = 'thaumic-cast-onboarding';

const DEFAULT_STEPS: OnboardingSteps = {
  welcome: false,
  firewallWarning: false,
  speakerDiscovery: false,
  extensionConnection: false,
  ready: false,
};

const DEFAULT_STATE: DesktopOnboarding = {
  completed: false,
  completedAt: null,
  skipped: false,
  stepsCompleted: DEFAULT_STEPS,
  completedVersion: null,
};

/**
 * Gets the current onboarding state from localStorage.
 * @returns The stored onboarding state, or default if none exists
 */
export function getOnboardingState(): DesktopOnboarding {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (!stored) {
    return DEFAULT_STATE;
  }
  try {
    const parsed = JSON.parse(stored) as Partial<DesktopOnboarding>;
    return {
      ...DEFAULT_STATE,
      ...parsed,
      stepsCompleted: {
        ...DEFAULT_STEPS,
        ...parsed.stepsCompleted,
      },
    };
  } catch {
    return DEFAULT_STATE;
  }
}

/** Event name dispatched when onboarding state changes */
export const ONBOARDING_STATE_CHANGE_EVENT = 'thaumic-onboarding-state-change';

/**
 * Saves onboarding state to localStorage.
 * Dispatches a custom event to notify all listeners of the change.
 * @param state - Partial state to merge with existing
 */
export function saveOnboardingState(state: Partial<DesktopOnboarding>): void {
  const current = getOnboardingState();
  const merged = {
    ...current,
    ...state,
    stepsCompleted: {
      ...current.stepsCompleted,
      ...state.stepsCompleted,
    },
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  window.dispatchEvent(new Event(ONBOARDING_STATE_CHANGE_EVENT));
}

/**
 * Checks if this is the first run (no onboarding completed).
 * @returns True if onboarding has never been completed or skipped
 */
export function isFirstRun(): boolean {
  const state = getOnboardingState();
  return !state.completed && !state.skipped;
}

/**
 * Marks a specific step as completed.
 * @param step - The step key to mark as completed
 */
export function completeStep(step: keyof OnboardingSteps): void {
  const current = getOnboardingState();
  saveOnboardingState({
    stepsCompleted: {
      ...current.stepsCompleted,
      [step]: true,
    },
  });
}

/**
 * Marks onboarding as completed.
 * @param version - The app version at completion
 */
export function completeOnboarding(version?: string): void {
  saveOnboardingState({
    completed: true,
    completedAt: new Date().toISOString(),
    completedVersion: version ?? null,
  });
}

/**
 * Marks onboarding as skipped.
 */
export function skipOnboarding(): void {
  saveOnboardingState({
    completed: true,
    skipped: true,
    completedAt: new Date().toISOString(),
  });
}

/**
 * Resets onboarding state (useful for testing).
 */
export function resetOnboarding(): void {
  localStorage.removeItem(STORAGE_KEY);
}
