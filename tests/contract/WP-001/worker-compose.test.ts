import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workerConfiguration } from '../../../packages/worker/src/config.ts';
import { reportWorkerStartupFailure } from '../../../packages/worker/src/diagnostics.ts';

const root = resolve(import.meta.dirname, '../../..');
const compose = readFileSync(resolve(root, 'infra/docker-compose.yml'), 'utf8');
const dockerfile = readFileSync(resolve(root, 'infra/docker/Dockerfile'), 'utf8');

describe('WP-001 Compose worker contract', () => {
  // what_bug_this_catches: the obsolete health-only placeholder silently returns to the demo stack.
  it('runs the real worker with its queue, tenant, provider, and dependency-volume configuration', () => {
    expect(compose).toContain('command: ["node", "node_modules/tsx/dist/cli.mjs", "packages/worker/src/main.ts"]');
    expect(compose).toContain('WORKER_DATABASE_URL: postgres://seniorsocial_runtime:');
    expect(compose).toContain('SENIORSOCIAL_ORG_ID: ${SENIORSOCIAL_ORG_ID:-11111111-1111-4111-8111-111111111111}');
    expect(compose).toContain('SMS_PROVIDER: simulator');
    expect(compose).toContain('EMAIL_PROVIDER: mailpit');
    expect(compose).toContain('SENIORSOCIAL_LOCAL_COMPOSE: "true"');
    expect(compose).toContain('MAILPIT_URL: http://mailpit:8025/');
    expect(compose).toMatch(/worker:[\s\S]*depends_on:[\s\S]*mailpit:\s*\n\s*condition: service_healthy/);
    for (const volume of ['worker', 'assistance', 'messaging', 'notify']) {
      expect(compose).toContain(`${volume}-node-modules:/app/packages/${volume}/node_modules`);
    }
    expect(compose).not.toContain('worker-health.mjs');
    expect(compose).not.toContain('implementation: placeholder');
  });

  // what_bug_this_catches: pnpm tries to reconcile the bind-mounted workspace at
  // runtime and restart-loops headless containers instead of using the image's
  // reviewed frozen/ignore-scripts dependency layer.
  it('launches web and worker without a runtime package-manager install', () => {
    expect(dockerfile).toContain('CMD ["node", "apps/web/node_modules/next/dist/bin/next", "dev", "apps/web", "--hostname", "0.0.0.0", "--port", "3000"]');
    expect(dockerfile).not.toContain('CMD ["pnpm"');
    expect(compose).not.toContain('command: ["pnpm"');
    expect(dockerfile).toContain('pnpm install --frozen-lockfile --ignore-scripts');
  });

  // what_bug_this_catches: a compromised runtime regains schema-migration
  // authority instead of failing closed against the admin-provisioned version.
  it('starts pg-boss in drift-check-only mode under the runtime role', () => {
    const entrypoint = readFileSync(resolve(root, 'packages/worker/src/main.ts'), 'utf8');
    expect(entrypoint).toContain('new PgBoss({ connectionString, migrate: false })');
  });

  // what_bug_this_catches: missing trusted startup configuration creates a looping but apparently live process.
  it('exits nonzero before opening resources when DB or tenant configuration is absent', () => {
    expect(() => workerConfiguration({})).toThrow('WORKER_DATABASE_URL is required');
    expect(() => workerConfiguration({ WORKER_DATABASE_URL: 'postgres://unused' })).toThrow('SENIORSOCIAL_ORG_ID is required');
  });

  // what_bug_this_catches: startup diagnostics echo a credential-bearing connection error to logs.
  it('uses a fixed startup diagnostic that cannot disclose thrown configuration content', () => {
    const sentinel = 'sentinel-secret-password';
    let output = '';
    const originalExitCode = process.exitCode;
    reportWorkerStartupFailure(new Error(sentinel), message => { output += message; });
    expect(process.exitCode).toBe(1);
    expect(output).toContain('Worker startup failed');
    expect(output).not.toContain(sentinel);
    process.exitCode = originalExitCode;

    const entrypoint = readFileSync(resolve(root, 'packages/worker/src/main.ts'), 'utf8');
    expect(entrypoint).toContain('await main().catch(reportWorkerStartupFailure);');
  });
});
