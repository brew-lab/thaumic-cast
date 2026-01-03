import { render } from 'preact';

// Initialize i18n before rendering the app
import './lib/i18n';

import { App } from './App';
import { initTheme } from './lib/theme';

// Apply saved theme before render to prevent flash
initTheme();

render(<App />, document.getElementById('app')!);
