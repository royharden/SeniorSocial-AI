import assert from 'node:assert/strict';
import { createDatabaseClient } from '../../../packages/db/src/client.ts';
import { createPolicy, createPostgresConsentRepository } from '../../../packages/policy/src/index.ts';
import { createCaregiverService, PostgresCaregiverRepository } from '../../../packages/caregiver/src/index.ts';
import { createPostgresEventRepository } from '../../../packages/events/src/postgres.ts';
import { DEMO_ADMIN_ID, DEMO_ORG_ID, DEMO_RESIDENT_ID, DEMO_CAREGIVER_ID, DEMO_CAREGIVER_LINK_ID, DEMO_FULL_EVENT_ID, expectedDemoCounts } from '../../../packages/db/seed/demo/data.ts';
import { resetDemoFixture } from '../../../packages/db/seed/demo/reset.ts';
import { AesGcmNarrativeCodec } from '../../../packages/assistance/src/crypto.ts';

const ownerUrl = process.env.WP034_DISPOSABLE_DATABASE_URL;
const runtimeUrl = process.env.WP034_RUNTIME_DATABASE_URL;
if (!ownerUrl || !runtimeUrl) throw new Error('Both disposable owner and non-owner runtime database URLs are required');
const owner = createDatabaseClient(ownerUrl);
const runtime = createDatabaseClient(runtimeUrl);
const encryptionKey = Buffer.alloc(32, 34).toString('base64');
const codec = new AesGcmNarrativeCodec(encryptionKey);
const reset = () => resetDemoFixture(owner, { orgId: DEMO_ORG_ID, userId: DEMO_ADMIN_ID }, 'wp034-disposable-pepper', codec);
try {
  await reset();
  const policy = createPolicy(createPostgresConsentRepository(runtime), { emit: () => Promise.resolve() });
  const resident = { orgId: DEMO_ORG_ID, id: DEMO_RESIDENT_ID, roles: ['senior'] as const };
  const caregiver = { orgId: DEMO_ORG_ID, id: DEMO_CAREGIVER_ID, roles: ['caregiver'] as const };
  const request = { orgId: DEMO_ORG_ID, actor: caregiver, decisionActor: resident,
    actingForResidentId: DEMO_RESIDENT_ID, action: 'read' as const,
    resource: { id: DEMO_RESIDENT_ID, orgId: DEMO_ORG_ID, residentId: DEMO_RESIDENT_ID, kind: 'schedule' as const } };
  const service = createCaregiverService({ repository: new PostgresCaregiverRepository(runtime, async sql => {
    const [role] = await sql`select rolsuper or rolbypassrls or exists(select 1 from pg_class where relname='caregiver_links' and relowner=pg_roles.oid) as unsafe from pg_roles where rolname=current_user`;
    assert.equal(role?.unsafe, false);
  }),
    recipientDigestKey: 'synthetic-reviewer-digest-key-only-0255',
    delivery: { enqueue: () => Promise.reject(new Error('Journey rehearsal must not send invitations')) } });
  const identity = { orgId: DEMO_ORG_ID, userId: DEMO_RESIDENT_ID, roles: ['senior'] as const };
  // what_bug_this_catches: fixture link or accepted invitation silently pre-authorizes a caregiver.
  assert.equal((await policy.authorize(request)).allowed, false);
  await assert.rejects(service.setScopes(identity, DEMO_CAREGIVER_LINK_ID,
    { scopes: [{ key: 'view_schedule', granted: true }], read_back_confirmed: false }), { status: 404 });
  assert.equal((await policy.authorize(request)).allowed, false);
  const [beforeReadBack] = await owner`select
    (select count(*)::int from consent_grants where org_id=${DEMO_ORG_ID}::uuid) grants,
    (select count(*)::int from consent_scopes where org_id=${DEMO_ORG_ID}::uuid) scopes,
    (select count(*)::int from consent_read_backs where org_id=${DEMO_ORG_ID}::uuid) read_backs`;
  assert.deepEqual(beforeReadBack, { grants: 0, scopes: 0, read_backs: 0 });
  await service.setScopes(identity, DEMO_CAREGIVER_LINK_ID,
    { scopes: [{ key: 'view_schedule', granted: true }], read_back_confirmed: true });
  assert.equal((await policy.authorize(request)).allowed, true);
  await service.revoke(identity, DEMO_CAREGIVER_LINK_ID);
  assert.equal((await policy.authorize(request)).allowed, false);
  // what_bug_this_catches: a full fixture whose primary resident cannot actually join its waitlist.
  const events = createPostgresEventRepository(runtime);
  assert.deepEqual(await events.rsvp(identity, DEMO_FULL_EVENT_ID), { kind: 'full' });
  assert.equal((await events.waitlist(identity, DEMO_FULL_EVENT_ID)).kind, 'waitlisted');
  assert.deepEqual((await reset()).counts, expectedDemoCounts);
  await assert.rejects(owner.begin(async tx => {
    await tx`update users set is_demo=false where org_id=${DEMO_ORG_ID}::uuid and id=${DEMO_ADMIN_ID}::uuid`;
    await tx`select set_config('app.current_org_id',${DEMO_ORG_ID},true),set_config('app.current_user_id',${DEMO_ADMIN_ID},true)`;
    await tx`select seniorsocial_reset_demo(${DEMO_ORG_ID}::uuid,${DEMO_ADMIN_ID}::uuid,'wp-034.v1','wp034-disposable-pepper')`;
  }), { code: '42501' });
  console.log('PASS: non-owner runtime denies before read-back; confirms, authorizes, revokes; full event -> waitlist; reset restores zero authority. No browser/recording claim.');
} finally {
  await runtime.end();
  await owner.end();
}
