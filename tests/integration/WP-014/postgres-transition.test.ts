import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AssistanceService, FixedUtcBusinessHours, PostgresAssistanceRepository,
  type Identity, type NarrativeCodec,
} from '../../../packages/assistance/src/index.ts';
import { createDatabaseClient, type DatabaseClient } from '../../../packages/db/src/index.ts';

const suppliedDatabaseUrl = process.env.WP014_TRANSITION_DATABASE_URL;
const dedicatedDatabase = (() => {
  try { return suppliedDatabaseUrl !== undefined && new URL(suppliedDatabaseUrl).pathname === '/seniorsocial_wp014_transition_test'; }
  catch { return false; }
})();
const postgresSuite = dedicatedDatabase ? describe : describe.skip;
const databaseUrl = dedicatedDatabase ? suppliedDatabaseUrl as string : 'postgres://invalid:invalid@127.0.0.1:1/not_wp014';
const runtimeRole = 'seniorsocial_wp014_transition_login';
const runtimePassword = 'synthetic-test-only';
const orgId = '14000000-0000-4000-8000-000000000001';
const otherOrgId = '14000000-0000-4000-8000-000000000002';
const residentId = '14000000-0000-4000-8000-000000000011';
const staffId = '14000000-0000-4000-8000-000000000012';
const resident: Identity = { orgId, userId: residentId, roles: ['senior'] };
const staff: Identity = { orgId, userId: staffId, roles: ['staff'] };
const codec: NarrativeCodec = {
  seal: value => Promise.resolve(`sealed:${value}`),
  open: value => Promise.resolve(value.slice(7)),
};
let owner: DatabaseClient;
let runtime: DatabaseClient;

function migrate(direction: 'up' | 'down'): void {
  execFileSync('node', ['--import', 'tsx', 'src/migrate.ts', direction], {
    cwd: join(process.cwd(), 'packages', 'db'),
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL: 'disable' },
    stdio: 'pipe',
  });
}

function serviceFor(requestIds: string[]) {
  const repository = new PostgresAssistanceRepository(runtime, codec);
  return {
    repository,
    service: new AssistanceService({
      repository,
      codec,
      ids: { next: () => requestIds.shift() ?? '14000000-0000-4000-8000-000000000099' },
      hours: new FixedUtcBusinessHours(),
      now: () => new Date('2026-09-10T14:00:00.000Z'),
      authorization: { authorize: identity => Promise.resolve(identity.orgId === orgId) },
    }),
  };
}

postgresSuite('WP-014 PostgreSQL transition response', () => {
  beforeAll(async () => {
    migrate('down');
    migrate('up');
    owner = createDatabaseClient(databaseUrl);
    await owner.unsafe(`
      insert into orgs (id, name, slug) values
        ('${orgId}', 'WP-014 transition org', 'wp-014-transition'),
        ('${otherOrgId}', 'WP-014 other org', 'wp-014-other');
      insert into users (id, org_id, display_name) values
        ('${residentId}', '${orgId}', 'Synthetic resident'),
        ('${staffId}', '${orgId}', 'Synthetic staff');
      insert into user_roles (org_id, user_id, role) values
        ('${orgId}', '${residentId}', 'senior'),
        ('${orgId}', '${staffId}', 'staff');
      drop role if exists ${runtimeRole};
      create role ${runtimeRole} login password '${runtimePassword}' in role seniorsocial_app;
    `);
    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.username = runtimeRole;
    runtimeUrl.password = runtimePassword;
    runtime = createDatabaseClient(runtimeUrl.toString());
  }, 60_000);

  afterAll(async () => {
    if (runtime) await runtime.end();
    if (owner) {
      await owner.unsafe(`drop role if exists ${runtimeRole}`);
      await owner.end();
    }
  });

  it('returns and reads the committed owner while one concurrent stale transition wins', async () => {
    // what_bug_this_catches: a data-modifying CTE returns the pre-transition snapshot or admits two departures.
    const requestId = '14000000-0000-4000-8000-000000000021';
    const { repository, service } = serviceFor([requestId]);
    await service.create(resident, { summary: 'Need food assistance', idempotencyKey: 'wp014-transition-race' });

    const outcomes = await Promise.allSettled([
      service.transition(staff, requestId, { to: 'owned', ownerId: staffId, reason: 'first claim' }),
      service.transition(staff, requestId, { to: 'owned', ownerId: staffId, reason: 'second claim' }),
    ]);
    const winners = outcomes.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.transition>>> => result.status === 'fulfilled');
    expect(winners, outcomes.map(result => result.status === 'fulfilled'
      ? `fulfilled:${result.value.state}`
      : `rejected:${String(result.reason)}`).join('\n')).toHaveLength(1);
    expect(winners[0]?.value).toMatchObject({ id: requestId, state: 'owned', ownerId: staffId });
    expect(await service.get(resident, requestId)).toMatchObject({ state: 'owned', ownerId: staffId });
    expect(await repository.transaction(otherOrgId, transaction => transaction.find(requestId))).toBeNull();

    const history = await owner<{ from_state: string | null; to_state: string; owner_id: string | null }[]>`
      select from_state, to_state, owner_id from assistance_transitions
      where org_id = ${orgId} and request_id = ${requestId} order by sequence
    `;
    expect(history).toEqual([
      { from_state: null, to_state: 'pending_unowned', owner_id: null },
      { from_state: 'pending_unowned', to_state: 'owned', owner_id: staffId },
    ]);
  }, 30_000);

  it('rolls back the transition when its mandatory audit cannot commit', async () => {
    // what_bug_this_catches: the response repair escapes the transaction and leaves state changed without its audit.
    const requestId = '14000000-0000-4000-8000-000000000022';
    const { service } = serviceFor([requestId]);
    await service.create(resident, { summary: 'Need housing assistance', idempotencyKey: 'wp014-transition-rollback' });
    await owner.unsafe(`alter table audit_events add constraint wp014_reject_owned check (action <> 'assistance.owned') not valid`);
    try {
      await expect(service.transition(staff, requestId, { to: 'owned', ownerId: staffId, reason: 'must roll back' })).rejects.toThrow();
    } finally {
      await owner.unsafe('alter table audit_events drop constraint if exists wp014_reject_owned');
    }
    expect(await service.get(resident, requestId)).toMatchObject({ state: 'pending_unowned', ownerId: null });
    const history = await owner<{ to_state: string }[]>`
      select to_state from assistance_transitions where org_id = ${orgId} and request_id = ${requestId} order by sequence
    `;
    expect(history).toEqual([{ to_state: 'pending_unowned' }]);
  }, 30_000);
});
