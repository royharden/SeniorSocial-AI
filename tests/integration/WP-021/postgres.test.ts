import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, withOrg, type DatabaseClient } from '../../../packages/db/src/index';
import { PostgresQualifiedReviewerRegistry, PostgresTranslationRepository, TranslationWorkflow, assertTranslationRuntimeRole, createTranslationAuthorizer, sourceHash, type TranslationSql } from '../../../packages/i18n/src/index';

const databaseUrl = process.env.WP021_TEST_DATABASE_URL;
if (!databaseUrl) throw new Error('WP-021 live tests require the explicitly dedicated WP021_TEST_DATABASE_URL');
if (process.env.WP021_TEST_DB_ALLOWED !== 'true') throw new Error('WP-021 live tests require WP021_TEST_DB_ALLOWED=true for destructive isolated-schema setup');
const owner = createDatabaseClient(databaseUrl); const role = 'seniorsocial_wp021_test_login'; let runtime: DatabaseClient;
const orgA = randomUUID(); const orgB = randomUUID(); const staffA = randomUUID(); const reviewerA = randomUUID(); const staffB = randomUUID();
const aiEventA = randomUUID(); const wrongFeatureEvent = randomUUID(); const failedAiEvent = randomUUID(); const crossOrgAiEvent = randomUUID();
const migration = (name: string) => readFile(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), 'utf8');

describe('WP-021 live PostgreSQL workflow', () => {
  beforeAll(async () => {
    // what_bug_this_catches: an unsafe live test targeting a shared database or a migration that cannot round-trip.
    await owner.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.unsafe(await migration('0001_wp-003_core_tables.sql'));
    await owner.unsafe(await migration('0030_wp-006_audit_flags.sql'));
    await owner.unsafe(await migration('0031_wp-006_audit_fields.sql'));
    await owner.unsafe(await migration('0150_wp-021_translations.sql'));
    await owner.unsafe(await migration('0150_wp-021_translations.down.sql'));
    await owner.unsafe(await migration('0150_wp-021_translations.sql'));
    await owner`INSERT INTO orgs(id,name,slug) VALUES(${orgA},'A','wp021-a'),(${orgB},'B','wp021-b')`;
    await owner`INSERT INTO users(id,org_id,display_name) VALUES(${staffA},${orgA},'Staff A'),(${reviewerA},${orgA},'Reviewer A'),(${staffB},${orgB},'Staff B')`;
    await owner`INSERT INTO user_roles(org_id,user_id,role) VALUES(${orgA},${staffA},'staff'),(${orgA},${reviewerA},'admin'),(${orgB},${staffB},'staff')`;
    await owner`INSERT INTO ai_events(id,org_id,request_id,feature,provider,model,latency_ms,cache_hit,user_role,outcome,reason,cost_usd,usage_known) VALUES
      (${aiEventA},${orgA},'translate-ok','translation_assist','stub','stub',1,false,'staff','ok',NULL,0,true),
      (${wrongFeatureEvent},${orgA},'wrong-feature','concierge','stub','stub',1,false,'staff','ok',NULL,0,true),
      (${failedAiEvent},${orgA},'translate-failed','translation_assist','stub','stub',1,false,'staff','error','synthetic',0,true),
      (${crossOrgAiEvent},${orgB},'cross-org','translation_assist','stub','stub',1,false,'staff','ok',NULL,0,true)`;
    await owner.unsafe(`DROP ROLE IF EXISTS ${role}`); await owner.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-test-only' IN ROLE seniorsocial_app`);
    const url = new URL(databaseUrl); url.username = role; url.password = 'synthetic-test-only'; runtime = createDatabaseClient(url.toString());
    await withOrg(owner, orgA, async sql => { const result = await sql<{ granted: boolean }[]>`SELECT wp021_grant_translation_reviewer(${orgA},${reviewerA},'Synthetic qualified reviewer',${reviewerA},'Synthetic test grant') AS granted`; expect(result[0]?.granted).toBe(true); });
  }, 30_000);
  afterAll(async () => {
    if (runtime) await runtime.end();
    await owner.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await owner.end();
  });

  function withWorkflow<T>(orgId: string, work: (workflow: TranslationWorkflow) => Promise<T>) {
    return withOrg(runtime, orgId, sql => {
      const translationSql = sql as unknown as TranslationSql;
      return work(new TranslationWorkflow(new PostgresTranslationRepository(translationSql), createTranslationAuthorizer(new PostgresQualifiedReviewerRegistry(translationSql))));
    });
  }

  it('publishes reviewed manual copy and atomically invalidates it when source changes', async () => {
    // what_bug_this_catches: rendered Spanish remaining approved after its exact English bytes change.
    const source = await withWorkflow(orgA, workflow => workflow.updateSource({ orgId: orgA, userId: staffA, roles: ['staff'] }, { key: 'notice', text: 'Old source', critical: true }));
    const draft = await withWorkflow(orgA, workflow => workflow.draft({ orgId: orgA, userId: staffA, roles: ['staff'] }, { sourceId: source.id, text: 'Texto anterior' }));
    await withWorkflow(orgA, workflow => workflow.approve({ orgId: orgA, userId: reviewerA, roles: ['admin'] }, { draftId: draft.id, sourceHash: source.hash, sourceVersion: source.version, note: 'Synthetic review' }));
    await withWorkflow(orgA, workflow => workflow.publish({ orgId: orgA, userId: reviewerA, roles: ['admin'] }, { draftId: draft.id, sourceHash: source.hash, sourceVersion: source.version }));
    await withWorkflow(orgA, workflow => workflow.updateSource({ orgId: orgA, userId: staffA, roles: ['staff'] }, { key: 'notice', text: 'New source', critical: true }));
    expect((await owner<{ status: string; published_at: Date }[]>`SELECT status,published_at FROM translation_drafts WHERE id=${draft.id}`)[0]).toMatchObject({ status: 'invalidated' });
    expect(await owner`SELECT draft_id FROM current_published_translations WHERE org_id=${orgA} AND resource_key='notice'`).toHaveLength(0);
    expect(await owner`SELECT id FROM translation_events WHERE draft_id=${draft.id} AND event_type='invalidated'`).toHaveLength(1);
    expect(await owner`SELECT id FROM audit_events WHERE org_id=${orgA} AND action='translation.approved' AND target=${`translation:${draft.id}`}`).toHaveLength(1);
    expect(await owner`SELECT id FROM audit_events WHERE org_id=${orgA} AND action='translation.invalidated' AND target=${`translation:${draft.id}`}`).toHaveLength(1);
  });

  it('serializes two separately approved drafts racing to publish one source', async () => {
    // what_bug_this_catches: the partial unique index leaking a 23505/500 instead of one stable conflict loser.
    const current = (await owner<{ id: string; source_hash: string; source_version: number }[]>`SELECT id,source_hash,source_version FROM translation_sources WHERE org_id=${orgA} AND resource_key='notice'`)[0];
    if (!current) throw new Error('expected source');
    const drafts = await Promise.all(['Uno', 'Dos'].map(text => withWorkflow(orgA, workflow => workflow.draft({ orgId: orgA, userId: staffA, roles: ['staff'] }, { sourceId: current.id, text }))));
    for (const draft of drafts) await withWorkflow(orgA, workflow => workflow.approve({ orgId: orgA, userId: reviewerA, roles: ['admin'] }, { draftId: draft.id, sourceHash: current.source_hash, sourceVersion: Number(current.source_version), note: 'Synthetic review' }));
    const results = await Promise.allSettled(drafts.map(draft => withWorkflow(orgA, workflow => workflow.publish({ orgId: orgA, userId: reviewerA, roles: ['admin'] }, { draftId: draft.id, sourceHash: current.source_hash, sourceVersion: Number(current.source_version) }))));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await owner`SELECT draft_id FROM current_published_translations WHERE org_id=${orgA} AND resource_key='notice'`).toHaveLength(1);
    const listed=await withOrg(runtime,orgA,sql=>new PostgresTranslationRepository(sql as unknown as TranslationSql).list(orgA));
    expect(listed.flatMap(item=>item.history).filter(item=>item.status==='approved' && item.publishedAt===null)).toEqual([expect.objectContaining({publishable:false})]);
  });

  it('returns a newly approved sibling as immediately non-publishable after another draft is published', async () => {
    // what_bug_this_catches: an approve response briefly advertising a losing sibling as publishable.
    const source=await withWorkflow(orgA,workflow=>workflow.updateSource({orgId:orgA,userId:staffA,roles:['staff']},{key:'approve-after-publish',text:'One source',critical:true}));
    const [first,second]=await Promise.all(['Primero','Segundo'].map(text=>withWorkflow(orgA,workflow=>workflow.draft({orgId:orgA,userId:staffA,roles:['staff']},{sourceId:source.id,text}))));
    await withWorkflow(orgA,workflow=>workflow.approve({orgId:orgA,userId:reviewerA,roles:['admin']},{draftId:first.id,sourceHash:source.hash,sourceVersion:source.version,note:'First review'}));
    await withWorkflow(orgA,workflow=>workflow.publish({orgId:orgA,userId:reviewerA,roles:['admin']},{draftId:first.id,sourceHash:source.hash,sourceVersion:source.version}));
    const approvedSecond=await withWorkflow(orgA,workflow=>workflow.approve({orgId:orgA,userId:reviewerA,roles:['admin']},{draftId:second.id,sourceHash:source.hash,sourceVersion:source.version,note:'Second review'}));
    expect(approvedSecond).toMatchObject({id:second.id,status:'approved',publishable:false});
  });

  it('fails stale/replayed approvals and hides cross-org rows under the constrained login', async () => {
    // what_bug_this_catches: approval replay or tenant IDs disclosing/altering another organisation's draft.
    const rows = await withOrg(runtime, orgB, sql => sql`SELECT * FROM translation_sources`); expect(rows).toHaveLength(0);
    const existing = (await owner<{ id: string; source_hash: string; source_version: number }[]>`SELECT id,source_hash,source_version FROM translation_drafts LIMIT 1`)[0];
    if (!existing) throw new Error('expected fixture draft');
    await expect(withWorkflow(orgB, workflow => workflow.approve({ orgId: orgB, userId: staffB, roles: ['staff'] }, { draftId: existing.id, sourceHash: existing.source_hash, sourceVersion: Number(existing.source_version), note: 'forged' }))).rejects.toThrow();
  });

  it('derives hashes in PostgreSQL and accepts only same-org successful translation-assist evidence', async () => {
    // what_bug_this_catches: poisoned hashes or arbitrary/wrong-feature/cross-org AI event IDs being persisted as machine provenance.
    await withOrg(runtime, orgA, async sql => {
      const repository = new PostgresTranslationRepository(sql as unknown as TranslationSql);
      const created = await repository.upsertSource({ orgId: orgA, key: 'hash-proof', text: 'Exact UTF-8 café', hash: '0'.repeat(64), critical: false, actorId: staffA });
      expect(created.hash).toBe(sourceHash('Exact UTF-8 café'));
      const valid = await repository.createDraft({ orgId: orgA, source: created, text: 'Café', provenance: 'machine', aiEventId: aiEventA, actorId: staffA });
      expect(valid.aiEventId).toBe(aiEventA);
      for (const eventId of [randomUUID(), wrongFeatureEvent, failedAiEvent, crossOrgAiEvent]) {
        await expect(repository.createDraft({ orgId: orgA, source: created, text: 'No', provenance: 'machine', aiEventId: eventId, actorId: staffA })).rejects.toThrow();
      }
      const rows = await sql`SELECT * FROM wp021_create_translation_draft(${orgA},${created.id},${created.hash},${created.version},'No','manual',${aiEventA},${staffA})`;
      expect(rows).toHaveLength(0);
    });
  });

  it('rejects owner, BYPASSRLS, and direct-mutation roles while accepting the constrained login', async () => {
    // what_bug_this_catches: a runtime connection silently bypassing RLS or mutating translation history directly.
    await expect(assertTranslationRuntimeRole(owner as unknown as TranslationSql)).rejects.toThrow('constrained');
    await withOrg(runtime, orgA, sql => assertTranslationRuntimeRole(sql as unknown as TranslationSql));
    const bypassRole = 'seniorsocial_wp021_bypass'; const mutationRole = 'seniorsocial_wp021_mutator';
    await owner.unsafe(`DROP ROLE IF EXISTS ${bypassRole}`); await owner.unsafe(`DROP ROLE IF EXISTS ${mutationRole}`);
    await owner.unsafe(`CREATE ROLE ${bypassRole} LOGIN PASSWORD 'synthetic-test-only' BYPASSRLS IN ROLE seniorsocial_app`);
    await owner.unsafe(`CREATE ROLE ${mutationRole} LOGIN PASSWORD 'synthetic-test-only' IN ROLE seniorsocial_app`);
    await owner.unsafe(`GRANT INSERT ON translation_events TO ${mutationRole}`);
    const bypassUrl = new URL(databaseUrl); bypassUrl.username=bypassRole; bypassUrl.password='synthetic-test-only'; const bypass=createDatabaseClient(bypassUrl.toString());
    const mutationUrl = new URL(databaseUrl); mutationUrl.username=mutationRole; mutationUrl.password='synthetic-test-only'; const mutation=createDatabaseClient(mutationUrl.toString());
    try { await expect(assertTranslationRuntimeRole(bypass as unknown as TranslationSql)).rejects.toThrow('constrained'); await expect(assertTranslationRuntimeRole(mutation as unknown as TranslationSql)).rejects.toThrow('constrained'); }
    finally { await bypass.end(); await mutation.end(); await owner.unsafe(`REVOKE INSERT ON translation_events FROM ${mutationRole}`); await owner.unsafe(`DROP ROLE ${bypassRole}`); await owner.unsafe(`DROP ROLE ${mutationRole}`); }
  });

  it('records controlled reviewer lifecycle and blocks approval/publication immediately after revocation', async () => {
    // what_bug_this_catches: revoked reviewer capability remaining usable or losing grant/revoke attribution.
    const current = (await owner<{ id:string; source_hash:string; source_version:number }[]>`SELECT id,source_hash,source_version FROM translation_sources WHERE org_id=${orgA} LIMIT 1`)[0]; if (!current) throw new Error('source required');
    const draft = await withWorkflow(orgA, workflow => workflow.draft({ orgId: orgA, userId: staffA, roles:['staff'] }, { sourceId: current.id, text:'Pendiente' }));
    await expect(withOrg(runtime, orgA, sql => sql`UPDATE translation_qualified_reviewers SET revoked_at=now() WHERE org_id=${orgA} AND user_id=${reviewerA}`)).rejects.toThrow();
    await expect(withOrg(runtime, orgA, sql => sql`SELECT wp021_revoke_translation_reviewer(${orgA},${reviewerA},${reviewerA},'Forged app revocation')`)).rejects.toThrow();
    await withOrg(owner, orgA, async sql => { const rows=await sql<{revoked:boolean}[]>`SELECT wp021_revoke_translation_reviewer(${orgA},${reviewerA},${reviewerA},'Synthetic revocation') AS revoked`; expect(rows[0]?.revoked).toBe(true); });
    await expect(withWorkflow(orgA, workflow => workflow.approve({ orgId:orgA,userId:reviewerA,roles:['admin'] }, { draftId:draft.id,sourceHash:current.source_hash,sourceVersion:Number(current.source_version),note:'No' }))).rejects.toThrow();
    await expect(withWorkflow(orgA, workflow => workflow.publish({ orgId:orgA,userId:reviewerA,roles:['admin'] }, { draftId:draft.id,sourceHash:current.source_hash,sourceVersion:Number(current.source_version) }))).rejects.toThrow();
    expect(await owner`SELECT id FROM translation_reviewer_events WHERE org_id=${orgA} AND reviewer_id=${reviewerA}`).toHaveLength(2);
  });
});
