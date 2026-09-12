import { defineConfig } from '@playwright/test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_URL } from './route-matrix';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const configuredUrl = new URL(BASE_URL);
const allowedLoopbackHosts = new Set(['localhost', '127.0.0.1']);

if (configuredUrl.protocol !== 'http:' || !allowedLoopbackHosts.has(configuredUrl.hostname)
  || configuredUrl.pathname !== '/' || configuredUrl.search || configuredUrl.hash) {
  throw new Error('WP031_BASE_URL must be an HTTP loopback origin without a path, query, or fragment');
}

const serverPort = configuredUrl.port || '80';
const canonicalOrigin = configuredUrl.origin;

export default defineConfig({
  testDir: '.',
  testMatch: /.*\.spec\.ts/,
  timeout: 180_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: canonicalOrigin,
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `node apps/web/node_modules/next/dist/bin/next dev apps/web --webpack --hostname ${configuredUrl.hostname} --port ${serverPort}`,
    cwd: root,
    url: `${canonicalOrigin}/home`,
    timeout: 90_000,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
