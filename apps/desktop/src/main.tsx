import { render } from 'preact';

// Initialize i18n before rendering the app
import './lib/i18n';

import { App } from './App';

render(<App />, document.getElementById('app')!);
