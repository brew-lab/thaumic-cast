import { render } from 'preact';
import { Popup } from './Popup';

const root = document.getElementById('app');
if (root) {
  render(<Popup />, root);
}
