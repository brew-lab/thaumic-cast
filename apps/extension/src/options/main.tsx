// The cascade layer order comes first, before any component's CSS (packages/ui/DESIGN.md
// F-layers); then the design tokens, the heading face, the base layer (the theme switch,
// the focus ring, reduced motion), the shared keyframes and the utilities.
import '@thaumic-cast/ui/layers.css';
import '@thaumic-cast/ui/tokens.css';
import '@thaumic-cast/ui/fonts.css';
import '@thaumic-cast/ui/base.css';
import '@thaumic-cast/ui/motion.css';
import '@thaumic-cast/ui/utilities.css';
import { render } from 'preact';
import { AnnouncerProvider } from '@thaumic-cast/ui';
import { Options } from './Options';
import { initTheme } from '../lib/theme';
import { initLanguage } from '../lib/i18n';
import './styles.css';

// Apply saved theme and language before render to prevent flash
initTheme();
initLanguage();

const root = document.getElementById('app');
if (root) {
  render(
    <AnnouncerProvider>
      <Options />
    </AnnouncerProvider>,
    root,
  );
}
