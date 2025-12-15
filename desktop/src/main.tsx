import { render } from 'preact';
import { attachConsole } from '@tauri-apps/plugin-log';
import { App } from './App';

// Forward browser console logs to Rust log system
attachConsole();

render(<App />, document.getElementById('app')!);
