/**
 * i18n configuration for the Thaumic Cast extension.
 *
 * Uses i18next with Chrome's language detection.
 * Supports user language override via extension settings.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../locales/en.json';
import { loadExtensionSettings } from './settings';

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
 * @param savedLanguage - User's saved language preference (if any)
 * @returns The locale to use
 */
export function getInitialLanguage(savedLanguage?: string | null): SupportedLocale {
  // User preference takes priority
  if (savedLanguage && isSupportedLocale(savedLanguage)) {
    return savedLanguage;
  }

  // Otherwise detect from browser
  return detectLanguage();
}

/**
 * Changes the current language.
 * @param locale - The locale to switch to
 */
export async function changeLanguage(locale: SupportedLocale): Promise<void> {
  await i18n.changeLanguage(locale);
}

/**
 * Initializes i18n with the user's saved language preference.
 * Should be called early in the app lifecycle.
 */
export async function initLanguage(): Promise<void> {
  const settings = await loadExtensionSettings();
  const language = getInitialLanguage(settings.language);

  if (language !== i18n.language) {
    await i18n.changeLanguage(language);
  }
}

// Initialize i18next with detected language
i18n.use(initReactI18next).init({
  resources,
  lng: detectLanguage(),
  fallbackLng: DEFAULT_LOCALE,
  interpolation: {
    // React already escapes values, no need for i18next to do it
    escapeValue: false,
  },
});

export default i18n;
