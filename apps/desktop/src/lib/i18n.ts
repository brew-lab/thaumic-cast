/**
 * i18n configuration for the Thaumic Cast desktop app.
 *
 * Uses i18next with react-i18next for internationalization support.
 * Currently supports English only, but structured for easy addition of new locales.
 */
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

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
 * Default locale for the application.
 */
export const DEFAULT_LOCALE: SupportedLocale = 'en';

i18n.use(initReactI18next).init({
  resources,
  lng: DEFAULT_LOCALE,
  fallbackLng: DEFAULT_LOCALE,
  interpolation: {
    // React already escapes values, no need for i18next to do it
    escapeValue: false,
  },
  // Disable debug logging in production
  debug: import.meta.env.DEV,
});

export default i18n;
