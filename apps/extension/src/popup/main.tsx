import { render } from 'preact';
import { App } from './App';
import { initTheme } from '../lib/theme';
import { initLanguage } from '../lib/i18n';
import './styles.css';

// Apply saved theme and language before render to prevent flash
initTheme();
initLanguage();

render(<App />, document.getElementById('app')!);
