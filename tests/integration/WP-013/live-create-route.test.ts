import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient } from '../../../packages/db/src/index.ts';
import { createPostgresRideRepository, createRideService } from '../../../packages/rides/src/index.ts';
import { createRidesHandlers } from '../../../apps/web/app/api/v1/rides/route.ts';
import { withRideRuntimeTransaction } from '../../../apps/web/app/api/v1/rides/_runtime.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/seniorsocial_wp013_d6') {
  throw new Error('WP-013 live create regression requires a dedicated seniorsocial_wp013_d6 DATABASE_URL');
}

const owner = createDatabaseClient(databaseUrl);
const runtimeRole = 'seniorsocial_wp013_d6_login';
const runtimePassword = 'synthetic-test-only';
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = runtimeRole;
runtimeUrl.password = runtimePassword;
const orgId = '53000000-0000-4000-8000-000000000030';
const residentId = '53000000-0000-4000-8000-000000000031';
const actor = { id: residentId, orgId, roles: ['senior'] as const };
let runtime: ReturnType<typeof createDatabaseClient>;

describe('WP-013 live PostgreSQL ride create route', () => {
  beforeAll(async () => {
    await owner.unsafe(`drop role if exists ${runtimeRole}`);
    await owner.unsafe(`create role ${runtimeRole} login password '${runtimePassword}' in role seniorsocial_app`);
    await owner`insert into orgs (id,name,slug) values (${orgId},'WP-013 D6','wp013-d6') on conflict (id) do nothing`;
    await owner`insert into users (id,org_id,display_name) values (${residentId},${orgId},'WP-013 Resident') on conflict (id) do nothing`;
    await owner`insert into user_roles (org_id,user_id,role) values (${orgId},${residentId},'senior') on conflict do nothing`;
    runtime = createDatabaseClient(runtimeUrl.toString());
  });

  afterAll(async () => {
    if (runtime) await runtime.end();
    await owner.unsafe(`drop role if exists ${runtimeRole}`);
    await owner.end();
  });

  it('persists the browser-shaped request and returns 201 through the constrained role', async () => {
    // what_bug_this_catches: passing the repository's plain { query } adapter to the tagged-SQL
    // runtime-role guard throws before persistence and is masked by the public route as HTTP 500.
    const transaction = <T>(tenant: string, work: Parameters<typeof withRideRuntimeTransaction<T>>[2]) =>
      withRideRuntimeTransaction(runtime, tenant, work);
    const repository = createPostgresRideRepository(transaction);
    const rides = createRideService({ repository,
      authorization: {
        canRead: () => Promise.resolve(true), canCreate: () => Promise.resolve(true),
        canListQueue: () => Promise.resolve(false), canTransition: () => Promise.resolve(false),
      },
      dispatch: { submit: input => Promise.resolve({ outcome: 'accepted_for_review', evidence: `local-queue:${input.idempotencyKey}` }) },
      confirmation: { evidence: () => Promise.resolve(null) }, events: { publish: () => Promise.resolve() },
      jobs: { enqueue: () => Promise.resolve() },
    });
    const handler = createRidesHandlers({ authorize: () => Promise.resolve(actor), rides });
    const response = await handler.POST(new Request('http://local/api/v1/rides', { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': '67796399-06da-43cb-9f2c-e62cd6f67d1a' },
      body: JSON.stringify({ purpose: 'medical', mode: 'partner_van', pickup_at: '2027-01-20T13:30:00.000Z',
        pickup_tz: 'America/New_York', pickup_location: 'home', destination_location: 'clinic', return_needed: false,
        accessibility_details: [{ code: 'wheelchair', label: 'I use a wheelchair' }] }),
    }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ state: 'waiting_for_dispatcher', send_state: 'sent',
      accessibility_details: [{ code: 'wheelchair', label: 'I use a wheelchair' }] });
  });
});
