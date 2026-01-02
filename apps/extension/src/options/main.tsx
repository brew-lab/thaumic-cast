import { render } from 'preact';
import { Options } from './Options';
import '../lib/i18n';
import '@thaumic-cast/ui/theme.css';

const root = document.getElementById('app');
if (root) {
  render(<Options />, root);
}
