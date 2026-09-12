import { execFile, execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient } from '../../src/client.ts';
import { findUserById, withOrg } from '../../src/tenant.ts';

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/seniorsocial_wp003_test') {
  throw new Error('WP-003 integration tests require a dedicated seniorsocial_wp003_test DATABASE_URL');
}
const owner = postgres(databaseUrl, { max: 1 });
const runtimeRole = 'seniorsocial_wp003_test_login';
const runtimePassword = 'synthetic-test-only';
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = runtimeRole;
runtimeUrl.password = runtimePassword;
let runtime: ReturnType<typeof postgres>;
let resetProfileIds: string[] = [];
let blankExtensionNames: string[] = [];
let concurrentTableCount = 0;
let downTableCount = 0;
const execFileAsync = promisify(execFile);

function migration(direction: 'up' | 'down', url = databaseUrl) {
  execFileSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts', direction], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: url, DATABASE_SSL: 'disable' },
    stdio: 'pipe',
  });
}

async function migrationAsync(direction: 'up' | 'down', url = databaseUrl) {
  await execFileAsync(process.execPath, ['--import', 'tsx', 'src/migrate.ts', direction], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: url, DATABASE_SSL: 'disable' },
  });
}

function seed() {
  execFileSync(process.execPath, ['--import', 'tsx', 'seed/run.ts'], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL: 'disable' },
    stdio: 'pipe',
  });
}

describe('WP-003 PostgreSQL behavior', () => {
  beforeAll(async () => {
    const adminUrl = new URL(databaseUrl);
    adminUrl.pathname = '/postgres';
    const blankDatabase = 'seniorsocial_wp003_blank_test';
    const blankUrl = new URL(databaseUrl);
    blankUrl.pathname = `/${blankDatabase}`;
    const admin = postgres(adminUrl.toString(), { max: 1 });
    await admin.unsafe(`DROP DATABASE IF EXISTS ${blankDatabase} WITH (FORCE)`);
    await admin.unsafe(`CREATE DATABASE ${blankDatabase}`);
    await migrationAsync('up', blankUrl.toString());
    const blank = postgres(blankUrl.toString(), { max: 1 });
    const blankExtensions = await blank<{ extname: string }[]>`
      select extname from pg_extension where extname in ('uuid-ossp', 'citext') order by extname
    `;
    blankExtensionNames = blankExtensions.map(extension => extension.extname);
    await blank.end();
    await admin.unsafe(`DROP DATABASE ${blankDatabase} WITH (FORCE)`);
    await admin.end();

    migration('down');
    await Promise.all([migrationAsync('up'), migrationAsync('up')]);
    const firstTables = await owner<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name = 'users'
    `;
    concurrentTableCount = firstTables.length;
    migration('down');
    const removedTables = await owner<{ table_name: string }[]>`
      select table_name from information_schema.tables
      where table_schema = 'public' and table_name = 'users'
    `;
    downTableCount = removedTables.length;
    migration('up');
    seed();
    const beforeReset = await owner<{ id: string }[]>`select id from profiles order by id`;
    migration('down');
    migration('up');
    seed();
    const afterReset = await owner<{ id: string }[]>`select id from profiles order by id`;
    resetProfileIds = afterReset.map(profile => profile.id);
    expect(resetProfileIds).toEqual(beforeReset.map(profile => profile.id));
    seed();
    await owner.unsafe(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await owner.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' IN ROLE seniorsocial_app`);
    runtime = createDatabaseClient(runtimeUrl.toString());
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.end();
    await owner.unsafe(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await owner.end();
  });

  // what_bug_this_catches: blank databases lack required extensions, concurrent runners replay DDL, or down leaves WP-003 tables behind.
  it('CK-099 migrates blank and concurrent databases cleanly through up/down/up', () => {
    expect(blankExtensionNames).toEqual(['citext', 'uuid-ossp']);
    expect(concurrentTableCount).toBe(1);
    expect(downTableCount).toBe(0);
  });

  // what_bug_this_catches: a non-repeatable seed creates duplicate tenants or demo identities on reset.
  it('CK-099 seeds exactly two populated synthetic organisations repeatably', async () => {
    const orgCounts = await owner<{ count: number }[]>`
      select count(*)::int as count from orgs
    `;
    const populated = await owner<{ count: number }[]>`
      select count(*)::int as count
      from orgs o
      where exists (select 1 from users u where u.org_id = o.id)
        and exists (select 1 from service_categories c where c.org_id = o.id)
        and exists (select 1 from partners p where p.org_id = o.id)
    `;
    expect(orgCounts[0]?.count).toBe(2);
    expect(populated[0]?.count).toBe(2);
    expect(resetProfileIds).toEqual([
      '11111111-1111-4111-8111-111111111102',
      '22222222-2222-4222-8222-222222222202',
    ]);
  });

  // what_bug_this_catches: a new operational table omits org_id or makes it nullable, allowing unscoped data.
  it('CK-099 requires NOT NULL org_id on every operational table', async () => {
    const operationalTables = ['users', 'user_roles', 'profiles', 'service_categories', 'partners'];
    const columns = await owner<{ table_name: string; is_nullable: string }[]>`
      select table_name, is_nullable
      from information_schema.columns
      where table_schema = 'public' and column_name = 'org_id'
        and table_name in ${owner(operationalTables)}
      order by table_name
    `;
    expect(columns.map(column => column.table_name)).toEqual([...operationalTables].sort());
    expect(columns.every(column => column.is_nullable === 'NO')).toBe(true);
  });

  // what_bug_this_catches: the application role owns tables, bypasses RLS, leaks another tenant, or can truncate shared data.
  it('SEC-011/SEC-012/SEC-074 enforces tenant isolation below the repository', async () => {
    const role = await owner<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }[]>`
      select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole
      from pg_roles where rolname = 'seniorsocial_app'
    `;
    expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });

    const mapleOrg = '11111111-1111-4111-8111-111111111111';
    const cedarOrg = '22222222-2222-4222-8222-222222222222';
    const mapleUser = '11111111-1111-4111-8111-111111111101';
    const cedarUser = '22222222-2222-4222-8222-222222222201';
    expect((await findUserById(runtime, mapleOrg, mapleUser))?.display_name).toBe('Mara Example');
    expect(await findUserById(runtime, mapleOrg, cedarUser)).toBeNull();
    await expect(withOrg(runtime, mapleOrg, transaction => transaction`
      insert into profiles (org_id, user_id, preferred_name)
      values (${cedarOrg}, ${cedarUser}, 'Cross tenant')
    `)).rejects.toThrow();
    await expect(runtime.unsafe('TRUNCATE users')).rejects.toThrow();

    await owner`drop policy users_org_isolation on users`;
    const defaultDeny = await withOrg(runtime, mapleOrg, transaction => transaction<{ count: number }[]>`
      select count(*)::int as count from users
    `);
    expect(defaultDeny[0]?.count).toBe(0);
  });
});
