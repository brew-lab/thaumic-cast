// The foundations in the order every surface loads them: the layer order first.
import '../src/layers.css';
import '../src/tokens.css';
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

const root = document.getElementById('app');
if (root) render(<Catalogue initialTheme={initial} />, root);
