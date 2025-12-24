import { render } from 'preact';
import { App } from './App';
import '../lib/i18n';
import '@thaumic-cast/ui/theme.css';

render(<App />, document.getElementById('app')!);
