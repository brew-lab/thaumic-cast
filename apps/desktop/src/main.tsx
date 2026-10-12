// The cascade layer order comes first, before any component's CSS (packages/ui/DESIGN.md
// F-layers); then the design tokens, their repeat for WebKit without light-dark() (macOS 13,
// WebKitGTK 2.44), the heading face, the base layer (the theme switch, the focus ring, reduced
// motion), the shared keyframes and the utilities.
import '@thaumic-cast/ui/layers.css';
import '@thaumic-cast/ui/tokens.css';
import '@thaumic-cast/ui/webkit-fallbacks.css';
import '@thaumic-cast/ui/fonts.css';
import '@thaumic-cast/ui/base.css';
import '@thaumic-cast/ui/motion.css';
import '@thaumic-cast/ui/utilities.css';
import { render } from 'preact';
import { AnnouncerProvider } from '@thaumic-cast/ui';
import { invoke } from '@tauri-apps/api/core';
import { createLogger } from '@thaumic-cast/shared';

// Initialize i18n with language detection
import { initLanguage } from './lib/i18n';

import { App } from './App';
import { initTheme } from './lib/theme';

const log = createLogger('Main');

// Apply saved theme and language before render.
// Note: Initial theme is also applied in index.html inline script to prevent
// flash of wrong theme before this module loads.
initTheme();
initLanguage();

render(
  <AnnouncerProvider>
    <App />
  </AnnouncerProvider>,
  document.getElementById('app')!,
);

// Show the window after frontend is initialized.
// Window starts hidden to prevent flash of unstyled content.
// The Rust side checks if --minimized flag was passed and keeps window hidden if so.
invoke('show_main_window').catch((e) => {
  log.warn('Failed to show main window:', e);
});
