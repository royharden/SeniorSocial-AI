import { defineConfig } from '@playwright/test';

const port = 3117;

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  timeout: 15_000,
  workers: 1,
  use: { baseURL: `http://127.0.0.1:${port}` },
  webServer: {
    command: `pnpm --filter @seniorsocial/web exec next dev --webpack --port ${port}`,
    url: `http://127.0.0.1:${port}/home`,
    timeout: 60_000,
    reuseExistingServer: false,
  },
});
