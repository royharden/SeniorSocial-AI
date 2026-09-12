import { defineConfig } from '@playwright/test';
import { resolve } from 'node:path';
const cluster = process.env.MESSAGING_TEST_CLUSTER_URL;
if (!cluster) throw new Error('MESSAGING_TEST_CLUSTER_URL required');
const dbName = `wp016_test_browser_${process.pid}_${Date.now()}`;
const url = new URL(cluster); url.pathname = `/${dbName}`; url.username = `${dbName}_app`; url.password = 'wp016_test_only';
process.env.WP016_BROWSER_DB = dbName;
process.env.WP016_BROWSER_RUNTIME = url.toString();
export default defineConfig({
  testDir: '.', testMatch: 'journey.spec.ts', timeout: 120_000, expect: { timeout: 20_000 }, workers: 1,
  globalSetup: resolve('tests/e2e/WP-016/setup.ts'),
  use: { baseURL: 'http://localhost:3166', headless: true },
  webServer: {
    command: 'pnpm --filter @seniorsocial/web exec next dev --webpack --port 3166',
    url: 'http://localhost:3166/home', timeout: 120_000, reuseExistingServer: false,
    env: { DATABASE_URL: url.toString(), SENIORSOCIAL_ORG_ID: '10000000-0000-4000-8000-000000000001', AUTH_TOKEN_PEPPER: 'wp016_browser_test_pepper', NEXT_TELEMETRY_DISABLED: '1' },
  },
});
