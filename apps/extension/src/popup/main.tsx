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
import { App } from './App';
import { initTheme } from '../lib/theme';
import { initLanguage } from '../lib/i18n';
import { POPUP_PORT_NAME } from '../lib/away-events';
import { reportToolbarTheme } from '../lib/toolbar-theme';
import './styles.css';

// Apply saved theme and language before render to prevent flash
initTheme();
initLanguage();

/**
 * Holds a port to the background while the popup is open, so the background
 * knows an event was seen live and keeps it out of the next "While you were
 * away" line. A service worker that restarts drops the port, so it is opened
 * again (which also wakes the worker).
 */
function holdPopupPort(): void {
  try {
    const port = chrome.runtime.connect({ name: POPUP_PORT_NAME });
    port.onDisconnect.addListener(() => setTimeout(holdPopupPort, POPUP_PORT_RETRY_MS));
  } catch {
    // The extension was reloaded under the popup: there is nothing to hold.
  }
}

/** How soon a dropped popup port is opened again. */
const POPUP_PORT_RETRY_MS = 250;

holdPopupPort();
reportToolbarTheme();

render(
  <AnnouncerProvider>
    <App />
  </AnnouncerProvider>,
  document.getElementById('app')!,
);
