import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient, withOrg, type DatabaseClient } from '../../../packages/db/src/index.ts';
import { createMessageNoticeAuthorization, createMessaging, MessagingError, wp009Notices } from '../../../packages/messaging/src/index.ts';
import { createNotify, createPostgresRepository, type Delivery } from '../../../packages/notify/src/index.ts';
import { AuthService, PostgresAuthStore, type AuthSql } from '../../../packages/auth/src/index.ts';
import { handler, resolveIdentity } from '../../../apps/web/app/api/v1/conversations/_runtime.ts';

const clusterUrl = process.env.MESSAGING_TEST_CLUSTER_URL;
if (!clusterUrl) throw new Error('MESSAGING_TEST_CLUSTER_URL is required; live messaging tests never skip');
const parsed = new URL(clusterUrl);
if (!['127.0.0.1', 'localhost'].includes(parsed.hostname) || !parsed.pathname.includes('wp016_test')) throw new Error('Dedicated local wp016_test cluster required');
const name = `wp016_test_${process.pid}_${Date.now()}`;
const role = `${name}_app`;
let admin: DatabaseClient;
let owner: DatabaseClient;
let runtime: DatabaseClient;
const org = '10000000-0000-4000-8000-000000000001';
const foreignOrg = '20000000-0000-4000-8000-000000000001';
const alice = { orgId: org, userId: '10000000-0000-4000-8000-000000000011' };
const bob = { orgId: org, userId: '10000000-0000-4000-8000-000000000012' };
const eve = { orgId: org, userId: '10000000-0000-4000-8000-000000000013' };
const outsider = { orgId: foreignOrg, userId: '20000000-0000-4000-8000-000000000011' };
let service: ReturnType<typeof createMessaging>;
let conversationId: string;
const canary = 'PRIVATE_BODY_CANARY_WP016';
const migration = (file: string) => readFile(new URL(`../../../packages/db/migrations/${file}`, import.meta.url), 'utf8');

describe('WP-016 live tenant messaging', () => {
  beforeAll(async () => {
    admin = createDatabaseClient(clusterUrl);
    await admin.unsafe(`create database "${name}"`);
    const url = new URL(clusterUrl); url.pathname = `/${name}`;
    owner = createDatabaseClient(url.toString());
    for (const file of ['0001_wp-003_core_tables.sql', '0010_wp-004_auth.sql', '0011_wp-004_auth_rate_limits.sql', '0040_wp-009_notify.sql', '0090_wp-015_forums.sql', '0100_wp-016_messaging.sql']) await owner.unsafe(await migration(file));
    await owner.unsafe(await migration('0100_wp-016_messaging.down.sql'));
    expect((await owner`select to_regclass('messaging_messages') as relation`)[0]?.relation).toBeNull();
    await owner.unsafe(await migration('0100_wp-016_messaging.sql'));
    await owner.unsafe(`create role "${role}" login password 'wp016_test_only' nosuperuser nobypassrls`);
    await owner.unsafe(`grant seniorsocial_app to "${role}"`);
    // WP-004 deliberately grants its tables to a dedicated runtime role.
    await owner.unsafe(`grant select, insert, update, delete on verification_tokens, sessions, demo_accounts, recovery_contacts, auth_rate_limits to "${role}"`);
    await owner`insert into orgs(id, name, slug) values (${org}, 'Messaging', ${name}), (${foreignOrg}, 'Foreign', ${`${name}-foreign`})`;
    for (const identity of [alice, bob, eve, outsider]) {
      await owner`insert into users(id, org_id, display_name, email) values (${identity.userId}, ${identity.orgId}, 'Synthetic resident', ${`${identity.userId}@example.invalid`})`;
      await owner`insert into user_roles(org_id, user_id, role) values (${identity.orgId}, ${identity.userId}, 'senior')`;
    }
    url.username = role; url.password = 'wp016_test_only';
    runtime = createDatabaseClient(url.toString());
    process.env.DATABASE_URL = url.toString(); process.env.AUTH_DATABASE_URL = url.toString();
    process.env.AUTH_TOKEN_PEPPER = 'wp016_test_pepper_never_a_secret'; process.env.SENIORSOCIAL_ORG_ID = org;
    service = createMessaging(runtime, wp009Notices);
    conversationId = (await service.create(alice, bob.userId)).id;
  }, 30_000);
  afterAll(async () => {
    if (runtime) await runtime.end(); if (owner) await owner.end();
    if (admin) { await admin.unsafe(`drop database if exists "${name}" with (force)`); await admin.unsafe(`drop role if exists "${role}"`); await admin.end(); }
  });
  it('requires a nonowner runtime and creates one canonical pair in either direction', async () => {
    await expect(createMessaging(owner, wp009Notices).list(alice)).rejects.toMatchObject({ status: 503 });
    const concurrent = await Promise.all([service.create(alice, bob.userId), service.create(bob, alice.userId)]);
    expect(concurrent.map(value => value.id)).toEqual([conversationId, conversationId]);
    expect((await service.list(eve)).items).toEqual([]);
    await expect(service.create(alice, outsider.userId)).rejects.toMatchObject({ status: 404 });
  });
  it('atomically sends once, rejects changed retry and stores no message text in any notice or audit intent', async () => {
    const preferences = { mode: 'standard', locale: 'es', channels: { message: { email: true, sms: false, voice: false } }, quiet_hours: {}, no_outbound: false, shared_device: true };
    await owner`insert into notification_preferences(org_id,user_id,preferences) values (${org},${bob.userId},${JSON.stringify(preferences)}::text::jsonb)`;
    const [a, b] = await Promise.all([service.send(alice, conversationId, canary, 'send-one'), service.send(alice, conversationId, canary, 'send-one')]);
    expect(a).toEqual(b);
    await expect(service.send(alice, conversationId, 'changed', 'send-one')).rejects.toMatchObject({ status: 409 });
    expect((await service.messages(bob, conversationId)).items).toEqual([a]);
    expect(await owner`select id from messaging_messages`).toHaveLength(1);
    const notices = await owner`select payload, due_at from notification_outbox`;
    expect(notices).toHaveLength(1);
    expect(notices[0]?.payload).toMatchObject({ purpose: 'message', locale: 'es', params: {} });
    const audits = await owner`select intent from notification_audit_pending`;
    expect(JSON.stringify([notices, audits])).not.toContain(canary);
    expect(audits[0]?.intent).toMatchObject({ actor: `user:${alice.userId}` });
  });
  it('rolls back the message when the injected durable notice port fails and sanitizes the driver error', async () => {
    const failing = createMessaging(runtime, { enqueue: () => Promise.reject(new Error(canary)) });
    await expect(failing.send(alice, conversationId, canary, 'must-rollback')).rejects.toEqual(new MessagingError(503));
    expect(await owner`select id from messaging_messages where idempotency_key = 'must-rollback'`).toHaveLength(0);
  });
  it('checks current participant identity in service and forced RLS even within the same tenant', async () => {
    for (const identity of [eve, outsider]) {
      await expect(service.messages(identity, conversationId)).rejects.toMatchObject({ status: 404 });
      await expect(service.send(identity, conversationId, 'attack', 'cross-user')).rejects.toMatchObject({ status: 404 });
      await expect(service.report(identity, conversationId, { reason: 'attack' }, 'cross-user')).rejects.toMatchObject({ status: 404 });
      const rows = await withOrg(runtime, identity.orgId, async sql => {
        await sql`select set_config('app.current_user_id', ${identity.userId}, true)`;
        return sql`select id, body from messaging_messages where conversation_id = ${conversationId}`;
      });
      expect(rows).toHaveLength(0);
    }
    expect(await withOrg(runtime, org, sql => sql`select id from messaging_messages`)).toHaveLength(0);
  });
  it('creates one human-review item across repeat keys without deleting or hiding content', async () => {
    const report = await service.report(bob, conversationId, { reason: 'Please review', note: 'Native sensitive note' }, 'report-one');
    expect(report.state).toBe('open');
    expect(await service.report(bob, conversationId, { reason: 'Please review', note: 'Native sensitive note' }, 'report-two')).toEqual(report);
    await expect(service.report(bob, conversationId, { reason: 'Changed' }, 'report-one')).rejects.toMatchObject({ status: 409 });
    const different = await service.create(bob, eve.userId);
    await expect(service.report(bob, different.id, { reason: 'Please review', note: 'Native sensitive note' }, 'report-two')).rejects.toMatchObject({ status: 409 });
    await service.block(bob, eve.userId);
    expect(await owner`select id from messaging_reports`).toHaveLength(1);
    expect((await service.messages(alice, conversationId)).items).toHaveLength(1);
  });
  it('uses the actual WP-004 server session and ignores client identity assertions', async () => {
    const token = await runtime.begin(async sql => {
      await sql`select set_config('app.current_org_id', ${org}, true)`;
      const auth = new AuthService(new PostgresAuthStore(sql as unknown as AuthSql), { pepper: process.env.AUTH_TOKEN_PEPPER!, exposeSimulationCredentials: true });
      const challenge = await auth.requestMagicLink(org, `${alice.userId}@example.invalid`, 'wp016-browser', '127.0.0.1');
      const result = await auth.verify(org, undefined, challenge.simulationCredential!, 'wp016-browser');
      if (!result.ok) throw new Error('Synthetic login failed');
      return result.value.token;
    });
    const request = new Request('http://localhost/api/v1/conversations', { headers: { cookie: `ss_session=${token}`, 'x-user-id': eve.userId, 'x-org-id': foreignOrg } });
    expect(await resolveIdentity(request)).toEqual(alice);
    const response = await handler('list', { identity: resolveIdentity, run: work => work(service) })(request);
    expect(response.status).toBe(200); expect(((await response.json()) as { items: unknown[] }).items).toHaveLength(1);
    const spoof = await handler('list', { identity: resolveIdentity, run: work => work(service) })(new Request('http://localhost/api/v1/conversations', { headers: { 'x-user-id': alice.userId } }));
    expect(spoof.status).toBe(401);
  });
  it('delivers a generic notice once through WP-009 with actual sender and fresh participant authorization', async () => {
    const authorization = createMessageNoticeAuthorization(runtime);
    expect(await authorization(alice, bob.userId, conversationId)).toBe(true);
    expect(await createMessageNoticeAuthorization(owner)(alice, bob.userId, conversationId)).toBe(false);
    expect(await authorization(eve, bob.userId, conversationId)).toBe(false);
    expect(await authorization(outsider, bob.userId, conversationId)).toBe(false);
    const deliveries: Delivery[] = [];
    const row = (await owner<{ id: string; actor_id: string; due_at: Date; payload: { resource_id: string } }[]>`select id, actor_id, due_at, payload from notification_outbox`)[0]!;
    const deliveryClock = new Date(row.due_at.getTime() + 60_000);
    const notify = createNotify({ repository: createPostgresRepository(runtime), audit: { emit: () => Promise.resolve() },
      authorization: { canNotify: (identity, recipient, purpose, resource) => purpose === 'message' && resource ? authorization(identity, recipient, resource) : Promise.resolve(false), canDisclose: () => Promise.resolve(false) },
      flags: { enabled: () => Promise.resolve(false) }, queue: { enqueue: () => Promise.resolve() },
      adapter: { send: delivery => { deliveries.push(delivery); return Promise.resolve({ outcome: 'confirmed', synthetic: true }); } },
      renderer: { body: () => Promise.resolve('You have a new notification. Sign in securely.'), destination: () => Promise.resolve('synthetic@example.invalid') }, clock: () => deliveryClock });
    expect(row.actor_id).toBe(alice.userId); expect(row.payload.resource_id).toBe(conversationId);
    expect(await notify.send(bob, row.id)).toMatchObject({ status: 'delivered' });
    expect(await notify.send(bob, row.id)).toMatchObject({ status: 'delivered' });
    expect(deliveries).toHaveLength(1); expect(JSON.stringify(deliveries)).not.toContain(canary);
  });
  it('linearizes blocking against an in-flight send, then denies both directions and direct RLS reads', async () => {
    let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    const slow = createMessaging(runtime, { enqueue: async (sql, input) => { entered(); await held; await wp009Notices.enqueue(sql, input); } });
    const sending = slow.send(alice, conversationId, 'before block', 'race-send');
    await ready;
    let blockComplete = false;
    const blocking = service.block(bob, alice.userId).then(value => { blockComplete = true; return value; });
    // A separate round trip proves a pending block cannot complete while send
    // holds the serialization lock; no arbitrary timing sleep is required.
    await owner`select 1`;
    expect(blockComplete).toBe(false); release();
    await sending; await blocking;
    expect(await createMessageNoticeAuthorization(runtime)(alice, bob.userId, conversationId)).toBe(false);
    for (const identity of [alice, bob]) {
      await expect(service.messages(identity, conversationId)).rejects.toMatchObject({ status: 404 });
      await expect(service.send(identity, conversationId, 'after block', 'after-block')).rejects.toMatchObject({ status: 404 });
      expect((await service.list(identity)).items).toHaveLength(0);
      expect(await withOrg(runtime, org, async sql => {
        await sql`select set_config('app.current_user_id', ${identity.userId}, true)`;
        return sql`select id from messaging_messages`;
      })).toHaveLength(0);
    }
    await service.block(bob, alice.userId);
    expect((await service.blocks(bob)).items).toEqual([{ user_id: eve.userId }, { user_id: alice.userId }]);
  });

  for (const recipientPosition of [0, 1] as const) {
    it(`serializes block with final delivery authorization for recipient UUID position ${recipientPosition}`, async () => {
      // what_bug_this_catches: authorization released its read transaction while
      // block committed in the gap before WP-009 invoked the adapter.
      const pair = [randomUUID(), randomUUID()].sort();
      const recipient = { orgId: org, userId: pair[recipientPosition]! };
      const sender = { orgId: org, userId: pair[1 - recipientPosition]! };
      for (const userId of pair) await owner`insert into users(id,org_id,display_name) values(${userId},${org},'Race resident')`;
      const preferences = { mode: 'standard', locale: 'en', channels: { message: { email: true } }, quiet_hours: {}, no_outbound: false, shared_device: false };
      await owner`insert into notification_preferences(org_id,user_id,preferences)
        values(${org},${recipient.userId},${JSON.stringify(preferences)}::text::jsonb)`;
      const conversation = await service.create(sender, recipient.userId);
      await service.send(sender, conversation.id, canary, 'boundary-race');
      await service.send(sender, conversation.id, canary, 'queued-before-block');
      const jobs = await owner<{ id: string; due_at: Date }[]>`select id,due_at from notification_outbox where payload->>'resource_id' = ${conversation.id} order by created_at,id`;
      expect(jobs).toHaveLength(2);
      const job = jobs[0]!;
      const now = new Date(Math.max(...jobs.map(row => row.due_at.getTime())) + 60_000);
      const authorization = createMessageNoticeAuthorization(runtime);
      let release!: () => void;
      const held = new Promise<void>(resolve => { release = resolve; });
      let entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      let checks = 0;
      let blockCommitted = false;
      const invocationOrder: boolean[] = [];
      const notify = createNotify({ repository: createPostgresRepository(runtime), audit: { emit: () => Promise.resolve() },
        authorization: { canNotify: async (identity, target, purpose, resource) => {
          const allowed = purpose === 'message' && !!resource && await authorization(identity, target, resource);
          if (++checks === 4) { entered(); await held; }
          return allowed;
        }, canDisclose: () => Promise.resolve(false) },
        flags: { enabled: () => Promise.resolve(false) }, queue: { enqueue: () => Promise.resolve() },
        adapter: { send: () => { invocationOrder.push(blockCommitted); return Promise.resolve({ outcome: 'confirmed', synthetic: true }); } },
        renderer: { body: () => Promise.resolve('Generic notification'), destination: () => Promise.resolve('synthetic@example.invalid') }, clock: () => now });
      const delivering = notify.send(recipient, job.id);
      await Promise.race([ready, delivering.then(() => { throw new Error('Delivery never reached final authorization barrier'); })]);
      // Exercise the trigger directly as a nonowner writer, not only service.block.
      const blocking = withOrg(runtime, org, async sql => {
        await sql`select set_config('app.current_user_id', ${pair[0]!}, true)`;
        await sql`insert into blocks(org_id,blocker_id,blocked_id) values(${org},${pair[0]!},${pair[1]!})`;
      }).then(() => { blockCommitted = true; });
      let lockWaitObserved = false;
      let committedAtBarrier: boolean;
      let invokedAtBarrier: boolean;
      try {
        // Observe the database wait itself; an arbitrary sleep could pass before
        // the competing INSERT even reached its trigger.
        for (let probe = 0; probe < 100 && !lockWaitObserved; probe++) {
          const waits = await owner`select pid from pg_stat_activity where usename = ${role}
            and wait_event = 'advisory' and query like '%insert into blocks%'`;
          lockWaitObserved = waits.length > 0;
        }
        committedAtBarrier = blockCommitted;
        invokedAtBarrier = invocationOrder.length > 0;
      } finally { release(); await Promise.all([delivering, blocking]); }
      expect(lockWaitObserved).toBe(true);
      expect(committedAtBarrier).toBe(false);
      expect(invokedAtBarrier).toBe(false);
      expect(await delivering).toMatchObject({ status: 'delivered' });
      expect(invocationOrder).toEqual([false]);
      expect(blockCommitted).toBe(true);
      expect(await authorization(sender, recipient.userId, conversation.id)).toBe(false);
      // A second notice queued before the block must never invoke the adapter
      // once the block has committed (exercise the opposite linearization).
      expect(await notify.send(recipient, jobs[1]!.id)).toMatchObject({ status: 'suppressed' });
      expect(invocationOrder).toEqual([false]);
    });
  }

  for (const operation of ['send', 'report'] as const) {
    it(`${operation}: v5 exact-content concurrent claims and replay require current authorization`, async () => {
      async function fixture() {
        const actor = { orgId: org, userId: randomUUID() };
        const peer = { orgId: org, userId: randomUUID() };
        for (const identity of [actor, peer]) await owner`insert into users(id,org_id,display_name) values(${identity.userId},${org},'Idempotency resident')`;
        const preferences = { mode: 'standard', locale: 'en', channels: { message: { email: true } }, quiet_hours: {}, no_outbound: false, shared_device: false };
        await owner`insert into notification_preferences(org_id,user_id,preferences) values(${org},${peer.userId},${JSON.stringify(preferences)}::text::jsonb)`;
        const conversation = await service.create(actor, peer.userId);
        return { actor, peer, id: conversation.id };
      }
      const route = (caller: typeof alice, id: string, key: string | null, content: string) => {
        const headers = new Headers({ origin: 'http://localhost' });
        if (key !== null) headers.set('idempotency-key', key);
        return handler(operation, { identity: () => Promise.resolve(caller), run: work => work(service) })(
          new Request(`http://localhost/api/v1/conversations/${id}/${operation === 'send' ? 'messages' : 'report'}`, { method: 'POST', headers,
            body: JSON.stringify(operation === 'send' ? { body: content } : { reason: 'Please review', note: content }) }),
          { params: Promise.resolve({ conversationId: id }) });
      };
      const same = await fixture();
      const key = `${operation}.v5~same_key-1`;
      for (const malformed of [null, '', 'old:colon']) expect((await route(same.actor, same.id, malformed, 'Exact A')).status).toBe(422);
      // Two simultaneous exact claims return the same native resource, not two
      // messages, human-review records, or notice sets.
      const sameResponses = await Promise.all([route(same.actor, same.id, key, 'Exact A'), route(same.actor, same.id, key, 'Exact A')]);
      expect(sameResponses.map(response => response.status)).toEqual([201, 201]);
      const original: unknown = await sameResponses[0].json();
      expect(await sameResponses[1].json()).toEqual(original);
      const replay = await route(same.actor, same.id, key, 'Exact A');
      expect(replay.status).toBe(201); expect(await replay.json()).toEqual(original);
      expect((await route(same.actor, same.id, key, 'Exact B')).status).toBe(409);
      const rows = operation === 'send'
        ? await owner`select id from messaging_messages where conversation_id = ${same.id}`
        : await owner`select id from messaging_reports where conversation_id = ${same.id}`;
      expect(rows).toHaveLength(1);
      const notices = await owner`select id from notification_outbox where payload->>'resource_id' = ${same.id}`;
      expect(notices).toHaveLength(operation === 'send' ? 1 : 0);
      const nonparticipant = await route(eve, same.id, key, 'Exact A');
      expect(nonparticipant.status).toBe(404);
      expect(await nonparticipant.json()).toEqual({ type: 'about:blank', title: 'Not found', status: 404 });
      await service.block(same.peer, same.actor.userId);
      const blocked = await route(same.actor, same.id, key, 'Exact A');
      expect(blocked.status).toBe(404);
      expect(await blocked.json()).toEqual({ type: 'about:blank', title: 'Not found', status: 404 });

      const conflict = await fixture();
      const contents = ['Concurrent A', 'Concurrent B'];
      const conflicting = await Promise.all(contents.map(content => route(conflict.actor, conflict.id, 'v5.different~content', content)));
      expect(conflicting.filter(response => response.status === 201)).toHaveLength(1);
      expect(conflicting.filter(response => response.status === 409)).toHaveLength(1);
      const winner = conflicting.findIndex(response => response.status === 201);
      const winnerResult: unknown = await conflicting[winner]!.json();
      const winnerReplay = await route(conflict.actor, conflict.id, 'v5.different~content', contents[winner]!);
      expect(winnerReplay.status).toBe(201); expect(await winnerReplay.json()).toEqual(winnerResult);
      const persisted = operation === 'send'
        ? await owner<{ content: string }[]>`select body as content from messaging_messages where conversation_id = ${conflict.id}`
        : await owner<{ content: string }[]>`select note as content from messaging_reports where conversation_id = ${conflict.id}`;
      expect(persisted).toEqual([{ content: contents[winner] }]);
      expect(await owner`select id from notification_outbox where payload->>'resource_id' = ${conflict.id}`).toHaveLength(operation === 'send' ? 1 : 0);
    });
  }
});
