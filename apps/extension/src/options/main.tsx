import { render } from 'preact';
import { Options } from './Options';
import { initTheme } from '../lib/theme';
import '../lib/i18n';
import './styles.css';

// Apply saved theme before render to prevent flash
initTheme();

const root = document.getElementById('app');
if (root) {
  render(<Options />, root);
}
