import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '../../../packages/db/src/client.ts';
import { PgBoss } from '../../../packages/worker/src/bridge.ts';

const adminUrl = process.env.WP001_PGBOSS_DATABASE_URL;
const runtimeDatabaseUrl = process.env.WP001_PGBOSS_RUNTIME_DATABASE_URL;
const enabled = Boolean(adminUrl && runtimeDatabaseUrl);
const expectedDatabase = 'seniorsocial_wp001_pgboss_test';
const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'db');
let owner: DatabaseClient;
let runtime: DatabaseClient;
let boss: PgBoss;

function migrate(direction: 'up' | 'down') {
  execFileSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts', direction], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: adminUrl, DATABASE_SSL: 'disable' },
    stdio: 'pipe',
  });
}

async function startAndCompleteQueue(queue: string) {
  const queueErrors: Error[] = [];
  boss = new PgBoss({ connectionString: runtimeDatabaseUrl!, migrate: false });
  boss.on('error', error => queueErrors.push(error));
  await boss.start();
  await boss.createQueue(queue, { policy: 'exclusive' });
  const consumed = new Promise<string>((resolve, reject) => {
    void boss.work<{ marker: string }>(queue, async jobs => {
      try {
        resolve(jobs[0]?.data.marker ?? 'missing');
      } catch (error) {
        reject(error);
      }
    });
  });
  const jobId = await boss.send(queue, { marker: 'consumed' });
  expect(jobId).not.toBeNull();
  await expect(consumed).resolves.toBe('consumed');
  await expect.poll(async () => (await boss.findJobs(queue, { state: 'completed' })).some(job => job.id === jobId), {
    timeout: 5_000,
  }).toBe(true);
  expect(queueErrors).toEqual([]);
}

describe.skipIf(!enabled)('WP-001 owner-provisioned pg-boss', () => {
  beforeAll(async () => {
    const parsed = new URL(adminUrl!);
    if (!['localhost', '127.0.0.1'].includes(parsed.hostname) || parsed.pathname !== `/${expectedDatabase}`) {
      throw new Error(`WP001_PGBOSS_DATABASE_URL must target dedicated local database ${expectedDatabase}`);
    }
    const runtimeParsed = new URL(runtimeDatabaseUrl!);
    if (!['localhost', '127.0.0.1'].includes(runtimeParsed.hostname) ||
        runtimeParsed.pathname !== `/${expectedDatabase}` || runtimeParsed.username !== 'seniorsocial_runtime') {
      throw new Error(`WP001_PGBOSS_RUNTIME_DATABASE_URL must target ${expectedDatabase} as seniorsocial_runtime`);
    }

    owner = createDatabaseClient(adminUrl!);
    const role = await owner<{ exists: boolean }[]>`
      select exists(select 1 from pg_roles where rolname = 'seniorsocial_runtime') as exists
    `;
    if (!role[0]?.exists) throw new Error('seniorsocial_runtime must be provisioned by infrastructure before migration');

    await owner.unsafe('DROP SCHEMA IF EXISTS seniorsocial_meta CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    migrate('up');
    runtime = createDatabaseClient(runtimeDatabaseUrl!);
  }, 60_000);

  afterAll(async () => {
    const cleanup: Promise<unknown>[] = [];
    if (boss) cleanup.push(boss.stop({ graceful: false }));
    if (runtime) cleanup.push(runtime.end());
    await Promise.allSettled(cleanup);
    if (owner) await owner.end();
  });

  // what_bug_this_catches: the checked-in SQL drifts from pg-boss 12.26.3 or
  // grants the runtime ownership/DDL instead of the narrow data-plane rights.
  it('creates schema v37 without runtime ownership or arbitrary schema creation', async () => {
    const version = await owner<{ version: number }[]>`select version from pgboss.version`;
    expect(version).toEqual([{ version: 37 }]);

    const runtimeRole = await owner<{ rolsuper: boolean; rolcreatedb: boolean; rolcreaterole: boolean; rolbypassrls: boolean }[]>`
      select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
      from pg_roles where rolname = 'seniorsocial_runtime'
    `;
    expect(runtimeRole).toEqual([{ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false }]);

    const schema = await owner<{ owner: string }[]>`
      select pg_get_userbyid(nspowner) as owner from pg_namespace where nspname = 'pgboss'
    `;
    expect(schema[0]?.owner).not.toBe('seniorsocial_runtime');
    await expect(runtime.unsafe('CREATE SCHEMA runtime_must_not_create')).rejects.toThrow();
  });

  // what_bug_this_catches: migrate:false avoids DDL but lacks one of the table
  // or function grants needed to register and consume real queues.
  it('starts pg-boss with migrate false and completes a queued job', async () => {
    await startAndCompleteQueue('wp001.synthetic.runtime');
    expect(await boss.schemaVersion()).toBe(37);
    expect((await boss.detectSchemaDrift()).ok).toBe(true);
  }, 20_000);

  // what_bug_this_catches: a down/up reset strands pg-boss metadata or loses
  // the conditional grants needed by the already-provisioned runtime role.
  it('repeats deterministic down and up with the same scoped runtime access', async () => {
    await boss.stop({ graceful: false });
    await runtime.end();

    migrate('down');
    expect(await owner<{ schema: string | null }[]>`select to_regnamespace('pgboss')::text as schema`).toEqual([{ schema: null }]);
    migrate('up');

    runtime = createDatabaseClient(runtimeDatabaseUrl!);
    expect(await runtime<{ version: number }[]>`select version from pgboss.version`).toEqual([{ version: 37 }]);
    await expect(runtime.unsafe('CREATE SCHEMA runtime_still_must_not_create')).rejects.toThrow();
    await startAndCompleteQueue('wp001.synthetic.after-reset');
    expect(await boss.schemaVersion()).toBe(37);
    expect((await boss.detectSchemaDrift()).ok).toBe(true);
    await boss.stop({ graceful: false });
  }, 60_000);
});
