import { defineConfig } from '@playwright/test';
import {
  ENCRYPTION_KEY, ORG_ID, PEPPER, WEB_URL, journeyEnvironment,
} from '../journeys/environment.ts';

const environment = journeyEnvironment();

export default defineConfig({
  testDir: '..',
  testMatch: ['es/credentialed-full-pass.spec.ts', 'journeys/cross-module.spec.ts'],
  timeout: 45_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  globalSetup: './credentialed-global-setup.ts',
  projects: [
    { name: 'credentialed-mvp', testMatch: ['es/credentialed-full-pass.spec.ts', 'journeys/cross-module.spec.ts'], use: { baseURL: WEB_URL } },
    { name: 'controlled-approval', testMatch: ['es/events-resolver.spec.ts', 'es/translate-workbench-resolver.spec.ts'], use: { baseURL: WEB_URL } },
  ],
  use: { baseURL: WEB_URL, trace: 'off' },
  webServer: {
    command: 'pnpm --filter @seniorsocial/web exec next dev --webpack --port 3130',
    url: `${WEB_URL}/home`,
    timeout: 180_000,
    reuseExistingServer: false,
    env: {
      DATABASE_URL: environment.runtimeUrl,
      DATABASE_SSL: 'disable',
      SENIORSOCIAL_ORG_ID: ORG_ID,
      AUTH_TOKEN_PEPPER: PEPPER,
      ASSISTANCE_ENCRYPTION_KEY: ENCRYPTION_KEY,
      CAREGIVER_RECIPIENT_HMAC_KEY: 'wp032-caregiver-recipient-key-synthetic-only',
      AI_PROVIDER: 'claude-cli-bridge',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
