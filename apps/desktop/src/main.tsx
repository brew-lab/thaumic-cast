import { render } from 'preact';
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

render(<App />, document.getElementById('app')!);

// Show the window after frontend is initialized.
// Window starts hidden to prevent flash of unstyled content.
// The Rust side checks if --minimized flag was passed and keeps window hidden if so.
invoke('show_main_window').catch((e) => {
  log.warn('Failed to show main window:', e);
});
