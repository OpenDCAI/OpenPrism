import { defineConfig } from '@playwright/test';

// Browser tests. They drive a *running* stack (docker compose up -d --wait, then `npm run dev`, or the nginx image);
// `npm run e2e` from the repo root runs them. The devcontainer image ships Playwright's Chromium and Google Chrome.
// E2E_BASE_URL selects the target (default: the Vite dev server). E2E_BROWSER=chrome runs in Google Chrome instead of
// Playwright's Chromium. E2E_HEADED=1 shows the window, which needs a display: in the devcontainer use
// `xvfb-run -a npm run e2e`. Each test creates its own account and project.
export default defineConfig({
  testDir: './e2e',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  workers: 1, // the tests share one backend and compile queue
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5173',
    viewport: { width: 1500, height: 900 },
    ...(process.env.E2E_BROWSER === 'chrome' ? { channel: 'chrome' } : {}),
    ...(process.env.E2E_HEADED ? { headless: false } : {}),
    trace: 'retain-on-failure'
  }
});
