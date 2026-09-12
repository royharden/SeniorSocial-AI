import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPolicy, createPostgresConsentRepository, postgresOrgTransaction } from '../../../packages/policy/src/index.ts';
import type { AuditIntent, PolicyDatabase, PostgresFactory } from '../../../packages/policy/src/index.ts';
import { caregiver, change, orgId, otherOrg, resident, resourceId, staff } from '../../unit/WP-005/fixture.ts';

const require = createRequire(new URL('../../../packages/policy/package.json', import.meta.url));
const postgres = require('postgres') as PostgresFactory;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/seniorsocial_wp005_test') {
  throw new Error('WP-005 integration requires dedicated seniorsocial_wp005_test DATABASE_URL');
}
const owner = postgres(databaseUrl, { max: 1 });
let runtime: PolicyDatabase;
const intents: AuditIntent[] = [];
const role = 'seniorsocial_wp005_test_login';
const migration = (name: string) => readFile(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), 'utf8');

describe('WP-005 PostgreSQL repository and RLS', () => {
  beforeAll(async () => {
    // Database name guard above bounds this reset to the dedicated test database.
    await owner.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.unsafe(await migration('0001_wp-003_core_tables.sql'));
    const up = await migration('0020_wp-005_consent_policy.sql');
    await owner.unsafe(up);
    await owner.unsafe(await migration('0020_wp-005_consent_policy.down.sql'));
    await owner.unsafe(up);
    await owner`insert into orgs (id, name, slug) values (${orgId}, 'Synthetic A', 'a'), (${otherOrg}, 'Synthetic B', 'b')`;
    for (const person of [resident, caregiver, staff, { ...resident, id: resourceId, orgId: otherOrg }]) {
      await owner`insert into users (id, org_id, display_name) values (${person.id}, ${person.orgId}, 'Synthetic person')`;
      await owner`insert into user_roles (org_id, user_id, role) values (${person.orgId}, ${person.id}, ${person.roles[0] ?? 'senior'})`;
    }
    await owner.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await owner.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-test-only' IN ROLE seniorsocial_app`);
    const url = new URL(databaseUrl);
    url.username = role;
    url.password = 'synthetic-test-only';
    runtime = postgres(url.toString(), { max: 4 });
  });
  afterAll(async () => {
    if (runtime) await runtime.end();
    await owner.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await owner.end();
  });

  // what_bug_this_catches: repository caches authority, revokes whole links, or loses staff/resident attribution.
  it('persists separate scopes and attribution; immediate revoke survives a new policy instance', async () => {
    const store = createPostgresConsentRepository(runtime);
    const policy = createPolicy(store, { emit: intent => { intents.push(intent); return Promise.resolve(); } });
    expect(await policy.grant(change('book_rides', 0))).toMatchObject({ allowed: true, version: 1 });
    expect(await policy.grant(change('view_schedule', 1))).toMatchObject({ allowed: true, version: 2 });
    const key = { orgId, residentId: resident.id, caregiverId: caregiver.id };
    expect(await store.hasActiveScope({ ...key, scope: 'book_rides' })).toBe(true);
    expect(await policy.revoke(change('book_rides', 2))).toMatchObject({ allowed: true, version: 3 });
    const fresh = createPostgresConsentRepository(runtime);
    expect(await fresh.hasActiveScope({ ...key, scope: 'book_rides' })).toBe(false);
    expect(await fresh.hasActiveScope({ ...key, scope: 'view_schedule' })).toBe(true);
    const rows = await owner`select operation, entry_actor_id, decision_actor_id from consent_grants order by version`;
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).toMatchObject({ entry_actor_id: staff.id, decision_actor_id: resident.id });
    expect(intents.map(i => i.action)).toEqual(['consent.granted', 'consent.granted', 'consent.revoked']);
    expect(await policy.grant(change('book_rides', 0))).toMatchObject({ allowed: false });
  });

  // what_bug_this_catches: concurrent/stale read-backs both commit or rejected writes leave partial histories.
  it('serializes competing changes against the same link version', async () => {
    const policy = createPolicy(createPostgresConsentRepository(runtime), { emit: () => Promise.resolve() });
    const results = await Promise.all([policy.grant(change('view_profile', 3)), policy.grant(change('view_assistance', 3))]);
    expect(results.filter(r => r.allowed)).toHaveLength(1);
    expect(results.filter(r => !r.allowed)).toHaveLength(1);
    const rows = await owner`select version from consent_grants order by version`;
    expect(rows.map(r => r.version)).toEqual([1, 2, 3, 4]);
  });

  // what_bug_this_catches: runtime SQL rewinds the consent cursor to replay an old grant,
  // skips versions, or increments it without the corresponding applied scope/history.
  it('rejects direct cursor rewinds/jumps while normal repository changes still commit', async () => {
    const tx = postgresOrgTransaction(runtime);
    for (const version of [0, 6, 5]) {
      await expect(tx(orgId, sql => sql.query(`update caregiver_links set version = $1
        where resident_id = $2 and caregiver_id = $3`, [version, resident.id, caregiver.id])))
        .rejects.toMatchObject({ code: '23514' });
    }
    await expect(tx(orgId, sql => sql.query(`insert into caregiver_links
      (org_id, resident_id, caregiver_id, version) values ($1,$2,$3,42)`,
    [orgId, resident.id, caregiver.id]))).rejects.toMatchObject({ code: '23514' });
    await expect(tx(orgId, async sql => {
      await sql.query(`insert into consent_grants
        (org_id,link_id,scope,operation,entry_actor_id,decision_actor_id,version)
        select org_id,id,'receive_alerts','grant',$1,$2,5 from caregiver_links`, [staff.id, resident.id]);
      await sql.query('update caregiver_links set version = 5', []);
    })).rejects.toMatchObject({ code: '23514' }); // history without an applied scope cannot move the cursor
    expect(await owner`select version from caregiver_links`).toMatchObject([{ version: 4 }]);
    const policy = createPolicy(createPostgresConsentRepository(runtime), { emit: () => Promise.resolve() });
    expect(await policy.grant(change('receive_alerts', 4))).toMatchObject({ allowed: true, version: 5 });
    expect(await policy.revoke(change('receive_alerts', 5))).toMatchObject({ allowed: true, version: 6 });
    expect(await policy.grant(change('receive_alerts', 4))).toMatchObject({ allowed: false });
    expect(await owner`select version from caregiver_links`).toMatchObject([{ version: 6 }]);
  });

  // what_bug_this_catches: an expired or deactivated user's persisted scope remains usable.
  it('checks database expiry and account state on each request', async () => {
    const store = createPostgresConsentRepository(runtime);
    const key = { orgId, residentId: resident.id, caregiverId: caregiver.id, scope: 'view_schedule' as const };
    expect(await store.hasActiveScope(key)).toBe(true);
    await owner`update users set account_state = 'deactivated' where id = ${caregiver.id}`;
    expect(await store.hasActiveScope(key)).toBe(false);
    await owner`update users set account_state = 'active' where id = ${caregiver.id}`;
    await owner`update consent_scopes set granted_at = now() - interval '2 hours',
      expires_at = now() - interval '1 hour' where scope = 'view_schedule'`;
    expect(await store.hasActiveScope(key)).toBe(false);
  });

  // what_bug_this_catches: missing tenant RLS, cross-tenant FKs, owner-role testing, mutable decision history.
  it('enforces tenant isolation and append-only history below the repository', async () => {
    const tx = postgresOrgTransaction(runtime);
    for (const table of ['caregiver_links', 'consent_grants', 'consent_scopes', 'policy_decisions']) {
      const rows = await tx(otherOrg, sql => sql.query(`select * from ${table}`, []));
      expect(rows).toHaveLength(0);
      await expect(runtime.unsafe(`truncate ${table}`)).rejects.toThrow();
    }
    await expect(tx(orgId, sql => sql.query(`insert into caregiver_links (org_id, resident_id, caregiver_id)
      values ($1,$2,$3)`, [orgId, resourceId, caregiver.id]))).rejects.toThrow();
    await expect(tx(orgId, sql => sql.query(`insert into caregiver_links (org_id, resident_id, caregiver_id)
      values ($1,$2,$3)`, [otherOrg, resourceId, caregiver.id]))).rejects.toThrow();
    await expect(tx(orgId, sql => sql.query('update consent_grants set entry_actor_id = $1', [caregiver.id]))).rejects.toThrow();
    await expect(tx(orgId, sql => sql.query('delete from policy_decisions', []))).rejects.toThrow();
    await expect(tx(orgId, sql => sql.query(`update consent_scopes set revoked_at = null, revocation_id = null
      where scope = 'book_rides'`, []))).rejects.toMatchObject({ code: '23514' });
    await expect(tx(orgId, sql => sql.query(`insert into consent_scopes
      (org_id,link_id,grant_id,granted_by,granted_to,scope,resource,action,entry_actor_id,decision_actor_id,read_back_confirmed_at)
      select org_id,link_id,grant_id,granted_by,granted_to,scope,resource,'delete',entry_actor_id,decision_actor_id,read_back_confirmed_at
      from consent_scopes limit 1`, []))).rejects.toMatchObject({ code: '23514' });
    expect(await runtime`select * from consent_scopes`).toHaveLength(0); // transaction context cleared
    await owner`drop policy consent_scopes_org_isolation on consent_scopes`;
    expect(await tx(orgId, sql => sql.query('select * from consent_scopes', []))).toHaveLength(0);
  });
});
