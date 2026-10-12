/**
 * i18n configuration for the Thaumic Cast extension.
 *
 * Uses i18next with Chrome's language detection.
 * Supports user language override via extension settings.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { loadExtensionSettings } from './settings';
import {
  DEFAULT_LOCALE,
  detectLanguage,
  getInitialLanguage,
  resources,
  type SupportedLocale,
} from './locales';

export * from './locales';

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
