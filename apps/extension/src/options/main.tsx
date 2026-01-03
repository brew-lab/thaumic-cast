import { render } from 'preact';
import { Options } from './Options';
import { initTheme } from '../lib/theme';
import { initLanguage } from '../lib/i18n';
import './styles.css';

// Apply saved theme and language before render to prevent flash
initTheme();
initLanguage();

const root = document.getElementById('app');
if (root) {
  render(<Options />, root);
}
