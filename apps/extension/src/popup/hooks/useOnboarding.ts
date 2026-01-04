import { useState, useEffect, useCallback } from 'preact/hooks';
import {
  loadOnboardingState,
  saveOnboardingState,
  completeOnboarding as markComplete,
  skipOnboarding as markSkipped,
  type ExtensionOnboarding,
  type OnboardingSteps,
} from '../../lib/settings';

interface UseOnboardingResult {
  /** Whether onboarding is still loading from storage */
  isLoading: boolean;
  /** Whether onboarding has been completed or skipped */
  isComplete: boolean;
  /** The full onboarding state */
  state: ExtensionOnboarding | null;
  /** Mark a specific step as completed */
  completeStep: (step: keyof OnboardingSteps) => Promise<void>;
  /** Mark onboarding as completed */
  completeOnboarding: () => Promise<void>;
  /** Skip the onboarding flow */
  skipOnboarding: () => Promise<void>;
}

/**
 * Hook for managing extension onboarding state.
 * Handles loading, step completion, and persistence to chrome.storage.sync.
 *
 * @returns Onboarding state and actions
 */
export function useOnboarding(): UseOnboardingResult {
  const [isLoading, setIsLoading] = useState(true);
  const [state, setState] = useState<ExtensionOnboarding | null>(null);

  useEffect(() => {
    loadOnboardingState()
      .then((loaded) => {
        setState(loaded);
        setIsLoading(false);
      })
      .catch(() => {
        setIsLoading(false);
      });
  }, []);

  const completeStep = useCallback(async (step: keyof OnboardingSteps) => {
    const current = await loadOnboardingState();
    await saveOnboardingState({
      stepsCompleted: {
        ...current.stepsCompleted,
        [step]: true,
      },
    });
    const updated = await loadOnboardingState();
    setState(updated);
  }, []);

  const completeOnboarding = useCallback(async () => {
    await markComplete();
    const updated = await loadOnboardingState();
    setState(updated);
  }, []);

  const skipOnboarding = useCallback(async () => {
    await markSkipped();
    const updated = await loadOnboardingState();
    setState(updated);
  }, []);

  return {
    isLoading,
    isComplete: state?.completed || state?.skipped || false,
    state,
    completeStep,
    completeOnboarding,
    skipOnboarding,
  };
}
