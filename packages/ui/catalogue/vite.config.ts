import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';
import { fileURLToPath } from 'node:url';

/** The design-system catalogue: a plain Vite page, no Storybook (DESIGN.md §10 row 6). */
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: './',
  plugins: [preact()],
  css: {
    modules: {
      // The same naming as the apps, so components index their classes the same way.
      localsConvention: 'camelCaseOnly',
    },
  },
  build: {
    // The extension's floor. Without it the CSS minifier rewrites light-dark() inside custom
    // properties into a polyfill that resolves at :root, so a panel drawn with
    // color-scheme: dark would still show light tokens.
    cssTarget: 'chrome125',
    outDir: 'dist',
    emptyOutDir: true,
  },
  preview: {
    // Bind the address the Playwright webServer polls. Left as `localhost`, Vite can bind
    // ::1 on CI runners and the test run waits out its timeout.
    host: '127.0.0.1',
    port: 4179,
    strictPort: true,
  },
});
