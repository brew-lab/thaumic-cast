import { render } from 'preact';
import { Options } from './Options';

const root = document.getElementById('app');
if (root) {
  render(<Options />, root);
}
