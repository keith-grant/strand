/*
 * Acceptance tests: the Gherkin scenarios in features/, run through the real UI in Edge (the same engine as WebView2)
 * against the Vite dev server in test mode, which swaps the desktop side for a fake (src/testing/fake-tauri.ts).
 * Run with `pnpm test:acceptance`.
 */
import {defineConfig} from '@playwright/test';
import {defineBddConfig} from 'playwright-bdd';

const testDir = defineBddConfig({
  features: 'features/*.feature',
  steps: 'tests/acceptance/*.ts',
});

const PORT = 5174;

export default defineConfig({
  testDir,
  timeout: 20_000,
  expect: {timeout: 5_000},
  reporter: [['list'], ['html', {open: 'never'}]], // report in playwright-report/
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    channel: 'msedge',
    viewport: {width: 1200, height: 800},
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `pnpm exec vite --mode test --port ${PORT}`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
