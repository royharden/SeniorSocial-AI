import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createDatabaseClient } from '../../../packages/db/src/client.ts';
import {
  DEMO_ADMIN_ID, DEMO_CAREGIVER_LINK_ID, DEMO_FULL_EVENT_ID, DEMO_ORG_ID, DEMO_RESIDENT_ID,
  expectedDemoCounts, demoAccounts,
} from '../../../packages/db/seed/demo/data.ts';
import { resetDemoFixture } from '../../../packages/db/seed/demo/reset.ts';
import { FlagRepository } from '../../../packages/flags/src/index.ts';
import {
  AesGcmNarrativeCodec, AssistanceService, FixedUtcBusinessHours, PostgresAssistanceRepository,
} from '../../../packages/assistance/src/index.ts';
import { createAssistanceHandlers } from '../../../apps/web/app/api/v1/assistance-requests/_route.ts';

// Explicit opt-in: run only against a disposable migrated/core-seeded database.
const url = process.env.WP034_DISPOSABLE_DATABASE_URL;
if (!url) throw new Error('WP034_DISPOSABLE_DATABASE_URL is required');
const db = createDatabaseClient(url);
const actor = { orgId: DEMO_ORG_ID, userId: DEMO_ADMIN_ID };
const pepper = 'wp034-disposable-pepper';
const encryptionKey = Buffer.alloc(32, 34).toString('base64');
const codec = new AesGcmNarrativeCodec(encryptionKey);
const call = () => resetDemoFixture(db, actor, pepper, codec);
const context = async (tx: Pick<typeof db, 'unsafe'>) => {
  await tx.unsafe("select set_config('app.current_org_id', $1, true)", [DEMO_ORG_ID]);
  await tx.unsafe("select set_config('app.current_user_id', $1, true)", [DEMO_ADMIN_ID]);
};
const semanticFixture = async () => (await db<Array<{ fixture: unknown }>>`
  select jsonb_build_object(
    'users',(select jsonb_agg(jsonb_build_array(u.id,u.display_name,u.email,u.mode,u.locale,r.role) order by u.id) from users u join user_roles r on r.org_id=u.org_id and r.user_id=u.id where u.org_id=${DEMO_ORG_ID}::uuid),
    'demo_accounts',(select jsonb_agg(jsonb_build_array(user_id,code_digest,expires_at) order by user_id) from demo_accounts where org_id=${DEMO_ORG_ID}::uuid),
    'events',(select jsonb_agg(jsonb_build_array(id,title,starts_at,location) order by id) from events where org_id=${DEMO_ORG_ID}::uuid),
    'event_rsvps',(select jsonb_agg(jsonb_build_array(id,event_id,user_id,state,waitlisted_at,created_at,updated_at) order by id) from event_rsvps where org_id=${DEMO_ORG_ID}::uuid),
    'caregiver',(select jsonb_agg(jsonb_build_array(id,resident_id,caregiver_id,state,version) order by id) from caregiver_links where org_id=${DEMO_ORG_ID}::uuid),
    'caregiver_invitations',(select jsonb_agg(jsonb_build_array(id,resident_id,caregiver_id,relationship_note,accepted_at) order by id) from caregiver_invitations where org_id=${DEMO_ORG_ID}::uuid),
    'ai_off_flags',(select jsonb_agg(jsonb_build_array(flag_key,enabled,updated_by,updated_at) order by flag_key) from feature_flags where org_id=${DEMO_ORG_ID}::uuid and flag_key in ('ai.master','ai.concierge')),
    'queues',jsonb_build_array(
      (select jsonb_agg(id order by id) from assistance_requests where org_id=${DEMO_ORG_ID}::uuid),
      (select jsonb_agg(id order by id) from ride_requests where org_id=${DEMO_ORG_ID}::uuid),
      (select jsonb_agg(id order by id) from moderation_items where org_id=${DEMO_ORG_ID}::uuid),
      (select jsonb_agg(id order by id) from translation_drafts where org_id=${DEMO_ORG_ID}::uuid)),
    'directory',(select jsonb_agg(jsonb_build_array(id,name_en,phone) order by id) from services where org_id=${DEMO_ORG_ID}::uuid),
    'partners',(select jsonb_agg(jsonb_build_array(id,name,contact) order by id) from partners where org_id=${DEMO_ORG_ID}::uuid)
  ) as fixture
`)[0]?.fixture;
const assistanceFixture = async () => {
  const [row] = await db<Array<{
    summary_ciphertext: string; requester_id: string; locale: string; triage_category: string;
    triage_source: string; after_hours: boolean; idempotency_key: string; created_at: string;
    transition_id: string; actor_id: string; from_state: string | null; to_state: string;
    owner_id: string | null; reason: string; transition_at: string; due_at: string;
    breached_at: string | null; transition_count: number;
  }>>`select
    r.summary_ciphertext,r.requester_id::text,r.locale,r.triage_category,r.triage_source,r.after_hours,
    r.idempotency_key,r.created_at::text,t.id::text transition_id,t.actor_id::text,t.from_state,t.to_state,
    t.owner_id::text,t.reason,t.at::text transition_at,s.due_at::text,s.breached_at::text,
    (select count(*)::int from assistance_transitions all_t where all_t.org_id=r.org_id and all_t.request_id=r.id) transition_count
    from assistance_requests r
    join assistance_transitions t on t.org_id=r.org_id and t.request_id=r.id
      and t.id='34000000-0000-4000-8200-000000000002'::uuid
    join sla_clocks s on s.org_id=r.org_id and s.request_id=r.id
    where r.org_id=${DEMO_ORG_ID}::uuid and r.id='34000000-0000-4000-8200-000000000001'::uuid`;
  assert.ok(row?.summary_ciphertext);
  assert.ok(!row.summary_ciphertext.includes('[SYNTHETIC]'));
  const { summary_ciphertext: ciphertext, ...metadata } = row;
  return { summary: await codec.open(ciphertext), ...metadata };
};
try {
  const up = await readFile(new URL('../../../packages/db/migrations/0180_wp-034_demo.sql', import.meta.url), 'utf8');
  const runner = await readFile(new URL('../../../packages/db/seed/demo/journey.ts', import.meta.url), 'utf8');
  const cleanup = [
    ...[...runner.matchAll(/delete from (\w+) where org_id=\$\{DEMO_ORG_ID\}/gu)].map(match => match[1]),
    ...[...up.matchAll(/DELETE FROM (\w+) WHERE org_id=requested_org/gu)].map(match => match[1]),
  ];
  const tenantTables = await db<Array<{ name: string }>>`
    select c.table_name as name from information_schema.columns c
    join information_schema.tables t using (table_schema,table_name)
    where c.table_schema='public' and c.column_name='org_id' and t.table_type='BASE TABLE'
    order by c.table_name`;
  // what_bug_this_catches: a newly integrated tenant table omitted from reset, or unsafe FK order.
  assert.deepEqual([...cleanup].sort(), tenantTables.map(table => table.name));
  const foreignKeys = await db<Array<{ child: string; parent: string }>>`
    select child.relname as child,parent.relname as parent from pg_constraint fk
    join pg_class child on child.oid=fk.conrelid join pg_class parent on parent.oid=fk.confrelid
    where fk.contype='f' and child.relnamespace='public'::regnamespace`;
  for (const fk of foreignKeys) {
    if (cleanup.includes(fk.parent)) assert.ok(cleanup.indexOf(fk.child) >= 0 && cleanup.indexOf(fk.child) < cleanup.indexOf(fk.parent), `${fk.child} must precede ${fk.parent}`);
  }
  const globals = await db<Array<{ name: string }>>`
    select t.table_name as name from information_schema.tables t where t.table_schema='public' and t.table_type='BASE TABLE'
    and not exists(select 1 from information_schema.columns c where c.table_schema=t.table_schema and c.table_name=t.table_name and c.column_name='org_id')
    order by t.table_name`;
  const untouched = async () => {
    const snapshots: Record<string, unknown> = {};
    for (const table of [...tenantTables, ...globals]) {
      const condition = tenantTables.some(t => t.name === table.name) ? 'org_id IS DISTINCT FROM $1::uuid' : table.name === 'orgs' ? 'id <> $1::uuid' : 'true';
      const quoted = '"' + table.name.replaceAll('"', '""') + '"';
      snapshots[table.name] = await db.unsafe(`select to_jsonb(t) as row from public.${quoted} t where ${condition} order by to_jsonb(t)::text`, condition === 'true' ? [] : [DEMO_ORG_ID]);
    }
    return snapshots;
  };
  // Prove the ss-n0 org override is authoritative even when the global default is enabled.
  // The all-table snapshot below also proves reset preserves these globals and every other org.
  await db`update feature_flags set enabled=true
    where scope='global' and flag_key in ('ai.master','ai.concierge')`;
  const untouchedBefore = await untouched();
  // what_bug_this_catches: runtime exploiting the absent fixed-admin bootstrap.
  const runtimeDenied = async () => {
    await assert.rejects(db.begin(async tx => {
      await tx`set local role seniorsocial_app`;
      await context(tx);
      await tx`select seniorsocial_reset_demo(${DEMO_ORG_ID}::uuid, ${DEMO_ADMIN_ID}::uuid, 'wp-034.v1', ${pepper})`;
    }), { code: '42501' });
  };
  await runtimeDenied();
  const otherBefore = await db`select row_to_json(x) as row from (
    select 'user' kind,id::text,display_name display from users where org_id <> ${DEMO_ORG_ID}::uuid
    union all select 'partner',id::text,name from partners where org_id <> ${DEMO_ORG_ID}::uuid
    union all select 'category',id::text,label_en from service_categories where org_id <> ${DEMO_ORG_ID}::uuid
  ) x order by kind,id`;
  const first = await call();
  const [seededAssistance] = await db<Array<{ summary_ciphertext: string }>>`
    select summary_ciphertext from assistance_requests
    where org_id=${DEMO_ORG_ID}::uuid and id='34000000-0000-4000-8200-000000000001'::uuid`;
  assert.ok(seededAssistance?.summary_ciphertext);
  assert.equal(await codec.open(seededAssistance.summary_ciphertext), '[SYNTHETIC] Avery needs transportation help for a demo appointment.');
  assert.ok(!seededAssistance.summary_ciphertext.includes('[SYNTHETIC]'));
  const firstAssistanceFixture = await assistanceFixture();
  const firstFixture = await semanticFixture();
  const service = new AssistanceService({
    repository: new PostgresAssistanceRepository(db, codec), codec,
    ids: { next: () => '34000000-0000-4000-8200-000000000099' },
    hours: new FixedUtcBusinessHours(),
    authorization: { authorize: () => Promise.resolve(true) },
  });
  await service.create(
    { orgId: DEMO_ORG_ID, userId: DEMO_RESIDENT_ID, roles: ['senior'] },
    { summary: '[SYNTHETIC] Newly created valid transportation request.', idempotencyKey: 'wp034-new-valid-request' },
  );
  for (const identity of [
    { orgId: DEMO_ORG_ID, userId: '34000000-0000-4000-8000-000000000003', roles: ['staff'] as const },
    { orgId: DEMO_ORG_ID, userId: DEMO_ADMIN_ID, roles: ['admin'] as const },
  ]) {
    const handlers = createAssistanceHandlers({ authenticate: () => Promise.resolve(identity), service });
    const response = await handlers.STAFF_QUEUE(new Request('http://local/api/v1/staff/assistance-requests'));
    assert.equal(response.status, 200);
    const body = await response.json() as { items: Array<{ id: string; summary: string }> };
    assert.deepEqual(new Set(body.items.map(item => item.id)), new Set([
      '34000000-0000-4000-8200-000000000001', '34000000-0000-4000-8200-000000000099',
    ]));
    assert.ok(body.items.every(item => item.summary.startsWith('[SYNTHETIC]')));
  }
  const flags = new FlagRepository(db);
  assert.equal(await flags.effective('ai.master', DEMO_ORG_ID), false);
  assert.equal(await flags.effective('ai.concierge', DEMO_ORG_ID), false);
  const aiFlagRows = await db`select scope::text,flag_key,enabled from feature_flags
    where flag_key in ('ai.master','ai.concierge') and (scope='global' or org_id=${DEMO_ORG_ID}::uuid)
    order by flag_key,scope`;
  assert.deepEqual(Array.from(aiFlagRows), [
    { scope: 'global', flag_key: 'ai.concierge', enabled: true },
    { scope: 'org', flag_key: 'ai.concierge', enabled: false },
    { scope: 'global', flag_key: 'ai.master', enabled: true },
    { scope: 'org', flag_key: 'ai.master', enabled: false },
  ]);
  const [aiEvents] = await db`select count(*)::int as n from ai_events where org_id=${DEMO_ORG_ID}::uuid`;
  assert.equal(aiEvents?.n, 0);
  const [journey] = await db`select
    (select state from caregiver_links where org_id=${DEMO_ORG_ID}::uuid and id=${DEMO_CAREGIVER_LINK_ID}::uuid) link_state,
    (select version from caregiver_links where org_id=${DEMO_ORG_ID}::uuid and id=${DEMO_CAREGIVER_LINK_ID}::uuid) link_version,
    (select count(*)::int from consent_grants where org_id=${DEMO_ORG_ID}::uuid) grants,
    (select count(*)::int from consent_scopes where org_id=${DEMO_ORG_ID}::uuid) scopes,
    (select count(*)::int from consent_read_backs where org_id=${DEMO_ORG_ID}::uuid) read_backs,
    (select capacity from events where org_id=${DEMO_ORG_ID}::uuid and id=${DEMO_FULL_EVENT_ID}::uuid) capacity,
    (select count(*)::int from event_rsvps where org_id=${DEMO_ORG_ID}::uuid and event_id=${DEMO_FULL_EVENT_ID}::uuid and state='attending') attending,
    (select count(*)::int from event_rsvps where org_id=${DEMO_ORG_ID}::uuid and event_id=${DEMO_FULL_EVENT_ID}::uuid and state='waitlisted') waitlisted,
    (select count(*)::int from event_rsvps where org_id=${DEMO_ORG_ID}::uuid and event_id=${DEMO_FULL_EVENT_ID}::uuid and user_id=${DEMO_RESIDENT_ID}::uuid) resident_rsvps`;
  assert.deepEqual(journey, {
    link_state: 'pending', link_version: 0, grants: 0, scopes: 0, read_backs: 0,
    capacity: 1, attending: 1, waitlisted: 1, resident_rsvps: 0,
  });
  // Populate representative mutable/history tables exactly as a reviewer journey does.
  await db`insert into policy_decisions(org_id,entry_actor_id,decision_actor_id,outcome,reason) values
    (${DEMO_ORG_ID}::uuid,'34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000006','allowed','policy_allowed')`;
  await db`insert into partners(id,org_id,name,categories,contact) values
    ('34000000-0000-4000-8999-000000000001',${DEMO_ORG_ID}::uuid,'[SYNTHETIC] stale reviewer partner','{}','{"value":"stale"}')`;
  await db`insert into services(id,org_id,external_id,category_id,name_en,name_es,phone,source_updated_at,publication_state,reviewed_by,reviewed_at) values
    ('34000000-0000-4000-8999-000000000002',${DEMO_ORG_ID}::uuid,'stale-reviewer-service','34000000-0000-4000-8900-000000000001','stale','obsoleto','',now(),'published','34000000-0000-4000-8000-000000000003',now())`;
  await db`insert into service_imports(id,org_id,actor_id,status,accepted_rows,rejected_rows) values
    ('34000000-0000-4000-8999-000000000003',${DEMO_ORG_ID}::uuid,'34000000-0000-4000-8000-000000000003','committed',1,0)`;
  await db`insert into caregiver_links(id,org_id,resident_id,caregiver_id) values
    ('34000000-0000-4000-8999-000000000004',${DEMO_ORG_ID}::uuid,'34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000005')`;
  await db`insert into messaging_conversations(id,org_id,participant_a,participant_b) values
    ('34000000-0000-4000-8999-000000000005',${DEMO_ORG_ID}::uuid,'34000000-0000-4000-8000-000000000001','34000000-0000-4000-8000-000000000002')`;
  await db`insert into messaging_messages(id,org_id,conversation_id,sender_id,body,idempotency_key) values
    ('34000000-0000-4000-8999-000000000006',${DEMO_ORG_ID}::uuid,'34000000-0000-4000-8999-000000000005','34000000-0000-4000-8000-000000000001','[SYNTHETIC] stale reviewer message','stale-reviewer-message')`;
  await db.begin(async tx => {
    await context(tx);
    await tx`insert into messaging_reports(id,org_id,conversation_id,reporter_id,reason,idempotency_key) values
      ('34000000-0000-4000-8999-000000000008',${DEMO_ORG_ID}::uuid,'34000000-0000-4000-8999-000000000005','34000000-0000-4000-8000-000000000001','synthetic report','stale-reviewer-report')`;
    await tx`insert into messaging_moderation_decisions(queue_id,org_id,report_id,decision,reason,decided_by) values
      (uuid_generate_v5('7699a1f4-6b0f-4f69-8dc7-1da9236df15e','34000000-0000-4000-8999-000000000008'),${DEMO_ORG_ID}::uuid,'34000000-0000-4000-8999-000000000008','keep','synthetic policy rationale','34000000-0000-4000-8000-000000000006')`;
  });
  await db`insert into report_source_imports(org_id,source_version,request_hash) values
    (${DEMO_ORG_ID}::uuid,'stale-reviewer-v1',${'a'.repeat(64)})`;
  await db`insert into report_activity_facts(org_id,period,channel,metric,activity_count,source_version,evidence) values
    (${DEMO_ORG_ID}::uuid,'2026-09-01T00:00:00Z','screen','requests',1,'stale-reviewer-v1','synthetic_test')`;
  await db`insert into report_channel_coverage(org_id,channel,completeness,source_version,evidence,coverage_from,coverage_to) values
    (${DEMO_ORG_ID}::uuid,'screen','complete','stale-reviewer-v1','synthetic_test','2026-09-01T00:00:00Z','2026-09-02T00:00:00Z')`;
  await db`insert into report_exports(id,org_id,actor_id,mutation_key,request_hash,report_name,format,state,filters,completeness_note,artifact,content_digest,content_type,as_of,source_version,included_channels,completeness,known_omissions,overlap_uncertainty,row_count,expires_at) values
    ('34000000-0000-4000-8999-000000000009',${DEMO_ORG_ID}::uuid,${DEMO_ADMIN_ID}::uuid,'stale-reviewer-export',${'b'.repeat(64)},'channel-activity','json','ready','{}','synthetic',decode('','hex'),${'c'.repeat(64)},'application/json','2026-09-01T00:00:00Z','stale-reviewer-v1',ARRAY['screen'],'complete',ARRAY[]::text[],ARRAY[]::text[],0,'2026-09-12T00:00:00Z')`;
  await db`insert into notification_inbox(id,org_id,user_id,source_key,purpose,title,body) values
    ('34000000-0000-4000-8999-000000000007',${DEMO_ORG_ID}::uuid,'34000000-0000-4000-8000-000000000001','stale-reviewer-notice','task_notice','stale','stale')`;
  const second = await call();
  assert.deepEqual(first.counts, expectedDemoCounts);
  assert.deepEqual(second.counts, first.counts);
  assert.deepEqual(await semanticFixture(), firstFixture);
  assert.deepEqual(await assistanceFixture(), firstAssistanceFixture);
  const [stale] = await db`select
    (select count(*) from policy_decisions where org_id=${DEMO_ORG_ID}::uuid)+
    (select count(*) from partners where org_id=${DEMO_ORG_ID}::uuid and name like '%stale%')+
    (select count(*) from services where org_id=${DEMO_ORG_ID}::uuid and external_id='stale-reviewer-service')+
    (select count(*) from service_imports where org_id=${DEMO_ORG_ID}::uuid)+
    (select count(*) from caregiver_links where org_id=${DEMO_ORG_ID}::uuid and id='34000000-0000-4000-8999-000000000004')+
    (select count(*) from messaging_conversations where org_id=${DEMO_ORG_ID}::uuid)+
    (select count(*) from messaging_moderation_decisions where org_id=${DEMO_ORG_ID}::uuid)+
    (select count(*) from report_activity_facts where org_id=${DEMO_ORG_ID}::uuid)+
    (select count(*) from report_channel_coverage where org_id=${DEMO_ORG_ID}::uuid)+
    (select count(*) from report_source_imports where org_id=${DEMO_ORG_ID}::uuid)+
    (select count(*) from report_exports where org_id=${DEMO_ORG_ID}::uuid)+
    (select count(*) from notification_inbox where org_id=${DEMO_ORG_ID}::uuid) as n`;
  assert.equal(Number(stale?.n), 0);
  assert.ok(first.elapsedMs < 120000 && second.elapsedMs < 120000);
  await runtimeDenied();
  for (const account of demoAccounts.filter(a => a.role !== 'admin')) {
    await assert.rejects(resetDemoFixture(db, { ...actor, userId: account.userId }, pepper, codec), { code: '42501' });
  }
  await assert.rejects(db.begin(async tx => {
    await context(tx);
    await tx`select seniorsocial_reset_demo('22222222-2222-4222-8222-222222222222'::uuid, ${DEMO_ADMIN_ID}::uuid, 'wp-034.v1', ${pepper})`;
  }), { code: '42501' });
  await assert.rejects(db.begin(async tx => {
    await context(tx);
    await tx`select seniorsocial_reset_demo(${DEMO_ORG_ID}::uuid, ${DEMO_ADMIN_ID}::uuid, null, ${pepper})`;
  }), /invalid demo reset request/u);
  // what_bug_this_catches: trigger suppression leaking across failure or concurrent sessions.
  const triggers = () => db`select tgrelid::regclass::text as relation, tgname, tgenabled from pg_trigger where not tgisinternal order by 1,2`;
  const beforeTriggers = await triggers();
  const beforeUsers = await db`select row_to_json(u) as row from users u order by id`;
  await assert.rejects(db.begin(async tx => {
    await tx`alter table events add constraint wp034_injected_failure check (title <> '[SYNTHETIC] Demo activity 1') not valid`;
    await context(tx);
    await tx`select seniorsocial_reset_demo(${DEMO_ORG_ID}::uuid, ${DEMO_ADMIN_ID}::uuid, 'wp-034.v1', ${pepper})`;
  }), { code: '23514' });
  assert.deepEqual(await triggers(), beforeTriggers);
  assert.deepEqual(await db`select row_to_json(u) as row from users u order by id`, beforeUsers);
  // what_bug_this_catches: failure in the owned post-reset overlay committing the base reset on its own.
  await db`alter table events add constraint wp041_overlay_failure check (title <> '[SYNTHETIC] Full-capacity reviewer event') not valid`;
  const beforeOverlayFailure = await semanticFixture();
  await assert.rejects(call(), { code: '23514' });
  assert.deepEqual(await semanticFixture(), beforeOverlayFailure);
  assert.deepEqual(await triggers(), beforeTriggers);
  await db`alter table events drop constraint wp041_overlay_failure`;
  const concurrent = await Promise.all([call(), call()]);
  assert.ok(concurrent.every(result => JSON.stringify(result.counts) === JSON.stringify(first.counts)));
  assert.deepEqual(await triggers(), beforeTriggers);
  assert.deepEqual(await db`select row_to_json(x) as row from (
    select 'user' kind,id::text,display_name display from users where org_id <> ${DEMO_ORG_ID}::uuid
    union all select 'partner',id::text,name from partners where org_id <> ${DEMO_ORG_ID}::uuid
    union all select 'category',id::text,label_en from service_categories where org_id <> ${DEMO_ORG_ID}::uuid
  ) x order by kind,id`, otherBefore);
  const [contacts] = await db`select count(*)::int as n from users where org_id=${DEMO_ORG_ID}::uuid and (phone is not null or email not like '%@example.invalid' or not is_demo)`;
  assert.equal(contacts?.n, 0);
  const audits = await db`select actor, action, target, fields from audit_events where org_id=${DEMO_ORG_ID}::uuid`;
  assert.equal(audits.length, 1);
  assert.deepEqual(audits[0], { actor: 'system:demo_reset', action: 'demo.reset', target: 'demo_fixture:wp-034.v1', fields: [] });
  const down = await readFile(new URL('../../../packages/db/migrations/0180_wp-034_demo.down.sql', import.meta.url), 'utf8');
  await db.begin(async tx => { await tx.unsafe(down); });
  const [removed] = await db`select to_regprocedure('seniorsocial_reset_demo(uuid,uuid,text,text)') is null as gone`;
  assert.equal(removed?.gone, true);
  const legacyUp = execFileSync('git', [
    'show', 'f4ecc327b592a8562ce41d45741085003929e417:SeniorSocial-AI-Bts/packages/db/migrations/0180_wp-034_demo.sql',
  ], { encoding: 'utf8' });
  await db.begin(async tx => { await tx.unsafe(legacyUp); });
  const legacyFirst = await call();
  const legacyFirstAssistance = await assistanceFixture();
  const legacySecond = await call();
  assert.deepEqual(legacyFirst.counts, expectedDemoCounts);
  assert.deepEqual(legacySecond.counts, legacyFirst.counts);
  assert.deepEqual(await assistanceFixture(), legacyFirstAssistance);
  await db.begin(async tx => { await tx.unsafe(down); });
  await db.begin(async tx => { await tx.unsafe(up); });
  assert.deepEqual((await call()).counts, expectedDemoCounts);
  await runtimeDenied();
  assert.deepEqual(await untouched(), untouchedBefore);
  console.log(JSON.stringify({ passed: true, tenantTables: tenantTables.length, firstMs: first.elapsedMs, secondMs: second.elapsedMs, checks: 'cold/runtime/nonadmin/cross-org/null/populated-workflows/exact-convergence/encrypted-assistance/transition-sla-convergence/legacy-0180-upgrade/staff-admin-queue-200/new-valid-request/org-ai-off-effective/no-ai-events/pending-consent/full-capacity-waitlist/no-stale-service-partner/concurrency/base-and-overlay-rollback/triggers/all-other-tenant-and-global-data/catalog-fk-order/contacts/audit/down-up' }));
} finally {
  await db.end();
}
