import { defineConfig } from '@playwright/test';
import {E2E_ORG_ID,E2E_PEPPER,wp021E2eEnvironment} from './environment';

const environment=wp021E2eEnvironment();

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  workers: 1,
  use: { baseURL: 'http://localhost:3121' },
  globalSetup:'./global-setup.ts',
  webServer: {
    command: 'pnpm --filter @seniorsocial/web exec next dev --webpack --port 3121',
    url: 'http://localhost:3121',
    timeout: 180_000,
    reuseExistingServer: false,
    env:{DATABASE_URL:environment.runtimeUrl,DATABASE_SSL:'disable',SENIORSOCIAL_ORG_ID:E2E_ORG_ID,AUTH_TOKEN_PEPPER:E2E_PEPPER},
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
