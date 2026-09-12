import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { createDatabaseClient, withOrg, type DatabaseClient } from '../../../packages/db/src/index.ts';
import { createResidentRepository, createDurableNotificationAudit, createPostgresRepository, createNotify, createSimulator, createPrintService, createCurrentScheduleSource, currentWeek, eventReminderNotice, type PrintPayload, type RegisteredSchedule } from '../../../packages/notify/src/index.ts';
import { PgBoss, createBossQueue, createConsumer, postgresWorkerLookup } from '../../../packages/worker/src/bridge.ts';
import { PRINT_QUEUE, createBossPrintQueue, createPrintConsumer } from '../../../packages/worker/src/print.ts';
import { digestSecret } from '../../../packages/auth/src/crypto.ts';
import { identity, orgId, userId, otherOrg, otherUser, optedIn, request } from '../../unit/WP-009/fixture.ts';
import { GET as inboxGET } from '../../../apps/web/app/api/v1/notifications/route.ts';
import { POST as markRead } from '../../../apps/web/app/api/v1/notifications/[notificationId]/read/route.ts';
import { GET as printGET, createPrintHandler } from '../../../apps/web/app/api/v1/me/schedule/print/route.ts';
import { GET as preferencesGET, PUT } from '../../../apps/web/app/api/v1/me/preferences/route.ts';
import { authenticated } from '../../../apps/web/app/api/v1/notifications/_shared.ts';
import { createRuntime } from '../../../packages/notify/src/runtime.ts';
import { createRegisteredScheduleSource } from '../../../packages/notify/src/schedule.ts';
import { createPostgresEventRepository, createPostgresWp009ReminderScheduler } from '../../../packages/events/src/postgres.ts';
import { AssistanceScheduleUnavailableError } from '../../../packages/assistance/src/index.ts';

const url = process.env.WP009_COMPLETION_DATABASE_URL;
if (!url || new URL(url).pathname !== '/seniorsocial_wp009_completion_test' || !['localhost','127.0.0.1'].includes(new URL(url).hostname)) throw new Error('Dedicated local WP009_COMPLETION_DATABASE_URL required');
const owner = createDatabaseClient(url);
let runtime: DatabaseClient;
const role = 'seniorsocial_wp009_completion_login';
const token = 'synthetic-completion-session'; // secrets-scan: allow — deterministic local fixture
const pepper = 'synthetic-completion-pepper';
const otherIdentity = { orgId, userId: otherUser };
let boss: PgBoss;
const snapshot = { as_of: '2026-08-01T12:00:00.000Z', source_version: 'events:synthetic-v7', items: [{ title: 'Synthetic community lunch', starts_at: '2026-08-02T12:00:00Z' }] };
const req = (path: string, method = 'GET', body?: unknown, cookie = token) => new Request(`http://localhost${path}`, { method, headers: { cookie: `ss_session=${cookie}`, origin: 'http://localhost', 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });

// what_bug_this_catches: forging a same-org queue locator reads another resident's
// sensitive source, even though the payload is valid and that resident is active.
it('requires exact authenticated producer evidence before any print source access',async () => {
  const source = {read:vi.fn(() => Promise.resolve({...snapshot,items:[{title:'Sensitive synthetic resident-only appointment'}]}))};
  const service = createPrintService(runtime,source);
  const consume = createPrintConsumer(service,orgId);
  const payload = {org_id:orgId,user_id:otherUser,week_of:'2026-08-01',idempotency_key:'authorized-other-print'};
  await expect(consume(PRINT_QUEUE,payload)).rejects.toThrow('Unavailable');
  expect(source.read).not.toHaveBeenCalled();
  expect(await owner`select id from print_jobs where idempotency_key=${payload.idempotency_key}`).toHaveLength(0);
  const otherToken = 'synthetic-other-print-session';
  await owner`insert into sessions(org_id,user_id,token_digest,expires_at) values(${orgId},${otherUser},${digestSecret(otherToken,pepper)},now()+interval '1 day')`;
  const produce = (cookie: string) => authenticated(req('/api/v1/me/schedule/print','GET',undefined,cookie),async (scope,_client,recheck) => {
    await service.request(scope,payload,recheck); return new Response(null,{status:204});
  });
  expect((await produce(token)).status).toBe(403);
  expect((await produce(otherToken)).status).toBe(204);
  await expect(consume(PRINT_QUEUE,{...payload,week_of:'2026-08-02'})).rejects.toThrow('Unavailable');
  expect(source.read).not.toHaveBeenCalled();
  const first = await consume(PRINT_QUEUE,payload);
  expect(await consume(PRINT_QUEUE,payload)).toEqual(first);
  expect(source.read).toHaveBeenCalledTimes(1);
  expect(await owner`select id from print_jobs where idempotency_key=${payload.idempotency_key}`).toHaveLength(1);
});

// what_bug_this_catches: direct non-owner writes persist invalid contract content
// or impossible/reversible read markers despite application validation.
it('constrains inbox purpose/read chronology and print item shape/size in PostgreSQL',async () => {
  const scoped = (query: string) => withOrg(runtime,orgId,async sql => {
    await sql`select set_config('app.current_user_id',${userId},true)`;
    return sql.unsafe(query);
  });
  const notice = `insert into notification_inbox(org_id,user_id,source_key,purpose,title,body) values('${orgId}','${userId}','invalid-purpose','not_a_purpose','Synthetic','')`;
  await expect(scoped(notice)).rejects.toThrow();
  await scoped(`insert into notification_inbox(org_id,user_id,source_key,purpose,title,body) values('${orgId}','${userId}','chronology','task_notice','Synthetic','')`);
  for (const value of ["created_at - interval '1 second'","statement_timestamp() + interval '1 hour'"]) {
    await expect(scoped(`update notification_inbox set read_at=${value} where source_key='chronology'`)).rejects.toThrow('invalid inbox read marker');
  }
  await scoped("update notification_inbox set read_at=statement_timestamp() where source_key='chronology'");
  await expect(scoped("update notification_inbox set read_at=null where source_key='chronology'")).rejects.toThrow('immutable');
  await expect(scoped(`insert into notification_inbox(org_id,user_id,source_key,purpose,title,body,read_at) values('${orgId}','${userId}','future-insert','task_notice','Synthetic','',statement_timestamp()+interval '1 hour')`)).rejects.toThrow('invalid inbox read marker');
  for (const items of ["'[null]'::jsonb","'[42]'::jsonb","'[[]]'::jsonb","jsonb_build_array(jsonb_build_object('title',repeat('x',100001)))","jsonb_build_array(jsonb_build_object('title',repeat(chr(233),60000)))"]) {
    await expect(scoped(`insert into print_jobs(org_id,user_id,week_of,idempotency_key,as_of,source_version,items) values('${orgId}','${userId}','2026-08-01','invalid-items',now(),'synthetic:v1',${items})`)).rejects.toThrow();
  }
  const validSource = "jsonb_build_object('key','events','status','available','source_version','events:v1','as_of','2026-08-01T12:00:00.000Z','item_count',1)";
  const invalidSources = ["'{}'::jsonb","'[null]'::jsonb",`jsonb_build_array(${validSource},${validSource})`,
    "jsonb_build_array(jsonb_build_object('key','events','status','unknown','source_version',null,'as_of',null,'item_count',0))",
    "jsonb_build_array(jsonb_build_object('key','events','status',null,'source_version',null,'as_of',null,'item_count',0))",
    "jsonb_build_array(jsonb_build_object('key','events','status','available','source_version','private resident narrative','as_of','2026-08-01T12:00:00.000Z','item_count',1))",
    "jsonb_build_array(jsonb_build_object('key','rides','status','not_registered','source_version','rides:v1','as_of',null,'item_count',0))",
    `(select jsonb_agg(jsonb_build_object('key','source-'||value,'status','not_registered','source_version',null,'as_of',null,'item_count',0)) from generate_series(1,9) value)`,
    `jsonb_build_array(${validSource} || jsonb_build_object('resident_name','Synthetic resident'))`];
  for (const [index,sources] of invalidSources.entries()) {
    await expect(scoped(`insert into print_jobs(org_id,user_id,week_of,idempotency_key,as_of,source_version,items,sources)
      values('${orgId}','${userId}','2026-08-01','invalid-sources-${index}',now(),'synthetic:v1','[]'::jsonb,${sources})`)).rejects.toThrow();
  }
  // what_bug_this_catches: SQL accepts impossible instants, or JavaScript
  // silently normalizes invalid calendar/clock components before persistence.
  for (const [index,asOf] of ['2026-99-99T99:99:99Z','2026-02-30T12:00:00Z','2026-02-29T12:00:00Z',
    '2026-08-01T24:00:00Z','2026-08-01T12:60:00Z','2026-08-01T12:00:60Z','0000-01-01T00:00:00Z'].entries()) {
    const sources = [{key:'events',status:'available',source_version:'events:v1',as_of:asOf,item_count:1}];
    await expect(scoped(`insert into print_jobs(org_id,user_id,week_of,idempotency_key,as_of,source_version,items,sources)
      values('${orgId}','${userId}','2026-08-01','invalid-instant-${index}',now(),'synthetic:v1','[]'::jsonb,'${JSON.stringify(sources)}'::jsonb)`)).rejects.toThrow();
    await expect(createPrintService(runtime,{read:()=>Promise.resolve({...snapshot,sources})}).current(identity,'2026-08-01')).rejects.toThrow('Invalid schedule source');
  }
  for (const [index,asOf] of ['2024-02-29T12:00:00Z','2024-02-29T12:00:00.123456Z'].entries()) {
    const sources = [{key:'events',status:'available',source_version:'events:v1',as_of:asOf,item_count:1}];
    const valid = {...snapshot,source_version:`valid-instant:${index}`,sources};
    expect(await createPrintService(runtime,{read:()=>Promise.resolve(valid)}).current(identity,'2026-08-01')).toEqual(valid);
  }
  const metadata = {key:'events',status:'available',source_version:'events:v1',as_of:'2024-02-29T12:00:00Z',item_count:1};
  const invalidMetadata = [null,{},[null],[metadata,metadata],Array.from({length:9},(_,i)=>({...metadata,key:`source-${i}`})),
    ...[{key:'Events!'},{status:'unknown'},{source_version:'x'.repeat(201)},{source_version:'resident narrative'},
      {as_of:null},{item_count:-1},{item_count:0.5},{item_count:10000},{resident_name:'Synthetic resident'},
      {status:'unavailable',source_version:null,as_of:null,item_count:1}].map(change=>[{...metadata,...change}])];
  for (const [index,sources] of invalidMetadata.entries()) {
    await expect(scoped(`insert into print_jobs(org_id,user_id,week_of,idempotency_key,as_of,source_version,items,sources)
      values('${orgId}','${userId}','2026-08-01','invalid-metadata-${index}',now(),'synthetic:v1','[]'::jsonb,'${JSON.stringify(sources)}'::jsonb)`)).rejects.toThrow();
    await expect(createPrintService(runtime,{read:()=>Promise.resolve({...snapshot,sources})}).current(identity,'2026-08-01')).rejects.toThrow('Invalid schedule source');
  }
  // JSON numbers 1 and 1.0 represent the same integral count in JavaScript.
  await scoped(`insert into print_jobs(org_id,user_id,week_of,idempotency_key,as_of,source_version,items,sources)
    values('${orgId}','${userId}','2026-08-01','integral-count',now(),'synthetic:v1','[]'::jsonb,
      '[{"key":"events","status":"available","source_version":"events:v1","as_of":"2024-02-29T12:00:00Z","item_count":1.0}]'::jsonb)`);
  await owner`delete from notification_inbox where org_id=${orgId} and user_id=${userId} and source_key='chronology'`;
});

beforeAll(async () => {
  // what_bug_this_catches: canonical completion migrations fail on clean PG or rollback.
  await owner.unsafe('DROP SCHEMA IF EXISTS wp009boss CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  for (const name of ['0001_wp-003_core_tables.sql','0010_wp-004_auth.sql','0011_wp-004_auth_rate_limits.sql','0030_wp-006_audit_flags.sql','0031_wp-006_audit_fields.sql','0032_wp-006_notification_audit_actions.sql','0040_wp-009_notify.sql','0041_wp-009_completion.sql','0041_wp-009_completion.down.sql','0041_wp-009_completion.sql','0060_wp-012_events.sql','0071_wp-013_ride_requests.sql','0072_wp-013_ride_transitions.sql','0080_wp-014_assistance.sql']) {
    await owner.unsafe(await readFile(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), 'utf8'));
  }
  await owner`insert into orgs(id,name,slug) values (${orgId},'Synthetic A','completion-a'),(${otherOrg},'Synthetic B','completion-b')`;
  await owner`insert into users(id,org_id,display_name) values (${userId},${orgId},'Synthetic resident'),(${otherUser},${orgId},'Synthetic other resident')`;
  await owner.unsafe(`DROP ROLE IF EXISTS ${role}`);
  await owner.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-test-only' IN ROLE seniorsocial_app`);
  const constrained = new URL(url); constrained.username = role; constrained.password = 'synthetic-test-only';
  runtime = createDatabaseClient(constrained.toString());
  vi.stubEnv('DATABASE_URL', constrained.toString()); vi.stubEnv('AUTH_TOKEN_PEPPER', pepper); vi.stubEnv('SENIORSOCIAL_ORG_ID', orgId);
  await owner`insert into sessions(org_id,user_id,token_digest,expires_at) values (${orgId},${userId},${digestSecret(token,pepper)},now()+interval '1 day')`;
  boss = new PgBoss({ connectionString: url, schema: 'wp009boss' }); await boss.start();
  for (const channel of ['email','sms','voice']) await boss.createQueue(`notify.send.${channel}`, { policy: 'exclusive' });
  await boss.createQueue(PRINT_QUEUE,{policy:'exclusive'});
}, 30000);
afterAll(async () => { if (boss) await boss.stop(); if (runtime) await runtime.end(); await owner.end(); vi.unstubAllEnvs(); });

// what_bug_this_catches: WP-012's durable intent is stranded unless an
// outbound channel and a separate worker happen to run, while cancelled,
// future, inactive or differently scoped reminders leak into the inbox.
it('reconciles only due authorized event intents once through the public resident inbox',async()=>{
  const dueEvent = 'a3000000-0000-4000-8000-000000000001';
  const futureEvent = 'a3000000-0000-4000-8000-000000000002';
  const cancelledEvent = 'a3000000-0000-4000-8000-000000000003';
  const revokedEvent = 'a3000000-0000-4000-8000-000000000004';
  const otherEvent = 'a3000000-0000-4000-8000-000000000005';
  const foreignUser = 'a3000000-0000-4000-8000-000000000006';
  const foreignEvent = 'a3000000-0000-4000-8000-000000000007';
  const revokedUser = 'a3000000-0000-4000-8000-000000000008';
  const pastEvent = 'a3000000-0000-4000-8000-000000000009';
  await owner`insert into users(id,org_id,display_name,locale,account_state) values
    (${foreignUser},${otherOrg},'Synthetic foreign resident','es','active'),
    (${revokedUser},${orgId},'Synthetic revoked resident','en','held_for_review')`;
  await owner`insert into events(id,org_id,title,starts_at,time_zone,location,published_at,created_by) values
    (${dueEvent},${orgId},'Due event',now()+interval '1 day','UTC','Synthetic hall',now(),${userId}),
    (${futureEvent},${orgId},'Future event',now()+interval '2 days','UTC','Synthetic hall',now(),${userId}),
    (${cancelledEvent},${orgId},'Cancelled event',now()+interval '1 day','UTC','Synthetic hall',now(),${userId}),
    (${revokedEvent},${orgId},'Revoked event',now()+interval '1 day','UTC','Synthetic hall',now(),${revokedUser}),
    (${otherEvent},${orgId},'Other resident event',now()+interval '1 day','UTC','Synthetic hall',now(),${userId}),
    (${pastEvent},${orgId},'Past event',now()-interval '1 day','UTC','Synthetic hall',now(),${userId}),
    (${foreignEvent},${otherOrg},'Foreign event',now()+interval '1 day','UTC','Private foreign hall',now(),${foreignUser})`;
  const rsvps = [dueEvent,futureEvent,cancelledEvent,revokedEvent,otherEvent,foreignEvent,pastEvent].map((event,index)=>({
    id:`a3000000-0000-4000-8100-00000000000${index+1}`, event,
    org:event===foreignEvent?otherOrg:orgId,
    user:event===otherEvent?otherUser:event===foreignEvent?foreignUser:event===revokedEvent?revokedUser:userId,
    state:event===cancelledEvent?'cancelled':'attending',
  })) as {id:string;event:string;org:string;user:string;state:'attending'|'cancelled'}[];
  for(const rsvp of rsvps) {
    await owner`insert into event_rsvps(id,org_id,event_id,user_id,state) values(${rsvp.id},${rsvp.org},${rsvp.event},${rsvp.user},${rsvp.state})`;
    await owner`insert into event_reminder_intents(org_id,user_id,event_id,rsvp_id,purpose,idempotency_key,due_at)
      values(${rsvp.org},${rsvp.user},${rsvp.event},${rsvp.id},'event_reminder',${`intent-${rsvp.event}`},
        ${rsvp.event===futureEvent?new Date(Date.now()+86_400_000):new Date(0)})`;
  }
  const auditBefore = Number((await owner<{count:string}[]>`select count(*)::text as count from audit_events`)[0]?.count ?? 0);
  const spanishRequest = new Request('http://localhost/api/v1/notifications',{headers:{cookie:`ss_session=${token}; seniorsocial.locale.v1=es`,origin:'http://localhost'}});
  for(let attempt=0;attempt<2;attempt++) {
    const response=await inboxGET(spanishRequest.clone()); expect(response.status).toBe(200);
    const page=await response.json() as {items:{purpose:string;title:string;body:string}[]};
    const reminders=page.items.filter(item=>item.purpose==='event_reminder' && item.body.includes('a3000000-'));
    expect(reminders.map(({title,body})=>({title,body}))).toEqual([eventReminderNotice(dueEvent,'es')]);
    expect(JSON.stringify(reminders)).not.toContain(futureEvent);
    expect(JSON.stringify(reminders)).not.toContain(cancelledEvent);
    expect(JSON.stringify(reminders)).not.toContain(otherEvent);
    expect(JSON.stringify(reminders)).not.toContain(foreignEvent);
    expect(JSON.stringify(reminders)).not.toContain(pastEvent);
  }
  expect(await owner`select id from notification_inbox where source_key=${`event-reminder:${dueEvent}`}`).toHaveLength(1);
  await createResidentRepository(runtime).publish(identity,`event-reminder:${dueEvent}`,{purpose:'event_reminder',...eventReminderNotice(dueEvent,'en')});
  expect(await owner`select id from notification_inbox where source_key=${`event-reminder:${dueEvent}`}`).toHaveLength(1);
  expect(await owner`select id from notification_inbox where source_key in (${`event-reminder:${otherEvent}`},${`event-reminder:${foreignEvent}`})`).toHaveLength(0);
  expect(await owner`select id from notification_outbox where payload->>'event_id' in (${dueEvent},${futureEvent})`).toHaveLength(0);
  expect(await owner`select user_id from notification_preferences where org_id=${orgId} and user_id=${userId}`).toHaveLength(0);
  expect(Number((await owner<{count:string}[]>`select count(*)::text as count from audit_events`)[0]?.count ?? 0)).toBe(auditBefore);
  await expect(createResidentRepository(runtime).list({orgId,userId:revokedUser})).rejects.toThrow('Unavailable');
  expect(await owner`select id from notification_inbox where source_key=${`event-reminder:${revokedEvent}`}`).toHaveLength(0);
  await owner`delete from notification_inbox where source_key=${`event-reminder:${dueEvent}`}`;
  await owner`delete from event_reminder_intents where event_id in ${owner(rsvps.map(item=>item.event))}`;
  await owner`delete from event_rsvps where event_id in ${owner(rsvps.map(item=>item.event))}`;
  await owner`delete from events where id in ${owner(rsvps.map(item=>item.event))}`;
  await owner`delete from users where id in (${foreignUser},${revokedUser})`;
});

// what_bug_this_catches: HTTP or worker publication reads an old attending RSVP
// while cancellation owns its row, then commits a stale reminder after cancel.
it('serializes HTTP and worker inbox publication with in-flight cancellation and account revocation',async()=>{
  const eventId='a4000000-0000-4000-8000-000000000001';
  await owner`insert into events(id,org_id,title,starts_at,time_zone,location,published_at,created_by)
    values(${eventId},${orgId},'Concurrent event',now()+interval '1 hour','UTC','Synthetic hall',now(),${userId})`;
  await createPostgresEventRepository(runtime).rsvp({...identity,roles:['senior']},eventId);
  for (const [viaHttp,revokeAccount] of [[true,false],[false,false],[true,true],[false,true]]) {
    await owner`update event_rsvps set state='attending' where org_id=${orgId} and event_id=${eventId}`;
    const cancellation=await owner.reserve();
    await cancellation`begin`;
    await cancellation`select pg_advisory_xact_lock(hashtextextended(${`${orgId}:${eventId}`},0))`;
    if (revokeAccount) {
      await cancellation`update users set account_state='held_for_review' where org_id=${orgId} and id=${userId}`;
    } else {
      await cancellation`update event_rsvps set state='cancelled' where org_id=${orgId} and event_id=${eventId}`;
    }
    let completed=false;
    const publication=(viaHttp ? inboxGET(req('/api/v1/notifications'))
      : createResidentRepository(runtime).publish(identity,`event-reminder:${eventId}`,
        {purpose:'event_reminder',...eventReminderNotice(eventId,'en')}))
      .finally(()=>{completed=true;});
    try {
      await vi.waitFor(async()=>{
        const blocked=await owner`select pid from pg_stat_activity where usename=${role} and wait_event_type='Lock'`;
        expect(completed || blocked.length>0).toBe(true);
      },{timeout:5000});
      expect(completed).toBe(false);
    } finally {
      await cancellation`commit`; cancellation.release();
      await publication;
    }
    expect(await owner`select id from notification_inbox where source_key=${`event-reminder:${eventId}`}`).toHaveLength(0);
    await owner`update users set account_state='active' where org_id=${orgId} and id=${userId}`;
  }
  await owner`delete from event_reminder_intents where event_id=${eventId}`;
  await owner`delete from event_rsvps where event_id=${eventId}`;
  await owner`delete from events where id=${eventId}`;
});

// what_bug_this_catches: moving reconciliation into GET bypasses quiet hours or
// commits its writes even when the authenticated authority recheck fails.
it('defers due projection during quiet hours and rolls it back on session revocation',async()=>{
  const eventId='a4000000-0000-4000-8000-000000000002';
  await owner`insert into events(id,org_id,title,starts_at,time_zone,location,published_at,created_by)
    values(${eventId},${orgId},'Quiet event',now()+interval '1 hour','UTC','Synthetic hall',now(),${userId})`;
  await createPostgresEventRepository(runtime).rsvp({...identity,roles:['senior']},eventId);
  const now=(await owner<{now:Date}[]>`select statement_timestamp() as now`)[0]!.now;
  const minute=now.getUTCHours()*60+now.getUTCMinutes();
  const hhmm=(value:number)=>`${String(Math.floor(value/60)).padStart(2,'0')}:${String(value%60).padStart(2,'0')}`;
  const preferences={...optedIn(),quiet_hours:{start:hhmm((minute+1439)%1440),end:hhmm((minute+60)%1440),timezone:'UTC'}};
  await owner`insert into notification_preferences(org_id,user_id,preferences)
    values(${orgId},${userId},${JSON.stringify(preferences)}::text::jsonb)`;
  expect((await inboxGET(req('/api/v1/notifications'))).status).toBe(200);
  expect(await owner`select id from notification_inbox where source_key=${`event-reminder:${eventId}`}`).toHaveLength(0);
  await owner`delete from notification_preferences where org_id=${orgId} and user_id=${userId}`;
  let checks=0;
  await expect(createResidentRepository(runtime).list(identity,undefined,'en',()=>{
    return ++checks===2 ? Promise.reject(new Error('Session revoked')) : Promise.resolve();
  })).rejects.toThrow('Session revoked');
  expect(checks).toBe(2);
  expect(await owner`select id from notification_inbox where source_key=${`event-reminder:${eventId}`}`).toHaveLength(0);
  const responses=await Promise.all([inboxGET(req('/api/v1/notifications')),inboxGET(req('/api/v1/notifications'))]);
  expect(responses.map(response=>response.status)).toEqual([200,200]);
  expect(await owner`select id from notification_inbox where source_key=${`event-reminder:${eventId}`}`).toHaveLength(1);
  await owner`delete from notification_inbox where source_key=${`event-reminder:${eventId}`}`;
  await owner`delete from event_reminder_intents where event_id=${eventId}`;
  await owner`delete from event_rsvps where event_id=${eventId}`;
  await owner`delete from events where id=${eventId}`;
});

// what_bug_this_catches: a real event reminder reaches and completes the durable
// outbox but never appears on the resident's public inbox, or channel/retry
// fan-out publishes duplicate cards after participation is revoked.
it('transfers an authorized event delivery exactly once through the public inbox route',async()=>{
  const eventId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  const rsvpId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
  await owner`insert into events(id,org_id,title,starts_at,time_zone,location,published_at,created_by)
    values(${eventId},${orgId},'Synthetic public event',now()+interval '2 days','UTC','Synthetic hall',now(),${userId})`;
  await owner`insert into event_rsvps(id,org_id,event_id,user_id,state) values(${rsvpId},${orgId},${eventId},${userId},'attending')`;
  const notify = createRuntime(runtime,createBossQueue(boss));
  await notify.replace(identity,{...optedIn(),channels:{event_reminder:{sms:true}}});
  await createPostgresWp009ReminderScheduler(runtime).schedule({idempotencyKey:'event-public-1',eventId,orgId,userId,purpose:'event_reminder',dueAt:new Date(0)});
  await notify.recover(identity);
  const jobs = await boss.fetch('notify.send.sms'); expect(jobs).toHaveLength(1);
  const consume = createConsumer(postgresWorkerLookup(runtime),notify,orgId);
  // Lose queue-level retries after delivery commits but inbox insertion fails.
  await owner.unsafe('REVOKE INSERT ON notification_inbox FROM seniorsocial_app');
  try { await expect(consume('notify.send.sms',jobs[0]!.data)).rejects.toThrow(); }
  finally { await owner.unsafe('GRANT INSERT ON notification_inbox TO seniorsocial_app'); }
  await boss.complete('notify.send.sms',jobs[0]!.id);
  expect(await createPostgresRepository(runtime).schedulable(identity)).toEqual(expect.arrayContaining([expect.objectContaining({state:'delivered'})]));
  await notify.recover(identity); await notify.recover(identity);
  expect(await createPostgresRepository(runtime).schedulable(identity)).toEqual([]);
  expect(await boss.fetch('notify.send.sms')).toHaveLength(0);
  expect(await owner`select sequence,outcome from notification_attempts where org_id=${orgId} and user_id=${userId}`).toMatchObject([{sequence:1,outcome:'started'},{sequence:1,outcome:'confirmed'}]);
  await consume('notify.send.sms',jobs[0]!.data);
  const response = await inboxGET(req('/api/v1/notifications')); expect(response.status).toBe(200);
  const page = await response.json() as {items:{id:string;purpose:string;title:string;body:string;read_at:string|null}[]};
  const notices = page.items.filter(item=>item.purpose==='event_reminder');
  expect(notices).toHaveLength(1); expect(notices[0]?.title).toBe('Event reminder');
  expect(typeof notices[0]?.id).toBe('string'); expect(typeof notices[0]?.body).toBe('string'); expect(notices[0]?.read_at).toBeNull();
  expect(await owner`select id from notification_inbox where org_id=${orgId} and user_id=${userId} and source_key=${`event-reminder:${eventId}`}`).toHaveLength(1);
  const scheduleResponse = await printGET(req(`/api/v1/me/schedule/print?week_of=${currentWeek()}`));
  const schedule = await scheduleResponse.json() as RegisteredSchedule;
  expect(schedule.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({key:'events',status:'available',item_count:1}),
    expect.objectContaining({key:'rides',status:'available',item_count:0}),
    expect.objectContaining({key:'assistance',status:'available',item_count:0}),
  ]));
  const eventItem = schedule.items.find(item=>item.id===eventId);
  expect(eventItem?.schedule_source).toBe('events'); expect(eventItem?.schedule_source_version).toMatch(/^events:v1:/);

  const revokedEvent = 'abababab-abab-4bab-8bab-abababababab';
  const revokedRsvp = 'cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd';
  await owner`insert into events(id,org_id,title,starts_at,time_zone,location,published_at,created_by)
    values(${revokedEvent},${orgId},'Revoked synthetic event',now()+interval '3 days','UTC','Synthetic hall',now(),${userId})`;
  await owner`insert into event_rsvps(id,org_id,event_id,user_id,state) values(${revokedRsvp},${orgId},${revokedEvent},${userId},'attending')`;
  await createPostgresWp009ReminderScheduler(runtime).schedule({idempotencyKey:'event-revoked-1',eventId:revokedEvent,orgId,userId,purpose:'event_reminder',dueAt:new Date(0)});
  await owner`update event_rsvps set state='cancelled',updated_at=now() where id=${revokedRsvp}`;
  await notify.recover(identity);
  const revoked = await boss.fetch('notify.send.sms'); expect(revoked).toHaveLength(1);
  expect(await consume('notify.send.sms',revoked[0]!.data)).toMatchObject({status:'suppressed'});
  expect(await owner`select id from notification_inbox where source_key=${`event-reminder:${revokedEvent}`}`).toHaveLength(0);
  await boss.complete('notify.send.sms',revoked[0]!.id);
  await owner`delete from notification_inbox where org_id=${orgId} and source_key=${`event-reminder:${eventId}`}`;
  await owner.unsafe('truncate notification_attempts');
  await owner`delete from notification_outbox where org_id=${orgId} and payload->>'purpose'='event_reminder'`;
  await owner`delete from event_rsvps where org_id=${orgId} and event_id in (${eventId},${revokedEvent})`;
  await owner`delete from events where org_id=${orgId} and id in (${eventId},${revokedEvent})`;
});

// what_bug_this_catches: the public route omits the registered assistance
// adapter, discloses another resident/tenant request, loses provenance on
// replay, or disturbs the registered-but-empty ride source.
it('serves only the resident assistance schedule with durable source provenance',async()=>{
  const assistanceId = 'a1000000-0000-4000-8000-000000000001';
  const otherAssistanceId = 'a1000000-0000-4000-8000-000000000002';
  const foreignAssistanceId = 'a1000000-0000-4000-8000-000000000003';
  const foreignUser = 'a1000000-0000-4000-8000-000000000004';
  await owner`insert into users(id,org_id,display_name) values(${foreignUser},${otherOrg},'Synthetic assistance partition resident')`;
  await owner`insert into assistance_requests(id,org_id,requester_id,summary_ciphertext,locale,triage_category,triage_source,after_hours,idempotency_key,created_at) values
    (${assistanceId},${orgId},${userId},'resident-secret-target','en','transportation','rules',false,'assist-target-001','2026-09-08T09:00:00Z'),
    (${otherAssistanceId},${orgId},${otherUser},'resident-secret-other','en','food','rules',false,'assist-other-001','2026-09-08T10:00:00Z'),
    (${foreignAssistanceId},${otherOrg},${foreignUser},'resident-secret-foreign','en','housing','rules',false,'assist-foreign-001','2026-09-08T11:00:00Z')`;
  await owner`insert into assistance_transitions(org_id,request_id,actor_id,from_state,to_state,reason,at) values
    (${orgId},${assistanceId},${userId},null,'pending_unowned','Synthetic request','2026-09-08T09:00:00Z'),
    (${orgId},${otherAssistanceId},${otherUser},null,'pending_unowned','Synthetic request','2026-09-08T10:00:00Z'),
    (${otherOrg},${foreignAssistanceId},${foreignUser},null,'pending_unowned','Synthetic request','2026-09-08T11:00:00Z')`;
  await owner`insert into sla_clocks(org_id,request_id,due_at) values
    (${orgId},${assistanceId},'2026-09-08T11:00:00Z'),
    (${orgId},${otherAssistanceId},'2026-09-08T11:00:00Z'),
    (${otherOrg},${foreignAssistanceId},'2026-09-08T12:00:00Z')`;

  const endpoint = '/api/v1/me/schedule/print?week_of=2026-09-07&idempotency_key=assistance-live-replay';
  const firstResponse = await printGET(req(endpoint));
  expect(firstResponse.status).toBe(200);
  const first = await firstResponse.json() as RegisteredSchedule;
  expect(first.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({key:'events',status:'available'}),
    expect.objectContaining({key:'rides',status:'available',item_count:0}),
    expect.objectContaining({key:'assistance',status:'available',item_count:1}),
  ]));
  expect(first.sources.find(source=>source.key==='assistance')?.source_version).toMatch(/^assistance:v1:/);
  expect(first.items.filter(item=>item.schedule_source==='assistance')).toEqual([
    expect.objectContaining({id:assistanceId,kind:'assistance',state:'pending_unowned',triage_category:'transportation',
      schedule_source:'assistance'}),
  ]);
  expect(first.items.find(item=>item.id===assistanceId)?.schedule_source_version).toMatch(/^assistance:v1:/);
  const assistanceItem = first.items.find(item=>item.id===assistanceId)!;
  const assistanceSource = first.sources.find(source=>source.key==='assistance')!;
  expect(assistanceItem.schedule_source_version).toBe(assistanceSource.source_version);
  expect(assistanceItem.schedule_source_as_of).toBe(assistanceSource.as_of);
  expect(Object.keys(assistanceItem).sort()).toEqual([
    'id','kind','requested_at','schedule_source','schedule_source_as_of','schedule_source_version','sla_due_at','state','triage_category',
  ]);
  expect(JSON.stringify(first)).not.toContain('resident-secret');
  expect(JSON.stringify(first)).not.toContain(otherAssistanceId);
  expect(JSON.stringify(first)).not.toContain(foreignAssistanceId);
  expect(await (await printGET(req(endpoint))).json()).toEqual(first);
});

// what_bug_this_catches: the public print composition omits persisted rides,
// leaks a different resident/tenant/week, or reads a stale request state instead
// of the latest immutable ride transition when timestamps tie.
it('serves the resident week ride with authoritative state and provenance',async()=>{
  const targetRide = 'b1000000-0000-4000-8000-000000000001';
  const otherRide = 'b1000000-0000-4000-8000-000000000002';
  const foreignRide = 'b1000000-0000-4000-8000-000000000003';
  const outsideRide = 'b1000000-0000-4000-8000-000000000004';
  const foreignUser = 'b1000000-0000-4000-8000-000000000005';
  await owner`insert into users(id,org_id,display_name) values(${foreignUser},${otherOrg},'Synthetic ride partition resident')`;
  const rides = [
    {id:targetRide,org:orgId,resident:userId,pickup:'2027-01-20T15:00:00Z',key:'ride-target'},
    {id:otherRide,org:orgId,resident:otherUser,pickup:'2027-01-20T16:00:00Z',key:'ride-other'},
    {id:foreignRide,org:otherOrg,resident:foreignUser,pickup:'2027-01-20T17:00:00Z',key:'ride-foreign'},
    {id:outsideRide,org:orgId,resident:userId,pickup:'2027-01-26T00:00:00Z',key:'ride-outside'},
  ];
  for (const ride of rides) {
    await owner`insert into ride_requests(id,org_id,resident_id,requested_by_actor_id,purpose,mode,pickup_at,pickup_tz,pickup_location,destination_location,return_needed,idempotency_key,request_hash)
      values(${ride.id},${ride.org},${ride.resident},${ride.resident},'Clinic visit','partner_van',${ride.pickup},'America/New_York','Resident lobby','Community clinic',true,${ride.key},${'1'.repeat(64)})`;
    await owner`insert into ride_transitions(org_id,ride_id,actor_id,from_state,to_state,at,reason,idempotency_key,request_hash)
      values(${ride.org},${ride.id},${ride.resident},'draft','requested','2027-01-10T10:00:00Z','ride_request_submitted',${`create:${ride.key}`},${'1'.repeat(64)})`;
  }
  await owner`insert into ride_accessibility_conditions(org_id,ride_id,position,code,verbatim_label) values
    (${orgId},${targetRide},1,'needs_an_arm','Please offer your left arm'),
    (${orgId},${targetRide},0,'wheelchair','Uses a 24-inch wheelchair'),
    (${orgId},${otherRide},0,'oxygen','Other resident oxygen detail'),
    (${otherOrg},${foreignRide},0,'service_animal','Foreign resident service animal detail')`;
  await owner`insert into ride_transitions(id,org_id,ride_id,actor_id,from_state,to_state,at,reason,provider_evidence,idempotency_key,request_hash) values
    ('c1000000-0000-4000-8000-000000000001',${orgId},${targetRide},${userId},'requested','waiting_for_dispatcher','2027-01-10T10:01:00Z','dispatch_received','local-queue:target','dispatch:target','dispatch-target'),
    ('c1000000-0000-4000-8000-000000000002',${orgId},${targetRide},${userId},'waiting_for_dispatcher','unable_to_fulfill','2027-01-10T10:01:00Z','No accessible driver',null,'unable-target','unable-target')`;

  const endpoint = '/api/v1/me/schedule/print?week_of=2027-01-19&idempotency_key=ride-live-replay';
  const response = await printGET(req(endpoint));
  expect(response.status).toBe(200);
  const first = await response.json() as RegisteredSchedule;
  expect(first.sources.map(source=>source.key)).toEqual(['events','rides','assistance']);
  expect(first.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({key:'events',status:'available'}),
    expect.objectContaining({key:'rides',status:'available',item_count:1}),
    expect.objectContaining({key:'assistance',status:'available'}),
  ]));
  expect(first.items.filter(item=>item.schedule_source==='rides')).toEqual([
    expect.objectContaining({id:targetRide,kind:'ride',state:'unable_to_fulfill',pickup_at:'2027-01-20T15:00:00.000Z',schedule_source:'rides',
      accessibility_details:[
        {code:'wheelchair',label:'Uses a 24-inch wheelchair'},
        {code:'needs_an_arm',label:'Please offer your left arm'},
      ]}),
  ]);
  const rideItem = first.items.find(item=>item.id===targetRide)!;
  const rideSource = first.sources.find(source=>source.key==='rides')!;
  expect(rideSource.source_version).toMatch(/^rides:v1:/);
  expect(rideItem.schedule_source_version).toBe(rideSource.source_version);
  expect(rideItem.schedule_source_as_of).toBe(rideSource.as_of);
  expect(JSON.stringify(first)).not.toContain(otherRide);
  expect(JSON.stringify(first)).not.toContain(foreignRide);
  expect(JSON.stringify(first)).not.toContain(outsideRide);
  expect(JSON.stringify(first)).not.toContain('Other resident oxygen detail');
  expect(JSON.stringify(first)).not.toContain('Foreign resident service animal detail');
  expect(await (await printGET(req(endpoint))).json()).toEqual(first);
});

// what_bug_this_catches: broad catch-and-continue turns unexpected assistance
// faults into a successful partial schedule. Only the package's typed outage
// signal may be isolated while the event snapshot remains available.
it('isolates typed assistance outages but fails unexpected assistance faults',async()=>{
  const classifier = (error: unknown) => error instanceof AssistanceScheduleUnavailableError
    && error.code === 'assistance_schedule_unavailable';
  const events = {read:vi.fn(()=>Promise.resolve({as_of:'2026-09-10T10:41:00.000Z',source_version:'events:live-v1',items:[{id:'event-live',title:'Synthetic live event'}]}))};
  const typed = createRegisteredScheduleSource([
    {key:'events',source:events},
    {key:'assistance',source:{read:()=>Promise.reject(new AssistanceScheduleUnavailableError())},isUnavailableError:classifier},
  ],()=>new Date('2026-09-10T10:42:37.000Z'));
  const typedEndpoint = '/api/v1/me/schedule/print?week_of=2026-09-07&idempotency_key=assistance-typed-outage';
  const partial = await (await createPrintHandler(typed)(req(typedEndpoint))).json() as RegisteredSchedule;
  expect(partial.items).toEqual([expect.objectContaining({id:'event-live',schedule_source:'events'})]);
  expect(partial.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({key:'events',status:'available'}),
    expect.objectContaining({key:'assistance',status:'unavailable'}),
  ]));

  const defect = new Error('unexpected assistance defect');
  const unexpectedRead = vi.fn(()=>Promise.reject(defect));
  const unexpected = createRegisteredScheduleSource([
    {key:'events',source:events},
    {key:'assistance',source:{read:unexpectedRead},isUnavailableError:classifier},
  ],()=>new Date('2026-09-10T10:42:37.000Z'));
  const unexpectedKey = 'assistance-unexpected-fault';
  expect((await createPrintHandler(unexpected)(req(`/api/v1/me/schedule/print?week_of=2026-09-07&idempotency_key=${unexpectedKey}`))).status).toBe(403);
  expect(unexpectedRead).toHaveBeenCalledOnce();
  expect(await owner`select id from print_jobs where org_id=${orgId} and idempotency_key=${unexpectedKey}`).toHaveLength(0);
});

// what_bug_this_catches: audit drain marks an intent emitted before WP-006 persists it.
it('persists canonical audit events before acknowledgment and retries sink failure losslessly', async () => {
  const repository = createPostgresRepository(runtime);
  const intent = { actor: `user:${userId}`, on_behalf_of: null, action: 'notification.queued', target: 'notification:restricted', org_id: orgId, outcome: 'allowed', reason: 'notification_queued' } as const;
  await repository.transaction(identity, tx => tx.audit(intent));
  const pending = (await repository.pendingAudits(identity))[0]!;
  const sink = createDurableNotificationAudit(runtime);
  await expect(createDurableNotificationAudit(owner).emit({ ...intent, actor: 'invalid' }, pending.id)).rejects.toThrow();
  expect(await repository.pendingAudits(identity)).toHaveLength(1);
  await sink.emit(pending.intent, pending.id);
  const rows = await owner`select action,request_id from audit_events where request_id = ${pending.id}`;
  expect(rows).toHaveLength(1); expect(rows[0]?.action).toBe('notification.queued');
  expect(await repository.pendingAudits(identity)).toHaveLength(1);
  // Crash window after persistence is explicitly at-least-once, stable correlation.
  await sink.emit(pending.intent,pending.id); await repository.acknowledgeAudit(identity,pending.id);
  expect(await owner`select id from audit_events where request_id = ${pending.id}`).toHaveLength(2);
  expect(await repository.pendingAudits(identity)).toHaveLength(0);
});

// what_bug_this_catches: real queue repetition bypasses the durable outbox claim.
it('publishes canonical pg-boss jobs and performs one synthetic adapter delivery across retries', async () => {
  const repository = createPostgresRepository(runtime);
  const queue = createBossQueue(boss);
  const adapter = { send: vi.fn((delivery: Parameters<ReturnType<typeof createSimulator>['send']>[0]) => createSimulator().send(delivery)) };
  const notify = createNotify({ repository, queue, adapter, audit: createDurableNotificationAudit(runtime), flags: { enabled: () => Promise.resolve(false) }, authorization: { canNotify: (actor,recipient) => Promise.resolve(actor.userId === recipient), canDisclose: () => Promise.resolve(false) }, renderer: { destination: () => Promise.resolve('synthetic@example.invalid'), body: () => Promise.resolve('Synthetic only') }, clock: () => new Date() });
  await notify.replace(identity,optedIn());
  await notify.enqueue(identity,request); await notify.enqueue(identity,request);
  const jobs = await boss.fetch('notify.send.sms'); expect(jobs).toHaveLength(1);
  const consume = createConsumer(postgresWorkerLookup(runtime),notify,orgId);
  const job = jobs[0]!;
  await consume('notify.send.sms',job.data); await consume('notify.send.sms',job.data);
  expect(adapter.send).toHaveBeenCalledTimes(1);
  // what_bug_this_catches: a valid other-partition row passes payload lookup and is delivered.
  const foreignUser = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  await owner`insert into users(id,org_id,display_name) values(${foreignUser},${otherOrg},'Synthetic partition resident')`;
  const foreignPayload = {...job.data as object,org_id:otherOrg,user_id:foreignUser} as Parameters<typeof queue.enqueue>[1];
  await owner`insert into notification_outbox(id,org_id,user_id,actor_id,channel,idempotency_key,payload,due_at)
    values(uuid_generate_v4(),${otherOrg},${foreignUser},${foreignUser},'sms',${foreignPayload.idempotency_key},${JSON.stringify(foreignPayload)}::text::jsonb,now())`;
  expect(await postgresWorkerLookup(runtime).find({orgId:otherOrg,userId:foreignUser},'sms',foreignPayload)).toBeTruthy();
  const lookup = {find:vi.fn((...args: Parameters<ReturnType<typeof postgresWorkerLookup>['find']>) => postgresWorkerLookup(runtime).find(...args))};
  await expect(createConsumer(lookup,notify,orgId)('notify.send.sms',foreignPayload)).rejects.toThrow('Notification unavailable');
  expect(lookup.find).not.toHaveBeenCalled();
  expect(await owner`select state,attempts from notification_outbox where org_id=${otherOrg}`).toMatchObject([{state:'pending',attempts:0}]);
  expect(adapter.send).toHaveBeenCalledTimes(1);
  await boss.complete('notify.send.sms', job.id);
  expect(await owner`select id from notification_outbox where state='delivered'`).toHaveLength(1);
  await expect(consume('notify.send.sms',{ ...(job.data as object), org_id: otherOrg })).rejects.toThrow('Notification unavailable');
  expect(adapter.send).toHaveBeenCalledTimes(1);
});

// what_bug_this_catches: recipient RLS, read markers, real session auth or source provenance drift.
it('serves authenticated inbox/preferences/print while excluding another resident and stale sessions', async () => {
  const residents = createResidentRepository(runtime);
  await residents.publish(identity,'notice-1',{purpose:'task_notice',title:'Synthetic notice',body:'Private synthetic detail'});
  await expect(residents.publish(identity,'notice-1',{purpose:'task_notice',title:'Changed notice',body:'Conflicting retry'})).rejects.toThrow('Notification source conflict');
  await residents.publish(otherIdentity,'notice-2',{purpose:'task_notice',title:'Other resident',body:'Must not disclose'});
  const source = {read: () => Promise.resolve(snapshot)};
  const prints = createPrintService(runtime,source);
  await prints.current(identity,'2026-08-01');
  await prints.current(identity,'2026-08-01');
  await expect(createPrintService(runtime,{read: () => Promise.resolve({...snapshot,items:[]})}).current(identity,'2026-08-01')).rejects.toThrow('Snapshot version conflict');
  await expect(createPrintService(runtime,{read: () => Promise.resolve({...snapshot,sources:[
    {key:'rides',status:'not_registered',source_version:null,as_of:null,item_count:0},
  ]})}).current(identity,'2026-08-01')).rejects.toThrow('Snapshot version conflict');
  const response = await inboxGET(req('/api/v1/notifications')); expect(response.status).toBe(200);
  const page = await response.json() as {items:{id:string;body:string}[]}; expect(page.items).toHaveLength(1); expect(page.items[0]!.body).toBe('Private synthetic detail');
  const read = await markRead(req('/api/v1/notifications/read','POST'),{params:Promise.resolve({notificationId:page.items[0]!.id})}); expect(read.status).toBe(204);
  expect((await residents.list(identity)).items?.[0]?.read_at).toBeTruthy();
  const otherId = (await residents.list(otherIdentity)).items![0]!.id!;
  expect((await markRead(req('/api/v1/notifications/read','POST'),{params:Promise.resolve({notificationId:otherId})})).status).toBe(403);
  expect((await printGET(req('/api/v1/me/schedule/print'))).status).toBe(200);
  expect(await (await createPrintHandler(source)(req('/api/v1/me/schedule/print?week_of=2026-08-01'))).json()).toEqual(snapshot);
  expect((await preferencesGET(req('/api/v1/me/preferences'))).status).toBe(200);
  const saved = await PUT(req('/api/v1/me/preferences','PUT',{...optedIn(),channels:{recommendations:{email:true}}})); expect(saved.status).toBe(200);
  expect((await saved.json() as {channels:{task_notice:{sms:boolean}}}).channels.task_notice.sms).toBe(true);
  const missingRecipient = await withOrg(runtime, orgId, sql => sql`select id from notification_inbox`); expect(missingRecipient).toHaveLength(0);
  await owner`update sessions set revoked_at=now() where token_digest=${digestSecret(token,pepper)}`;
  expect((await inboxGET(req('/api/v1/notifications'))).status).toBe(403);
  expect((await printGET(req('/api/v1/me/schedule/print'))).status).toBe(403);
}, 15000);

// what_bug_this_catches: truncating PostgreSQL microseconds skips inbox rows at page boundaries.
it('pages a full inbox without losing same-timestamp rows or leaking another resident', async () => {
  await owner`insert into notification_inbox (org_id,user_id,source_key,purpose,title,body,created_at)
    select ${orgId},${otherUser},'page-' || value,'task_notice','Synthetic page','Synthetic only','2026-09-01T12:00:00.123456Z'::timestamptz from generate_series(1,101) as value`;
  const residents = createResidentRepository(runtime);
  const first = await residents.list(otherIdentity);
  expect(first.items).toHaveLength(100);
  expect(first.meta?.next_cursor).toContain('.123456Z');
  const second = await residents.list(otherIdentity,first.meta!.next_cursor!);
  expect(second.items).toHaveLength(2);
  expect(new Set([...first.items!,...second.items!].map(item => item.id)).size).toBe(102);
  expect((await residents.list(identity)).items).toHaveLength(1);
});

// what_bug_this_catches: a print queue is named incorrectly, retries create new print
// rows, a route reads a different source than the worker, or scope derives from job ID.
it('materializes one canonical print job across real pg-boss retries and the authenticated API', async () => {
  await owner`update sessions set revoked_at=null where token_digest=${digestSecret(token,pepper)}`;
  const source = {read: vi.fn(() => Promise.resolve(snapshot))};
  const service = createPrintService(runtime,source);
  const queue = createBossPrintQueue(boss);
  const payload: PrintPayload = {idempotency_key:'print-regression-1',org_id:orgId,user_id:userId,week_of:'2026-08-01'};
  expect((await authenticated(req('/api/v1/me/schedule/print'),async (scope,_client,recheck) => {
    await service.request(scope,payload,recheck); return new Response(null,{status:204});
  })).status).toBe(204);
  expect(await queue.enqueue(identity,payload)).toEqual({published:true});
  expect(await queue.enqueue(identity,payload)).toEqual({published:false});
  const queued = await boss.fetch<PrintPayload>(PRINT_QUEUE,{includeMetadata:true});
  expect(queued).toHaveLength(1); expect(queued[0]!.name).toBe('notify.render.print');
  expect(queued[0]!.data).toEqual(payload); expect(queued[0]!.singletonKey).toBe(payload.idempotency_key);
  const consume = createPrintConsumer(service,orgId);
  const first = await consume(PRINT_QUEUE,queued[0]!.data);
  expect(await consume(PRINT_QUEUE,queued[0]!.data)).toEqual(first);
  expect(source.read).toHaveBeenCalledTimes(1);
  expect(await owner`select id from print_jobs where idempotency_key=${payload.idempotency_key}`).toHaveLength(1);
  const viaApi = await createPrintHandler(source)(req(`/api/v1/me/schedule/print?week_of=${payload.week_of}&idempotency_key=${payload.idempotency_key}`));
  expect(viaApi.status).toBe(200); expect(await viaApi.json()).toEqual(first); expect(source.read).toHaveBeenCalledTimes(1);
  await boss.complete(PRINT_QUEUE,queued[0]!.id);
  await expect(consume(PRINT_QUEUE,{...payload,org_id:otherOrg})).rejects.toThrow('Unavailable');
  await expect(queue.enqueue(identity,{...payload,user_id:otherUser})).rejects.toThrow('Unavailable');
  await expect(consume(PRINT_QUEUE,{...payload,week_of:'2026-08-02'})).rejects.toThrow('Unavailable');
  expect(await owner`select id from print_jobs where idempotency_key=${payload.idempotency_key}`).toHaveLength(1);
  expect(source.read).toHaveBeenCalledTimes(1);
},15000);

// what_bug_this_catches: upstream absence fails all prints, fabricates schedule data,
// or uses render-time freshness instead of the current source observation.
it('renders the current zero-item source truthfully through both route and worker', async () => {
  const observed = new Date('2026-09-10T10:42:37.000Z');
  const source = createCurrentScheduleSource(() => observed);
  const service = createPrintService(runtime,source);
  const payload: PrintPayload = {idempotency_key:'empty-current-1',org_id:orgId,user_id:userId,week_of:'2026-09-07'};
  expect((await authenticated(req('/api/v1/me/schedule/print'),async (scope,_client,recheck) => {
    await service.request(scope,payload,recheck); return new Response(null,{status:204});
  })).status).toBe(204);
  const consume = createPrintConsumer(service,orgId);
  const printed = await consume(PRINT_QUEUE,payload);
  expect(printed.items).toEqual([]);
  expect(printed.as_of).toBe('2026-09-10T10:42:00.000Z');
  expect(printed.source_version).toContain('schedule:no-connected-sources:v1:2026-09-07:2026-09-10T10:42:00.000Z');
  const route = createPrintHandler(source);
  const endpoint = '/api/v1/me/schedule/print?week_of=2026-09-07&idempotency_key=empty-current-1';
  expect(await (await route(req(endpoint))).json()).toEqual(printed);
  const htmlRequest = req(endpoint); htmlRequest.headers.set('accept','text/html');
  const html = await (await route(htmlRequest)).text();
  expect(html).toContain('not confirmation that you have no upcoming plans');
  expect(html).toContain(printed.as_of); expect(html).toContain(printed.source_version);
  const current = await service.current(identity,payload.week_of);
  expect(current).toEqual(printed);
  expect(await service.current(identity,payload.week_of)).toEqual(current);
  const noRecipient = await withOrg(runtime,orgId,sql => sql`select id from print_jobs`);
  expect(noRecipient).toHaveLength(0);
});

// what_bug_this_catches: immutable print replay drops source metadata and hides
// missing/unavailable sources in both JSON and HTML after the first request.
it('preserves registered source metadata across immutable print replay',async()=>{
  const source = createRegisteredScheduleSource([
    {key:'events',source:{read:()=>Promise.resolve({...snapshot,items:[]})}},
    {key:'assistance',source:{read:()=>Promise.reject(new AssistanceScheduleUnavailableError())},
      isUnavailableError:error=>error instanceof AssistanceScheduleUnavailableError && error.code==='assistance_schedule_unavailable'},
  ],
    () => new Date('2026-09-10T10:42:37.000Z'));
  const route = createPrintHandler(source);
  const endpoint = '/api/v1/me/schedule/print?week_of=2026-08-01&idempotency_key=registered-replay';
  const first = await (await route(req(endpoint))).json() as RegisteredSchedule;
  expect(first.sources).toEqual(expect.arrayContaining([expect.objectContaining({key:'rides',status:'not_registered'})]));
  expect(await (await route(req(endpoint))).json()).toEqual(first);
  const html = req(endpoint); html.headers.set('accept','text/html');
  expect(await (await route(html)).text()).toContain('rides: not_registered');
  expect(first.items).toEqual([]);
  expect(first.sources).toEqual(expect.arrayContaining([
    expect.objectContaining({key:'events',status:'available',item_count:0}),
    expect.objectContaining({key:'assistance',status:'unavailable',item_count:0}),
  ]));
  const automatic = createPrintService(runtime,source);
  expect(await automatic.current(identity,'2026-08-01')).toEqual(first);
  expect(await automatic.current(identity,'2026-08-01')).toEqual(first);
  await owner`insert into print_jobs(org_id,user_id,week_of,idempotency_key,as_of,source_version,items)
    values(${orgId},${userId},'2026-08-01','legacy-null-sources','2026-08-01T12:00:00.000Z','legacy:v1','[]'::jsonb)`;
  const legacy = await createResidentRepository(runtime).renderPrint(identity,'2026-08-01','legacy-null-sources',
    () => Promise.reject(new Error('legacy replay must not read a source')),() => Promise.resolve());
  expect(legacy).not.toHaveProperty('sources');
});
