import type { DatabaseClient } from '../../src/client.ts';
import {
  DEMO_ASSISTANCE_REQUEST_ID, DEMO_ASSISTANCE_SUMMARY, DEMO_FIXTURE_VERSION, DEMO_ORG_ID,
  DEMO_RESET_VERSION, expectedDemoCounts,
} from './data.ts';
import { clearPostMigrationDemoState, readDemoCounts, seedDemoJourneyFixtures, type DemoSeedSql } from './journey.ts';

export interface DemoResetActor { orgId: string; userId: string }
export interface DemoResetResult { fixtureVersion: string; counts: Record<string, number>; elapsedMs: number }
export interface DemoAssistanceNarrativeCodec { seal(plaintext: string): Promise<string> }

export async function resetDemoFixture(
  client: DatabaseClient,
  actor: DemoResetActor,
  pepper: string,
  assistanceCodec: DemoAssistanceNarrativeCodec,
): Promise<DemoResetResult> {
  if (actor.orgId !== DEMO_ORG_ID) throw new Error('demo reset is available only for the designated synthetic tenant');
  if (pepper.length < 16) throw new Error('AUTH_TOKEN_PEPPER must contain at least 16 characters');
  if (!assistanceCodec || typeof assistanceCodec.seal !== 'function') {
    throw new Error('ASSISTANCE_ENCRYPTION_KEY must configure an assistance narrative codec');
  }
  const assistanceCiphertext = await assistanceCodec.seal(DEMO_ASSISTANCE_SUMMARY);
  const started = performance.now();
  const payload = await client.begin(async transaction => {
    await transaction`select set_config('app.current_org_id', ${actor.orgId}, true)`;
    await transaction`select set_config('app.current_user_id', ${actor.userId}, true)`;
    const sql = transaction as unknown as DemoSeedSql;
    await clearPostMigrationDemoState(sql);
    const rows = await transaction<Array<{ result: { fixture_version: string; counts: Record<string, number> } }>>`
      select seniorsocial_reset_demo(${actor.orgId}::uuid, ${actor.userId}::uuid, ${DEMO_RESET_VERSION}, ${pepper}) as result
    `;
    const result = rows[0]?.result;
    if (!result) throw new Error('demo reset returned no result');
    if (result.fixture_version !== DEMO_RESET_VERSION) throw new Error(`demo base fixture version drift: ${result.fixture_version}`);
    const existingAssistance = await transaction<Array<{ exists: boolean }>>`
      select exists (
        select 1 from assistance_requests
        where org_id=${actor.orgId}::uuid and id=${DEMO_ASSISTANCE_REQUEST_ID}::uuid
      ) as exists
    `;
    if (existingAssistance[0]?.exists) {
      // Already-applied 0180 functions created this exact deterministic row
      // with a placeholder. Only the immutable-request trigger blocks the
      // maintenance repair; transaction rollback restores it on any failure.
      await transaction`alter table assistance_requests disable trigger assistance_requests_identity_immutable`;
      await transaction`
        update assistance_requests set summary_ciphertext=${assistanceCiphertext}
        where org_id=${actor.orgId}::uuid and id=${DEMO_ASSISTANCE_REQUEST_ID}::uuid
      `;
      await transaction`alter table assistance_requests enable trigger assistance_requests_identity_immutable`;
    } else {
      await transaction`
        insert into assistance_requests (
          id, org_id, requester_id, summary_ciphertext, locale, triage_category,
          triage_source, after_hours, idempotency_key, created_at
        ) values (
          ${DEMO_ASSISTANCE_REQUEST_ID}::uuid, ${actor.orgId}::uuid,
          '34000000-0000-4000-8000-000000000001'::uuid, ${assistanceCiphertext},
          'en', 'transportation', 'rules', false, 'demo-assistance-v1', '2026-09-11T14:00:00Z'::timestamptz
        )
      `;
      await transaction`
        insert into assistance_transitions (
          id, org_id, request_id, actor_id, from_state, to_state, owner_id, reason, at
        ) values (
          '34000000-0000-4000-8200-000000000002'::uuid, ${actor.orgId}::uuid,
          ${DEMO_ASSISTANCE_REQUEST_ID}::uuid, '34000000-0000-4000-8000-000000000001'::uuid,
          null, 'pending_unowned', null, 'synthetic_demo_open', '2026-09-11T14:00:00Z'::timestamptz
        )
      `;
      await transaction`
        insert into sla_clocks (org_id, request_id, due_at)
        values (${actor.orgId}::uuid, ${DEMO_ASSISTANCE_REQUEST_ID}::uuid, '2026-09-11T16:00:00Z'::timestamptz)
      `;
    }
    await seedDemoJourneyFixtures(sql);
    const counts = await readDemoCounts(sql);
    for (const [table, expected] of Object.entries(expectedDemoCounts)) {
      if (counts[table] !== expected) throw new Error(`demo fixture count drift for ${table}: expected ${expected}, received ${String(counts[table])}`);
    }
    return { fixture_version: DEMO_FIXTURE_VERSION, counts };
  });
  return { fixtureVersion: payload.fixture_version, counts: payload.counts, elapsedMs: Math.round(performance.now() - started) };
}
