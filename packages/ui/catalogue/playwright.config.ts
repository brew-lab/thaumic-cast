import { defineConfig, devices } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const uiRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * The catalogue checks (DESIGN.md §10 row 6): axe in both themes, the behaviour tests, and
 * screenshots, in two projects: Chromium (the extension, WebView2) and WebKit (the desktop
 * on macOS and Linux). The catalogue loads webkit-fallbacks.css as the desktop does.
 *
 * Screenshots only run with DS_SCREENSHOTS=1, which CI sets. Their baselines are made in the
 * CI Linux runner only, because fonts and anti-aliasing differ between machines; locally the
 * screenshot tests are skipped, so a missing baseline never fails a local run. See
 * tests/catalogue.pw.ts for how a baseline is made and committed.
 */
export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.pw.ts',
  outputDir: './test-results',
  snapshotPathTemplate: '{testDir}/__screenshots__/{projectName}/{arg}{ext}',
  fullyParallel: true,
  // The catalogue is one very tall page; on a many-core machine half the cores' worth of
  // WebKit pages at once starve each other into timeouts. Four is quick and steady.
  workers: process.env.CI ? undefined : 4,
  forbidOnly: !!process.env.CI,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4179',
    reducedMotion: 'reduce',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } },
    },
    {
      name: 'webkit',
      use: { ...devices['Desktop Safari'], viewport: { width: 1280, height: 900 } },
    },
  ],
  webServer: {
    command: 'bun run catalogue:build && bunx vite preview --config catalogue/vite.config.ts',
    cwd: uiRoot,
    url: 'http://127.0.0.1:4179',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
