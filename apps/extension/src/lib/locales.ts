/**
 * The locales the extension ships, and which one to use.
 *
 * Kept apart from `i18n.ts`, which starts i18next for Preact as a side
 * effect, so the background service worker can use them too.
 */
import en from '../locales/en.json';

/**
 * Available translation resources.
 * Add new locales here as they become available.
 */
export const resources = {
  en: { translation: en },
} as const;

/**
 * Supported locale codes.
 */
export type SupportedLocale = keyof typeof resources;

/**
 * Array of supported locale codes for validation.
 */
export const SUPPORTED_LOCALES = Object.keys(resources) as SupportedLocale[];

/**
 * Stored language value that means "no preference: follow the browser".
 */
export const AUTO_LANGUAGE = 'auto';

/**
 * A stored language preference: a supported locale, or
 * {@link AUTO_LANGUAGE} to follow the browser.
 */
export type LanguagePreference = SupportedLocale | typeof AUTO_LANGUAGE;

/**
 * Tells whether there is a language to choose between, which is when the
 * Language section of the options page is worth showing.
 * @param locales - The locales on offer (defaults to the ones that ship)
 * @returns True when more than one locale is on offer
 */
export function hasLanguageChoice(locales: readonly string[] = SUPPORTED_LOCALES): boolean {
  return locales.length > 1;
}

/**
 * Default locale for the application.
 */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

/**
 * Checks if a locale code is supported.
 * @param locale - The locale code to check
 * @returns True if the locale is supported
 */
export function isSupportedLocale(locale: string): locale is SupportedLocale {
  return SUPPORTED_LOCALES.includes(locale as SupportedLocale);
}

/**
 * Detects the user's preferred language from Chrome's UI language.
 * Falls back to DEFAULT_LOCALE if not supported.
 * @returns The detected or fallback locale
 */
export function detectLanguage(): SupportedLocale {
  try {
    // Get Chrome's UI language (e.g., "en-US", "es", "fr")
    const uiLanguage = chrome.i18n.getUILanguage();

    // Try exact match first (e.g., "en-US")
    if (isSupportedLocale(uiLanguage)) {
      return uiLanguage;
    }

    // Try base language (e.g., "en" from "en-US")
    const baseLanguage = uiLanguage.split('-')[0];
    if (isSupportedLocale(baseLanguage)) {
      return baseLanguage;
    }
  } catch {
    // chrome.i18n may not be available in all contexts
  }

  return DEFAULT_LOCALE;
}

/**
 * Gets the initial language to use.
 * @param savedLanguage - User's saved language preference (if any);
 *   {@link AUTO_LANGUAGE} counts as no preference
 * @returns The locale to use
 */
export function getInitialLanguage(savedLanguage?: string | null): SupportedLocale {
  // An explicit choice takes priority; 'auto' is not one
  if (savedLanguage && savedLanguage !== AUTO_LANGUAGE && isSupportedLocale(savedLanguage)) {
    return savedLanguage;
  }

  // Otherwise detect from browser
  return detectLanguage();
}
