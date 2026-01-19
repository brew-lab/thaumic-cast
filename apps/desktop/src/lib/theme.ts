/** Theme mode options */
export type ThemeMode = 'auto' | 'light' | 'dark';

/**
 * LocalStorage key for persisting theme preference.
 *
 * IMPORTANT: This key is also used in index.html inline script for early
 * theme initialization. If you change this value, update index.html as well.
 */
const THEME_STORAGE_KEY = 'thaumic-cast-theme';

/**
 * Gets the current theme from localStorage.
 * @returns The stored theme mode, defaults to 'auto'
 */
export function getTheme(): ThemeMode {
  const stored = localStorage.getItem(THEME_STORAGE_KEY);
  if (stored === 'auto' || stored === 'light' || stored === 'dark') {
    return stored;
  }
  return 'auto';
}

/**
 * Saves the theme to localStorage.
 * @param theme - The theme mode to save
 */
export function saveTheme(theme: ThemeMode): void {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
}

/**
 * Applies the theme to the document root element.
 * Uses View Transitions API for smooth theme changes when available.
 * @param theme - The theme mode to apply
 */
export function applyTheme(theme: ThemeMode): void {
  const apply = () => {
    document.documentElement.dataset.theme = theme;
  };

  // Use View Transitions API for smooth crossfade if available
  if (document.startViewTransition) {
    document.startViewTransition(apply);
  } else {
    apply();
  }
}

/**
 * Loads the theme from storage and applies it to the document.
 * Should be called early in page initialization.
 */
export function initTheme(): void {
  const theme = getTheme();
  // Apply directly without transition on initial load
  document.documentElement.dataset.theme = theme;
}
