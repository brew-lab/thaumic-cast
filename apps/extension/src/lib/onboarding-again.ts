import { restartOnboarding } from './settings';

/** Where the onboarding starts once it is reset: in the popup just opened, or the next one. */
export type OnboardingAgainResult = 'opened' | 'toolbar';

/**
 * Resets onboarding to its first step and opens the toolbar popup, where it runs. The popup
 * opens only where the browser has `chrome.action.openPopup()` and lets this page use it (a
 * focused window, a recent version); otherwise the reset stands and the next popup opened
 * from the toolbar starts it.
 * @returns 'opened' when the popup opened, else 'toolbar'
 * @throws {Error} If the onboarding state could not be written
 */
export async function showOnboardingAgain(): Promise<OnboardingAgainResult> {
  await restartOnboarding();
  if (typeof chrome.action?.openPopup !== 'function') return 'toolbar';
  try {
    await chrome.action.openPopup();
    return 'opened';
  } catch {
    return 'toolbar';
  }
}

/**
 * The Introduction row's note for a result: none once the popup opened (the onboarding is in
 * front of the user), else where to start it.
 * @param result - What showOnboardingAgain answered
 * @returns The note's string key, or null for no note
 */
export function onboardingAgainNote(
  result: OnboardingAgainResult,
): 'about_introduction_toolbar' | null {
  return result === 'opened' ? null : 'about_introduction_toolbar';
}
