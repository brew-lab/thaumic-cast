import { render } from 'preact';

// Initialize i18n with language detection
import { initLanguage } from './lib/i18n';

import { App } from './App';
import { initTheme } from './lib/theme';

// Apply saved theme and language before render
initTheme();
initLanguage();

render(<App />, document.getElementById('app')!);
