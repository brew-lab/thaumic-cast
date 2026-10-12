import { applyTheme as applyDocumentTheme } from '@thaumic-cast/ui';
import { loadExtensionSettings, type ThemeMode } from './settings';

/**
 * Applies a theme the user just chose, cross-faded where the View Transitions API exists.
 * The design system's `applyTheme` writes it; base.css maps it to `color-scheme`.
 * @param theme - The theme mode to apply
 */
export function applyTheme(theme: ThemeMode): void {
  applyDocumentTheme(theme, { transition: true });
}

/**
 * Loads the theme from storage and applies it to the document, without a transition.
 * Should be called early in page initialization.
 */
export async function initTheme(): Promise<void> {
  const settings = await loadExtensionSettings();
  applyDocumentTheme(settings.theme);
}
