import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import { resolve } from 'path';

export default defineConfig({
  plugins: [preact(), crx({ manifest })],
  build: {
    rollupOptions: {
      input: {
        offscreen: resolve(__dirname, 'src/offscreen/offscreen.html'),
        'pcm-processor': resolve(__dirname, 'src/offscreen/pcm-processor.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'pcm-processor') {
            return 'pcm-processor.js';
          }
          return 'assets/[name]-[hash].js';
        },
      },
    },
  },
});
