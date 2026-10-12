import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  resolve: {
    dedupe: ['preact'],
  },
  css: {
    modules: {
      localsConvention: 'camelCaseOnly',
    },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'esnext',
    // CSS is not lowered either (cssTarget follows target), so light-dark() stays as written;
    // webkit-fallbacks.css carries the tokens for WebKit without it (macOS 13, WebKitGTK 2.44).
    minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_DEBUG,
  },
});
