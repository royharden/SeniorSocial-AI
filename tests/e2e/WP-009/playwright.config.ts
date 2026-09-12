import { defineConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';
process.env.WP009_WEB_URL = 'http://localhost:3119';
export default defineConfig({
  testDir: '.', testMatch: 'resident.spec.ts', workers: 1, timeout: 60000,
  use: { baseURL: process.env.WP009_WEB_URL },
  webServer: { command: 'pnpm --filter @seniorsocial/web exec next dev --webpack --port 3119',
    cwd: fileURLToPath(new URL('../../../', import.meta.url)), url: 'http://localhost:3119/home', timeout: 60000,
    reuseExistingServer: false, stdout: 'pipe', stderr: 'pipe' },
});
