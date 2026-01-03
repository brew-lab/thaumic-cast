import type { ThemeMode } from './settings';

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
export async function initTheme(): Promise<void> {
  try {
    const result = await chrome.storage.sync.get('extensionSettings');
    const theme = result.extensionSettings?.theme ?? 'auto';
    // Apply directly without transition on initial load
    document.documentElement.dataset.theme = theme;
  } catch {
    // Default to auto if storage access fails
    document.documentElement.dataset.theme = 'auto';
  }
}
