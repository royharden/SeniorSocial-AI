import { defineConfig } from '@playwright/test';
import { ENCRYPTION_KEY, ORG_ID, PEPPER, WEB_URL, journeyEnvironment } from './environment.ts';

const environment = journeyEnvironment();

export default defineConfig({
  testDir: '.',
  testMatch: 'cross-module.spec.ts',
  timeout: 30_000,
  workers: 1,
  fullyParallel: false,
  globalSetup: './global-setup.ts',
  use: { baseURL: WEB_URL, trace: 'retain-on-failure' },
  webServer: {
    command: 'pnpm --filter @seniorsocial/web exec next dev --webpack --port 3130',
    url: `${WEB_URL}/home`, timeout: 180_000, reuseExistingServer: false,
    env: {
      DATABASE_URL: environment.runtimeUrl, DATABASE_SSL: 'disable', SENIORSOCIAL_ORG_ID: ORG_ID,
      AUTH_TOKEN_PEPPER: PEPPER, ASSISTANCE_ENCRYPTION_KEY: ENCRYPTION_KEY,
      CAREGIVER_RECIPIENT_HMAC_KEY: 'wp030-caregiver-recipient-key-synthetic-only',
      // The subscription bridge is intentionally non-runnable. Concierge therefore
      // reports AI off and proves its native directory/human paths without egress.
      AI_PROVIDER: 'claude-cli-bridge',
    },
    stdout: 'pipe', stderr: 'pipe',
  },
});
