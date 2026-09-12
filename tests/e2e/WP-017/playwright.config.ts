import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

export default defineConfig({
  testDir: '.', testMatch: 'caregiver-journey.spec.ts', timeout: 15_000, workers: 1,
  use: { baseURL: 'http://127.0.0.1:3117' },
  webServer: {
    command: 'node apps/web/node_modules/next/dist/bin/next dev apps/web --webpack --port 3117',
    cwd: root, url: 'http://127.0.0.1:3117/caregiver', timeout: 30_000,
    reuseExistingServer: false, stdout: 'pipe', stderr: 'pipe',
  },
});
