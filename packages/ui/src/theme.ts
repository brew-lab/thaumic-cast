/** The theme preference: follow the system, or force light or dark. */
export type ThemePreference = 'auto' | 'light' | 'dark';

/**
 * Applies a theme preference to the document (DESIGN.md F-pipeline). It writes the
 * preference to `data-theme` on `<html>`, which base.css maps to `color-scheme`; "auto"
 * follows the system. The apps' early theme scripts and stored values already use these
 * three words, so they keep working unchanged.
 * @param pref - The theme preference
 * @param options - Options
 * @param options.transition - Cross-fade with the View Transitions API where available
 */
export function applyTheme(
  pref: ThemePreference,
  { transition = false }: { transition?: boolean } = {},
): void {
  const apply = (): void => {
    document.documentElement.dataset.theme = pref;
  };
  if (transition && typeof document.startViewTransition === 'function') {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}
