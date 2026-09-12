import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient } from '../../../packages/db/src/index.ts';
import { createIntakeNarrativeCipher, createIntakeService, createPostgresIntakeRepository } from '../../../packages/intake/src/index.ts';
import { createSubmitIntakeHandler } from '../../../apps/web/app/api/v1/intake/_submit.ts';
import { withIntakeRuntimeTransaction } from '../../../apps/web/app/api/v1/intake/_runtime.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/seniorsocial_wp018_d6') {
  throw new Error('WP-018 live save regression requires a dedicated seniorsocial_wp018_d6 DATABASE_URL');
}

const owner = createDatabaseClient(databaseUrl);
const runtimeRole = 'seniorsocial_wp018_d6_login';
const runtimePassword = 'synthetic-test-only';
const runtimeUrl = new URL(databaseUrl);
runtimeUrl.username = runtimeRole;
runtimeUrl.password = runtimePassword;
const orgId = '54000000-0000-4000-8000-000000000040';
const residentId = '54000000-0000-4000-8000-000000000041';
const actor = { id: residentId, orgId, roles: ['senior'] as const };
const narrative = 'Synthetic private intake detail for encryption proof';
let runtime: ReturnType<typeof createDatabaseClient>;

describe('WP-018 live PostgreSQL intake save route', () => {
  beforeAll(async () => {
    await owner.unsafe(`drop role if exists ${runtimeRole}`);
    await owner.unsafe(`create role ${runtimeRole} login password '${runtimePassword}' in role seniorsocial_app`);
    await owner`insert into orgs (id,name,slug) values (${orgId},'WP-018 D6','wp018-d6') on conflict (id) do nothing`;
    await owner`insert into users (id,org_id,display_name) values (${residentId},${orgId},'WP-018 Resident') on conflict (id) do nothing`;
    await owner`insert into user_roles (org_id,user_id,role) values (${orgId},${residentId},'senior') on conflict do nothing`;
    runtime = createDatabaseClient(runtimeUrl.toString());
  });

  afterAll(async () => {
    if (runtime) await runtime.end();
    await owner.unsafe(`drop role if exists ${runtimeRole}`);
    await owner.end();
  });

  it('persists the browser-shaped encrypted draft through the constrained runtime role', async () => {
    // what_bug_this_catches: passing the repository's plain { query } adapter to the tagged-SQL
    // runtime-role guard throws before persistence and is masked by the public route as HTTP 500.
    const transaction = <T>(tenant: string, work: Parameters<typeof withIntakeRuntimeTransaction<T>>[2]) =>
      withIntakeRuntimeTransaction(runtime, tenant, work);
    const cipher = createIntakeNarrativeCipher(Buffer.alloc(32, 18).toString('base64'));
    const repository = createPostgresIntakeRepository(transaction, () => cipher);
    const intake = createIntakeService({ repository, authorization: {
      canManage: (identity, resident) => Promise.resolve(identity.id === resident && identity.roles.includes('senior')),
    } });
    const handler = createSubmitIntakeHandler('legal', { authorize: () => Promise.resolve(actor), intake });
    const response = await handler(new Request('http://local/api/v1/intake/legal', { method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': 'wp018-live-save-route-001' },
      body: JSON.stringify({ answers: { topic: 'housing', details: narrative }, disclaimer_acknowledged: false,
        locale: 'en', intent: 'save_draft' }),
    }));
    expect(response.status).toBe(201);
    const saved = await response.json() as { id: string; state: string; answers: Record<string, unknown> };
    expect(saved).toMatchObject({ state: 'draft', answers: { topic: 'housing', details: narrative } });
    const rows = await owner<{ encoded: string }[]>`select encode(answers_ciphertext,'escape') as encoded
      from intake_submissions where org_id=${orgId} and id=${saved.id}`;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.encoded).not.toContain(narrative);
  });
});
