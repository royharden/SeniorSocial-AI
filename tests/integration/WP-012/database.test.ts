import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, withOrg, type DatabaseClient } from '../../../packages/db/src/index.ts';
import { createPostgresEventRepository, type EventIdentity } from '../../../packages/events/src/index.ts';

const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl && new URL(databaseUrl).pathname !== '/seniorsocial_wp012_test') {
  throw new Error('WP-012 live integration requires dedicated seniorsocial_wp012_test DATABASE_URL');
}

const liveDescribe = databaseUrl ? describe : describe.skip;
const orgId = '10000000-0000-4000-8000-000000000001';
const first: EventIdentity = { orgId, userId: '10000000-0000-4000-8000-000000000011', roles: ['senior'] };
const second: EventIdentity = { orgId, userId: '10000000-0000-4000-8000-000000000012', roles: ['senior'] };
const staffId = '10000000-0000-4000-8000-000000000021';
const eventId = '10000000-0000-4000-8000-000000000031';
const role = 'seniorsocial_wp012_test_login';
const rolePassword = 'synthetic-test-only';
const lockKey = `${orgId}:${eventId}`;
let owner: DatabaseClient;
let runtime: DatabaseClient;

const migration = (name: string) => readFile(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), 'utf8');

liveDescribe('WP-012 constrained-role PostgreSQL serialization', () => {
  beforeAll(async () => {
    if (!databaseUrl) throw new Error('WP-012 live integration database was not configured');
    owner = createDatabaseClient(databaseUrl);
    await owner.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.unsafe(await migration('0001_wp-003_core_tables.sql'));
    await owner.unsafe(await migration('0060_wp-012_events.sql'));
    await owner`insert into orgs (id, name, slug) values (${orgId}, 'Synthetic events org', 'wp012-events')`;
    await owner`insert into users (id, org_id, display_name) values
      (${first.userId}, ${orgId}, 'First resident'),
      (${second.userId}, ${orgId}, 'Second resident'),
      (${staffId}, ${orgId}, 'Event staff')`;
    await owner`insert into user_roles (org_id, user_id, role) values
      (${orgId}, ${first.userId}, 'senior'), (${orgId}, ${second.userId}, 'senior'), (${orgId}, ${staffId}, 'staff')`;
    await owner`insert into events (id, org_id, title, starts_at, time_zone, location, capacity, published_at, created_by)
      values (${eventId}, ${orgId}, 'One-seat event', '2027-03-14T07:30:00Z', 'America/New_York', 'Test hall', 1, now(), ${staffId})`;
    await owner.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await owner.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD '${rolePassword}' IN ROLE seniorsocial_app`);
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = role;
    runtimeUrl.password = rolePassword;
    runtime = createDatabaseClient(runtimeUrl.toString());
  }, 30_000);

  afterAll(async () => {
    if (runtime) await runtime.end();
    if (owner) {
      await owner.unsafe(`DROP ROLE IF EXISTS ${role}`);
      await owner.end();
    }
  });

  // what_bug_this_catches: SELECT FOR UPDATE on immutable events requires an
  // UPDATE grant and makes every RSVP operation fail under seniorsocial_app.
  it('serializes RSVP, waitlist, and promotion without UPDATE on events', async () => {
    const privileges = await withOrg(runtime, orgId, sql => sql<{ canUpdate: boolean }[]>`
      select has_table_privilege(current_user, 'events', 'UPDATE') as "canUpdate"`);
    expect(privileges[0]?.canUpdate).toBe(false);

    let entered = () => {};
    const lockEntered = new Promise<void>(resolve => { entered = resolve; });
    let release = () => {};
    const releaseLock = new Promise<void>(resolve => { release = resolve; });
    const holder = withOrg(runtime, orgId, async sql => {
      await sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`;
      entered();
      await releaseLock;
    });
    await lockEntered;

    const repository = createPostgresEventRepository(runtime);
    const racing = Promise.all([repository.rsvp(first, eventId), repository.rsvp(second, eventId)]);
    let observedAdvisoryWait = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const rows = await owner<{ waiting: boolean }[]>`select exists(
        select 1 from pg_stat_activity where usename = ${role} and wait_event = 'advisory'
      ) as waiting`;
      if (rows[0]?.waiting) { observedAdvisoryWait = true; break; }
      await owner`select pg_sleep(0.01)`;
    }
    release();
    await holder;
    const results = await racing;
    expect(observedAdvisoryWait).toBe(true);
    expect(results.filter(result => result.kind === 'attending')).toHaveLength(1);
    expect(results.filter(result => result.kind === 'full')).toHaveLength(1);

    const winner = results[0]?.kind === 'attending' ? first : second;
    const waiter = winner === first ? second : first;
    expect(await repository.waitlist(waiter, eventId)).toMatchObject({ kind: 'waitlisted' });
    expect(await repository.cancel(winner, eventId)).toMatchObject({ cancelled: true, promotedUserId: waiter.userId });

    const states = await owner<{ user_id: string; state: string }[]>`
      select user_id, state from event_rsvps where org_id = ${orgId} and event_id = ${eventId} order by user_id`;
    expect(states.filter(row => row.state === 'attending')).toEqual([{ user_id: waiter.userId, state: 'attending' }]);
    expect(states.filter(row => row.state === 'cancelled')).toEqual([{ user_id: winner.userId, state: 'cancelled' }]);
  }, 30_000);
});
