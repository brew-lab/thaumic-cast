import { render } from 'preact';
import { App } from './App';
import { initTheme } from '../lib/theme';
import '../lib/i18n';
import './styles.css';

// Apply saved theme before render to prevent flash
initTheme();

render(<App />, document.getElementById('app')!);
