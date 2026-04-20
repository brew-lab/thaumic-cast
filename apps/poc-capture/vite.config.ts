import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import { resolve } from 'path';

export default defineConfig({
  plugins: [preact(), crx({ manifest })],
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
  build: {
    minify: false,
    sourcemap: true,
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
      },
    },
  },
});
