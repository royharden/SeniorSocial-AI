import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertConstrainedRuntimeRole,
  assertDedicatedAuthTestDatabase,
  AuthService,
  authRoleValues,
  bootstrapDemoAccounts,
  PostgresAuthStore,
  type AuthBeginClient,
  type AuthSql,
} from '../../src/index';

const clusterUrl = process.env.AUTH_TEST_CLUSTER_URL;
if (!clusterUrl) throw new Error('AUTH_TEST_CLUSTER_URL is required; live auth integration tests never skip');
const requiredClusterUrl: string = clusterUrl;
const PEPPER = 'wp004-live-postgres-pepper-value';
const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const databaseName = `seniorsocial_wp004_test_${process.pid}_${Date.now()}`;
const runtimeRole = `wp004_runtime_${process.pid}_${Date.now()}`;
const runtimePassword = `Wp004-${process.pid}-runtime`;
let admin: ReturnType<typeof postgres>;
let owner: ReturnType<typeof postgres>;
let runtime: ReturnType<typeof postgres>;

function databaseUrl(name: string): string {
  const url = new URL(requiredClusterUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

async function migration(name: string): Promise<string> {
  return readFile(resolve(process.cwd(), '..', 'db', 'migrations', name), 'utf8');
}

async function scoped<T>(orgId: string, work: (service: AuthService, sql: AuthSql) => Promise<T>, now?: Date): Promise<T> {
  return runtime.begin(async transaction => {
    const sql = transaction as unknown as AuthSql;
    await assertConstrainedRuntimeRole(sql);
    await transaction`select set_config('app.current_org_id', ${orgId}, true)`;
    return work(new AuthService(new PostgresAuthStore(sql), {
      pepper: PEPPER,
      ...(now ? { now: () => now } : {}),
      exposeSimulationCredentials: true,
    }), sql);
  }) as Promise<T>;
}

describe('live PostgreSQL auth behavior', () => {
  beforeAll(async () => {
    admin = postgres(requiredClusterUrl, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const isolatedUrl = databaseUrl(databaseName);
    process.env.AUTH_TEST_DB_ALLOWED = 'true';
    expect(assertDedicatedAuthTestDatabase(isolatedUrl)).toBe(isolatedUrl);
    owner = postgres(isolatedUrl, { max: 4 });
    await owner.unsafe(await migration('0001_wp-003_core_tables.sql'));
    await owner.unsafe(await migration('0010_wp-004_auth.sql'));
    await owner.unsafe(await migration('0011_wp-004_auth_rate_limits.sql'));

    // what_bug_this_catches: a down migration that cannot reverse the actual live migration chain.
    await owner.unsafe(await migration('0011_wp-004_auth_rate_limits.down.sql'));
    expect((await owner<{ name: string | null }[]>`select to_regclass('auth_rate_limits')::text as name`)[0]?.name).toBeNull();
    await owner.unsafe(await migration('0010_wp-004_auth.down.sql'));
    expect((await owner<{ name: string | null }[]>`select to_regclass('sessions')::text as name`)[0]?.name).toBeNull();
    await owner.unsafe(await migration('0010_wp-004_auth.sql'));
    await owner.unsafe(await migration('0011_wp-004_auth_rate_limits.sql'));

    await owner.unsafe(`create role "${runtimeRole}" login password '${runtimePassword}' noinherit nosuperuser nocreatedb nocreaterole nobypassrls`);
    await owner.unsafe(`grant usage on schema public to "${runtimeRole}"`);
    await owner.unsafe(`grant select on orgs, users, user_roles to "${runtimeRole}"`);
    await owner.unsafe(`grant select, insert, update, delete on verification_tokens, sessions, demo_accounts, recovery_contacts, auth_rate_limits to "${runtimeRole}"`);

    for (const [orgIndex, orgId] of [ORG_A, ORG_B].entries()) {
      await owner`insert into orgs (id, name, slug) values (${orgId}, ${`WP004 Org ${orgIndex}`}, ${`wp004-org-${orgIndex}`})`;
    }
    for (const [index, role] of authRoleValues.entries()) {
      const userId = `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;
      await owner`insert into users (id, org_id, display_name, email, phone, is_demo)
        values (${userId}, ${ORG_A}, ${`Demo ${role}`}, ${`${role}@example.invalid`}, ${`+15550000${String(index).padStart(2, '0')}`}, true)`;
      await owner`insert into user_roles (org_id, user_id, role) values (${ORG_A}, ${userId}, ${role}::user_role)`;
    }
    await owner`insert into users (id, org_id, display_name, email, phone, is_demo)
      values ('22222222-2222-4222-8222-222222222201', ${ORG_B}, 'Other Org', 'other@example.invalid', '+15559999999', true)`;
    await owner`insert into user_roles (org_id, user_id, role)
      values (${ORG_B}, '22222222-2222-4222-8222-222222222201', 'senior')`;

    const runtimeUrl = new URL(isolatedUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtime = postgres(runtimeUrl.toString(), { max: 20 });
  }, 30_000);

  afterAll(async () => {
    if (runtime) await runtime.end();
    if (owner) await owner.end();
    if (admin) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.unsafe(`drop role if exists "${runtimeRole}"`);
      await admin.end();
    }
    delete process.env.AUTH_TEST_DB_ALLOWED;
  });

  it('rejects owner/superuser runtime and accepts the constrained login', async () => {
    // what_bug_this_catches: application auth silently running as the migration owner and bypassing forced RLS.
    await expect(assertConstrainedRuntimeRole(owner as unknown as AuthSql)).rejects.toThrow(/dedicated LOGIN role/u);
    await expect(runtime.begin(async transaction => assertConstrainedRuntimeRole(transaction as unknown as AuthSql))).resolves.toBeUndefined();
  });

  it('establishes all three session types for every canonical role', async () => {
    // what_bug_this_catches: a role missing from real SQL joins, demo bootstrap, or either passwordless flow.
    for (const [index, role] of authRoleValues.entries()) {
      const userId = `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`;
      const magic = await scoped(ORG_A, service => service.requestMagicLink(ORG_A, `${role}@example.invalid`, `magic-${role}`, `10.0.0.${index + 1}`));
      const magicLogin = await scoped(ORG_A, service => service.verify(ORG_A, undefined, magic.simulationCredential!, `magic-${role}`));
      expect(magicLogin.ok && magicLogin.value.roles).toContain(role);

      const sms = await scoped(ORG_A, service => service.requestSmsCode(ORG_A, `+15550000${String(index).padStart(2, '0')}`, `sms-${role}`, `10.1.0.${index + 1}`));
      const smsLogin = await scoped(ORG_A, service => service.verify(ORG_A, undefined, sms.simulationCredential!, `sms-${role}`));
      expect(smsLogin.ok && smsLogin.value.roles).toContain(role);

      await scoped(ORG_A, service => service.bootstrapDemoAccount({
        orgId: ORG_A, userId, code: `LIVE-DEMO-${role}`, expiresAt: new Date(Date.now() + 60_000),
      }));
      const demoLogin = await scoped(ORG_A, service => service.loginWithDemoCode(
        ORG_A,
        `LIVE-DEMO-${role}`,
        `demo-${role}`,
        `10.4.0.${index + 1}`,
      ));
      expect(demoLogin.ok && demoLogin.value.roles).toContain(role);
    }
  });

  it('enforces org, expiry, and concurrent one-time redemption', async () => {
    // what_bug_this_catches: cross-org, expired, or two concurrent consumers both winning the same credential.
    const issued = await scoped(ORG_A, service => service.requestMagicLink(ORG_A, 'senior@example.invalid', 'race-browser', '10.2.0.1'));
    expect((await scoped(ORG_B, service => service.verify(ORG_B, undefined, issued.simulationCredential!, 'race-browser'))).ok).toBe(false);
    const results = await Promise.all([
      scoped(ORG_A, service => service.verify(ORG_A, undefined, issued.simulationCredential!, 'race-browser')),
      scoped(ORG_A, service => service.verify(ORG_A, undefined, issued.simulationCredential!, 'race-browser')),
    ]);
    expect(results.filter(result => result.ok)).toHaveLength(1);

    const start = new Date('2026-09-10T12:00:00Z');
    const expired = await scoped(ORG_A, service => service.requestSmsCode(ORG_A, '+1555000000', 'expired-browser', '10.2.0.2'), start);
    expect((await scoped(ORG_A, service => service.verify(ORG_A, undefined, expired.simulationCredential!, 'expired-browser'), new Date('2026-09-10T12:11:00Z'))).ok).toBe(false);
  });

  it('atomically limits concurrency, rolls windows, isolates orgs, and persists no raw subjects', async () => {
    // what_bug_this_catches: lost concurrent increments, stale windows, cross-tenant counters, or raw PII in limiter storage.
    const subjectDigest = 'a'.repeat(64);
    const now = new Date('2026-09-10T12:00:00Z');
    const increment = (orgId: string, at: Date) => runtime.begin(async transaction => {
      await transaction`select set_config('app.current_org_id', ${orgId}, true)`;
      return new PostgresAuthStore(transaction as unknown as AuthSql).incrementRateLimit({
        orgId, purpose: 'request_identifier', subjectDigest, now: at, windowSeconds: 60, limit: 3,
      });
    });
    const concurrent = await Promise.all(Array.from({ length: 5 }, () => increment(ORG_A, now)));
    expect(concurrent.map(result => result.count).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5]);
    expect(concurrent.filter(result => result.allowed)).toHaveLength(3);
    expect((await increment(ORG_B, now)).count).toBe(1);
    expect(await increment(ORG_A, new Date('2026-09-10T12:01:01Z'))).toMatchObject({ count: 1, allowed: true });

    const known = await scoped(ORG_A, service => service.requestMagicLink(ORG_A, 'caregiver@example.invalid', 'known', '10.3.0.1'));
    const unknown = await scoped(ORG_A, service => service.requestMagicLink(ORG_A, 'nobody@example.invalid', 'unknown', '10.3.0.2'));
    expect({ ...known, simulationCredential: undefined }).toEqual({ ...unknown, simulationCredential: undefined });
    const raw = await owner<{ found: boolean }[]>`
      select exists(
        select 1 from auth_rate_limits
          where subject_digest like '%example.invalid%' or subject_digest like '%10.%' or subject_digest like '%198.51.%'
        union all select 1 from verification_tokens where token_digest like '%example.invalid%'
      ) as found
    `;
    expect(raw[0]?.found).toBe(false);
  });

  it('forced RLS hides another org even from a direct runtime query', async () => {
    // what_bug_this_catches: application predicates passing while the runtime role still bypasses database tenant isolation.
    const counts = await runtime.begin(async transaction => {
      await transaction`select set_config('app.current_org_id', ${ORG_A}, true)`;
      return transaction<{ count: number }[]>`select count(*)::integer as count from users where org_id = ${ORG_B}`;
    });
    expect(counts[0]?.count).toBe(0);
  });

  it('durably rate-limits concurrent demo attempts by device', async () => {
    // what_bug_this_catches: concurrent demo guesses each reading the same pre-increment counter.
    const results = await Promise.all(Array.from({ length: 6 }, () => scoped(
      ORG_A,
      service => service.loginWithDemoCode(ORG_A, 'WRONG-DEMO', 'limited-demo-device', '10.9.0.1'),
    )));
    expect(results.filter(result => !result.ok && result.reason === 'rate_limited')).toHaveLength(1);
  });

  it('validates every org before atomically bootstrapping any demo account', async () => {
    // what_bug_this_catches: partial demo writes or one complete org masking another org's missing canonical roles.
    await owner`delete from demo_accounts`;
    const expiresAt = new Date(Date.now() + 60_000);
    const completeOrgA = authRoleValues.map((role, index) => ({
      orgId: ORG_A,
      userId: `11111111-1111-4111-8111-${String(index + 1).padStart(12, '0')}`,
      code: `ATOMIC-${role}`,
      expiresAt,
    }));
    await expect(bootstrapDemoAccounts(runtime as unknown as AuthBeginClient, [
      ...completeOrgA,
      {
        orgId: ORG_B,
        userId: '22222222-2222-4222-8222-222222222201',
        code: 'ATOMIC-OTHER',
        expiresAt,
      },
    ], PEPPER)).rejects.toThrow(/lacks roles/u);
    expect((await owner<{ count: number }[]>`select count(*)::integer as count from demo_accounts`)[0]?.count).toBe(0);

    await expect(bootstrapDemoAccounts(runtime as unknown as AuthBeginClient, completeOrgA, PEPPER)).resolves.toBe(6);
    const rows = await owner<{ count: number; plaintext: boolean }[]>`
      select count(*)::integer as count, bool_or(code_digest like 'ATOMIC-%') as plaintext from demo_accounts
    `;
    expect(rows[0]).toEqual({ count: 6, plaintext: false });
  });
});
