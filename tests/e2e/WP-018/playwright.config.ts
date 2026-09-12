import { defineConfig } from '@playwright/test';

process.env.WEB_URL ??= 'http://localhost:3127';

export default defineConfig({
  testDir: '.',
  timeout: 15_000,
  workers: 1,
  use: { baseURL: 'http://localhost:3127' },
  webServer: {
    command: 'pnpm --filter @seniorsocial/web exec next dev --webpack --port 3127',
    url: 'http://localhost:3127/home',
    timeout: 30_000,
    reuseExistingServer: false,
  },
});
