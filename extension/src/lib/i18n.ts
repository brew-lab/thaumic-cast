import en from '../locales/en.json';

export type LocaleKey = keyof typeof en;
export type SupportedLocale = 'en';

const locales: Record<SupportedLocale, Record<string, string>> = {
  en,
};

let currentLocale: SupportedLocale = 'en';

export function setLocale(locale: SupportedLocale) {
  currentLocale = locale;
}

export function t(key: LocaleKey, vars?: Record<string, string | number>): string {
  const template = locales[currentLocale]?.[key] || key;
  if (!vars) return template;

  return Object.keys(vars).reduce((str, varKey) => {
    const value = vars[varKey];
    return str.replace(new RegExp(`{{${varKey}}}`, 'g'), String(value));
  }, template);
}

export function getCurrentLocale(): SupportedLocale {
  return currentLocale;
}
