import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './src/manifest.json';

export default defineConfig({
  plugins: [preact(), crx({ manifest })],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        offscreen: 'src/offscreen/offscreen.html',
      },
    },
  },
});
