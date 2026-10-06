// The cascade layer order comes first, before any component's CSS (packages/ui/DESIGN.md
// F-layers); then the design tokens and the heading face.
import '@thaumic-cast/ui/layers.css';
import '@thaumic-cast/ui/tokens.css';
import '@thaumic-cast/ui/fonts.css';
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
