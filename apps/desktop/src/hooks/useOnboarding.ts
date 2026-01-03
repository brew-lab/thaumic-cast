import { useState, useEffect, useCallback } from 'preact/hooks';
import {
  getOnboardingState,
  completeOnboarding as markComplete,
  skipOnboarding as markSkipped,
  completeStep as markStepComplete,
  type DesktopOnboarding,
  type OnboardingSteps,
} from '../lib/onboarding';

interface UseOnboardingResult {
  /** Whether onboarding is still loading from storage */
  isLoading: boolean;
  /** Whether onboarding has been completed or skipped */
  isComplete: boolean;
  /** The full onboarding state */
  state: DesktopOnboarding;
  /** Mark a specific step as completed */
  completeStep: (step: keyof OnboardingSteps) => void;
  /** Mark onboarding as completed */
  completeOnboarding: () => void;
  /** Skip the onboarding flow */
  skipOnboarding: () => void;
}

/**
 * Hook for managing desktop onboarding state.
 * Handles loading, step completion, and persistence.
 *
 * @returns Onboarding state and actions
 */
export function useOnboarding(): UseOnboardingResult {
  const [isLoading, setIsLoading] = useState(true);
  const [state, setState] = useState<DesktopOnboarding>(() => getOnboardingState());

  useEffect(() => {
    setState(getOnboardingState());
    setIsLoading(false);
  }, []);

  const completeStep = useCallback((step: keyof OnboardingSteps) => {
    markStepComplete(step);
    setState(getOnboardingState());
  }, []);

  const completeOnboarding = useCallback(() => {
    markComplete();
    setState(getOnboardingState());
  }, []);

  const skipOnboarding = useCallback(() => {
    markSkipped();
    setState(getOnboardingState());
  }, []);

  return {
    isLoading,
    isComplete: state.completed || state.skipped,
    state,
    completeStep,
    completeOnboarding,
    skipOnboarding,
  };
}
