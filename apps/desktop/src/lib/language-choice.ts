/**
 * Tells whether there is a language to choose between, which is when the
 * Language section of Settings is worth showing.
 *
 * Kept apart from `i18n.ts` so it can be tested without starting i18next.
 * @param locales - The locales on offer
 * @returns True when more than one locale is on offer
 */
export function hasLanguageChoice(locales: readonly string[]): boolean {
  return locales.length > 1;
}
