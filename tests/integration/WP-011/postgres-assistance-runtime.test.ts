import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Identity } from '../../../packages/assistance/src/index.ts';
import { createDatabaseClient, type DatabaseClient } from '../../../packages/db/src/index.ts';
import { createPostgresConciergeAssistanceAdapter } from '../../../apps/web/app/api/v1/concierge/_runtime.ts';

const suppliedDatabaseUrl = process.env.DATABASE_URL;
const dedicatedDatabase = (() => {
  try { return suppliedDatabaseUrl !== undefined && new URL(suppliedDatabaseUrl).pathname === '/seniorsocial_wp011_test'; }
  catch { return false; }
})();
const postgresSuite = dedicatedDatabase ? describe : describe.skip;
const databaseUrl = dedicatedDatabase ? suppliedDatabaseUrl as string : 'postgres://invalid:invalid@127.0.0.1:1/not_wp011';
const runtimeRole = 'seniorsocial_wp011_test_login';
const runtimePassword = 'synthetic-test-only';
const orgId = '99999999-1111-4111-8111-111111111111';
const userId = '99999999-1111-4111-8111-111111111101';
const identity: Identity = { orgId, userId, roles: ['senior'] };
const encryptionKey = Buffer.alloc(32, 11).toString('base64');
let owner: DatabaseClient;
let originalDatabaseUrl: string | undefined;
let originalDatabaseSsl: string | undefined;

function migrate(direction: 'up' | 'down'): void {
  execFileSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts', direction], {
    cwd: join(process.cwd(), 'packages', 'db'),
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL: 'disable' },
    stdio: 'pipe',
  });
}

postgresSuite('WP-011 real PostgreSQL assistance composition', () => {
  beforeAll(async () => {
    migrate('down');
    migrate('up');
    owner = createDatabaseClient(databaseUrl);
    await owner.unsafe(`
      insert into orgs (id, name, slug) values ('${orgId}', 'WP-011 Synthetic Org', 'wp-011-synthetic');
      insert into users (id, org_id, display_name) values ('${userId}', '${orgId}', 'WP-011 Synthetic Resident');
      insert into user_roles (org_id, user_id, role) values ('${orgId}', '${userId}', 'senior');
      drop role if exists ${runtimeRole};
      create role ${runtimeRole} login password '${runtimePassword}' in role seniorsocial_app;
    `);
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    originalDatabaseUrl = process.env.DATABASE_URL;
    originalDatabaseSsl = process.env.DATABASE_SSL;
    process.env.DATABASE_URL = runtimeUrl.toString();
    process.env.DATABASE_SSL = 'disable';
  }, 60_000);

  afterAll(async () => {
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
    if (originalDatabaseSsl === undefined) delete process.env.DATABASE_SSL;
    else process.env.DATABASE_SSL = originalDatabaseSsl;
    if (owner) {
      await owner.unsafe(`drop role if exists ${runtimeRole}`);
      await owner.end();
    }
  });

  it('keeps one durable row for concurrent replay and a retry after a lost post-commit response', async () => {
    // what_bug_this_catches: process-local single-flight looks idempotent while separate PostgreSQL transactions duplicate a handoff.
    const adapter = createPostgresConciergeAssistanceAdapter({
      trustedIdentity: () => identity,
      encryptionKey: () => encryptionKey,
      timeZone: () => 'America/New_York',
    });
    const role = await owner<{ rolsuper: boolean; rolbypassrls: boolean; rolcreatedb: boolean; rolcreaterole: boolean }[]>`
      select rolsuper, rolbypassrls, rolcreatedb, rolcreaterole from pg_roles where rolname = ${runtimeRole}
    `;
    expect(role[0]).toEqual({ rolsuper: false, rolbypassrls: false, rolcreatedb: false, rolcreaterole: false });
    const shared = {
      orgId, actorId: userId, summary: 'Concierge handoff: I need meal delivery', locale: 'en' as const,
      idempotencyKey: 'wp011-concurrent-durable-key',
    };
    const [first, second] = await Promise.all([adapter.create(shared), adapter.create(shared)]);
    expect(second).toEqual(first);

    let committedId = '';
    const retryInput = { ...shared, idempotencyKey: 'wp011-lost-response-key' };
    await expect(adapter.create(retryInput).then(created => {
      committedId = created.id;
      throw new Error('simulated response connection loss after commit');
    })).rejects.toThrow('simulated response connection loss after commit');
    const retry = await adapter.create(retryInput);
    expect(retry.id).toBe(committedId);

    const rows = await owner<{ id: string; idempotency_key: string; count: number }[]>`
      select min(id::text) as id, idempotency_key, count(*)::int as count
      from assistance_requests
      where org_id = ${orgId} and requester_id = ${userId}
        and idempotency_key in (${shared.idempotencyKey}, ${retryInput.idempotencyKey})
      group by idempotency_key
      order by idempotency_key
    `;
    expect(rows).toEqual([
      { id: first.id, idempotency_key: shared.idempotencyKey, count: 1 },
      { id: committedId, idempotency_key: retryInput.idempotencyKey, count: 1 },
    ]);
  }, 30_000);

  it('rolls back a durable request when mandatory audit fails and permits the same-key retry', async () => {
    // what_bug_this_catches: an assistance row survives a failed mandatory audit, or its idempotency key becomes poisoned after rollback.
    const adapter = createPostgresConciergeAssistanceAdapter({
      trustedIdentity: () => identity,
      encryptionKey: () => encryptionKey,
      timeZone: () => 'America/New_York',
    });
    const retryInput = {
      orgId, actorId: userId, summary: 'Concierge handoff: rollback and retry', locale: 'en' as const,
      idempotencyKey: 'wp011-audit-rollback-key',
    };
    await owner.unsafe(`
      alter table audit_events add constraint wp011_reject_assistance_opened
      check (action <> 'assistance.opened') not valid;
    `);
    try {
      await expect(adapter.create(retryInput)).rejects.toThrow();
      const rolledBack = await owner<{ count: number }[]>`
        select count(*)::int as count from assistance_requests
        where org_id = ${orgId} and requester_id = ${userId} and idempotency_key = ${retryInput.idempotencyKey}
      `;
      expect(rolledBack[0]?.count).toBe(0);
    } finally {
      await owner.unsafe('alter table audit_events drop constraint if exists wp011_reject_assistance_opened');
    }
    const retried = await adapter.create(retryInput);
    const durable = await owner<{ id: string; count: number }[]>`
      select min(id::text) as id, count(*)::int as count from assistance_requests
      where org_id = ${orgId} and requester_id = ${userId} and idempotency_key = ${retryInput.idempotencyKey}
    `;
    expect(durable[0]).toEqual({ id: retried.id, count: 1 });
  }, 30_000);
});
