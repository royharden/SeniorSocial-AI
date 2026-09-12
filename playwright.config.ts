import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  // WP-030 owns a destructive, explicitly authorized disposable-cluster fixture.
  // It runs only through verify:e2e:journeys with its dedicated config/guards.
  testIgnore: '**/e2e/journeys/**',
  timeout: 15_000,
  workers: 1,
  use: {
    baseURL: 'http://127.0.0.1:3110',
  },
  webServer: {
    command: 'pnpm --filter @seniorsocial/web exec next dev --webpack --port 3110',
    url: 'http://127.0.0.1:3110/home',
    timeout: 30_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
