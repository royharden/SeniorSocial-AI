import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DurableRateLimiter, DurableReservationStore } from '../../../packages/ai/src/index.ts';
import { createDatabaseClient, withOrg } from '../../../packages/db/src/index.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/seniorsocial_wp008_test') {
  throw new Error('WP-008 integration tests require a dedicated seniorsocial_wp008_test DATABASE_URL');
}

const owner = createDatabaseClient(databaseUrl);
const packageRoot = resolve('packages/db');
const runtimeRole = 'seniorsocial_wp008_test_login';
const runtimePassword = 'synthetic-test-only';
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = runtimeRole;
runtimeUrl.password = runtimePassword;
const maple = '11111111-1111-4111-8111-111111111111';
const cedar = '22222222-2222-4222-8222-222222222222';
const mapleUser = '11111111-1111-4111-8111-111111111101';
const cedarUser = '22222222-2222-4222-8222-222222222201';
let runtime: ReturnType<typeof createDatabaseClient>;

function migrate(direction: 'up' | 'down'): void {
  execFileSync(process.execPath, ['--import', 'tsx', 'src/migrate.ts', direction], {
    cwd: packageRoot,
    env: { ...process.env, DATABASE_URL: databaseUrl, DATABASE_SSL: 'disable' },
    stdio: 'pipe',
  });
}

describe('WP-008 PostgreSQL integration', () => {
  beforeAll(async () => {
    migrate('down');
    migrate('up');
    await owner`insert into orgs (id, name, slug) values (${maple}, 'Maple Test', 'maple-test'), (${cedar}, 'Cedar Test', 'cedar-test')`;
    await owner`insert into users (id, org_id, display_name) values (${mapleUser}, ${maple}, 'Maple Senior'), (${cedarUser}, ${cedar}, 'Cedar Senior')`;
    await owner`insert into ai_cost_caps (org_id, feature, daily_cap_usd, total_cap_usd) values (${maple}, 'concierge', 10, 20), (${cedar}, 'concierge', 10, 20)`;
    await owner`insert into ai_org_cost_caps (org_id, daily_cap_usd, total_cap_usd) values (${maple}, 20, 40), (${cedar}, 20, 40)`;
    await owner.unsafe(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await owner.unsafe(`CREATE ROLE ${runtimeRole} LOGIN PASSWORD '${runtimePassword}' IN ROLE seniorsocial_app`);
    runtime = createDatabaseClient(runtimeUrl.toString());
  }, 30_000);

  afterAll(async () => {
    if (runtime) await runtime.end();
    await owner.unsafe(`DROP ROLE IF EXISTS ${runtimeRole}`);
    await owner.end();
  });

  it('reserves, records an attempt through the granted sequence, and settles durably', async () => {
    const reservations = new DurableReservationStore(runtime);
    const reservation = await reservations.reserve({
      orgId: maple,
      feature: 'concierge',
      requestId: 'req-live-success',
      reservedUsd: 0.5,
      maxOutputTokens: 100,
    });
    await reservations.addAttempt(maple, reservation.id, 'initial', 'stub-v1', {
      tokensIn: 8,
      tokensOut: 4,
      tokensCached: 0,
    });
    await reservations.settle(maple, reservation.id, 0.1);

    const rows = await owner<{ state: string; settled_usd: number; attempts: number }[]>`
      select r.state, r.settled_usd::float8 as settled_usd, count(a.id)::int as attempts
      from ai_cost_reservations r left join ai_cost_attempts a on a.reservation_id = r.id
      where r.id = ${reservation.id} group by r.id
    `;
    expect(rows).toEqual([{ state: 'settled', settled_usd: 0.1, attempts: 1 }]);
  });

  it('keeps reservations tenant-isolated and rejects a cross-tenant transition', async () => {
    const reservations = new DurableReservationStore(runtime);
    const reservation = await reservations.reserve({
      orgId: maple,
      feature: 'concierge',
      requestId: 'req-live-isolation',
      reservedUsd: 0.25,
      maxOutputTokens: 50,
    });

    const cedarRows = await withOrg(runtime, cedar, transaction => transaction<{ id: string }[]>`
      select id from ai_cost_reservations where id = ${reservation.id}
    `);
    expect(cedarRows).toEqual([]);
    await expect(reservations.release(cedar, reservation.id)).rejects.toThrow('reservation not found');
  });

  it('persists bounded user and feature rate-limit decisions', async () => {
    const limiter = new DurableRateLimiter(runtime, 1, 2, 60);
    const context = { orgId: maple, userId: mapleUser, userRole: 'senior' as const, locale: 'en' as const, requestId: 'req-rate' };
    expect(await limiter.consume(context, 'concierge')).toMatchObject({ allowed: true, userRemaining: 0, featureRemaining: 1 });
    expect(await limiter.consume(context, 'concierge')).toMatchObject({ allowed: false, userRemaining: 0, featureRemaining: 1 });

    const observations = await owner<{ denied: boolean }[]>`
      select denied from ai_rate_limit_observations where org_id = ${maple} order by observed_at
    `;
    expect(observations).toEqual([{ denied: false }, { denied: true }]);
  });
});
