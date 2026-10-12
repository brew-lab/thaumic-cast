// Floor mode (?floor=1) first, so CSS.supports() answers as the desktop's WebKit floor
// before any component reads it.
import { lowerStylesheets } from './floor';
// The foundations in the order every surface loads them: the layer order first.
import '../src/layers.css';
import '../src/tokens.css';
// The desktop's repeat of the themed tokens for WebKit without light-dark(), loaded as the
// desktop loads it, so the WebKit project runs the same stylesheet the desktop ships.
import '../src/webkit-fallbacks.css';
import '../src/fonts.css';
import '../src/base.css';
import '../src/motion.css';
import '../src/utilities.css';
import './catalogue.css';
import { render } from 'preact';
import { applyTheme, type ThemePreference } from '../src/theme';
import { Catalogue } from './Catalogue';

const requested = new URLSearchParams(location.search).get('theme');
const initial: ThemePreference = requested === 'light' || requested === 'dark' ? requested : 'auto';
applyTheme(initial);

// Floor mode drops the @supports paths the floor cannot take, once the stylesheets are in.
lowerStylesheets();
addEventListener('load', lowerStylesheets);

const root = document.getElementById('app');
if (root) render(<Catalogue initialTheme={initial} />, root);

// The page draws some 80 Clacks and live gradients at once, more than any surface ever
// shows. A section out of view pauses its animations, so the ones in view (a fold, a
// Button's change) keep their frames. The product needs nothing like this.
const offscreen = new IntersectionObserver(
  (entries) => {
    for (const entry of entries)
      entry.target.toggleAttribute('data-offscreen', !entry.isIntersecting);
  },
  { rootMargin: '25% 0px' },
);
document.querySelectorAll('.section').forEach((section) => offscreen.observe(section));

// Some specimens press a button on mount to draw a state only a press reaches (an invalid
// address focuses its field; a refused copy selects its value; a step heading takes focus
// after that). None of it is the reader's doing, so the page then opens where it was asked
// to: at its top, or at the section in the address. Tests wait for data-ready.
// The presses settle within a second of load (a refused copy waits on its clipboard).
addEventListener('load', () => {
  setTimeout(() => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    window.getSelection()?.removeAllRanges();
    const target = location.hash ? document.getElementById(location.hash.slice(1)) : null;
    if (target) target.scrollIntoView();
    else scrollTo(0, 0);
    document.documentElement.setAttribute('data-ready', '');
  }, 1000);
});
