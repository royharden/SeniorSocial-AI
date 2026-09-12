import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createDatabaseClient, withOrg, type DatabaseClient } from '../../../packages/db/src/index.ts';
import { createNotify, createPostgresRepository, createSimulator, type AuditIntent } from '../../../packages/notify/src/index.ts';
import { identity, optedIn, orgId, otherOrg, otherUser, request, userId } from '../../unit/WP-009/fixture.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl || new URL(databaseUrl).pathname !== '/seniorsocial_wp009_test') {
  throw new Error('WP-009 integration requires dedicated seniorsocial_wp009_test DATABASE_URL');
}
const owner = createDatabaseClient(databaseUrl);
const role = 'seniorsocial_wp009_test_login';
let runtime: DatabaseClient;
const migration = (name: string) => readFile(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), 'utf8');

function fixture() {
  const repository = createPostgresRepository(runtime);
  const intents: AuditIntent[] = [];
  const adapter = { send: vi.fn((delivery: Parameters<ReturnType<typeof createSimulator>['send']>[0]) => createSimulator().send(delivery)) };
  const queue = { enqueue: vi.fn(() => Promise.resolve()) };
  const service = createNotify({ repository, adapter, queue,
    audit: { emit: async intent => {
      // Separate owner connection sees only committed data.
      const rows = await owner`select id from notification_audit_pending where intent = ${JSON.stringify(intent)}::text::jsonb`;
      expect(rows.length).toBeGreaterThan(0);
      intents.push(intent);
    } },
    authorization: { canNotify: (actor, recipient) => Promise.resolve(actor.orgId === orgId && actor.userId === recipient), canDisclose: () => Promise.resolve(false) },
    flags: { enabled: () => Promise.resolve(false) },
    renderer: { destination: () => Promise.resolve('synthetic@example.invalid'), body: () => Promise.resolve('synthetic notice') },
    clock: () => new Date('2026-09-10T16:00:00Z'),
  });
  return { repository, service, adapter, queue, intents };
}

describe('WP-009 real PostgreSQL outbox and isolation', () => {
  beforeAll(async () => {
    // what_bug_this_catches: migrations cannot apply to a blank WP-003 database or round-trip cleanly.
    // The exact dedicated database guard above confines the synthetic schema reset.
    await owner.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.unsafe(await migration('0001_wp-003_core_tables.sql'));
    await owner.unsafe(await migration('0040_wp-009_notify.sql'));
    await owner.unsafe(await migration('0040_wp-009_notify.down.sql'));
    await owner.unsafe(await migration('0040_wp-009_notify.sql'));
    await owner`insert into orgs (id, name, slug) values (${orgId}, 'Synthetic A', 'wp009-a'), (${otherOrg}, 'Synthetic B', 'wp009-b')`;
    await owner`insert into users (id, org_id, display_name) values (${userId}, ${orgId}, 'Synthetic one'), (${otherUser}, ${otherOrg}, 'Synthetic two')`;
    await owner.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await owner.unsafe(`CREATE ROLE ${role} LOGIN PASSWORD 'synthetic-test-only' IN ROLE seniorsocial_app`);
    const url = new URL(databaseUrl);
    url.username = role;
    url.password = 'synthetic-test-only';
    runtime = createDatabaseClient(url.toString());
  });
  afterAll(async () => {
    if (runtime) await runtime.end();
    await owner.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await owner.end();
  });

  // what_bug_this_catches: no-outbound creates durable jobs despite the enqueue API returning suppressed.
  it('persists preferences but creates zero outbound jobs for no-outbound', async () => {
    const f = fixture();
    await f.service.replace(identity, { ...optedIn(), no_outbound: true });
    expect(await f.service.enqueue(identity, request)).toEqual({ status: 'suppressed' });
    expect(await owner`select id from notification_outbox`).toHaveLength(0);
    expect(f.queue.enqueue).not.toHaveBeenCalled();
  });
  // what_bug_this_catches: replicas racing an idempotency key or send produce duplicate jobs/attempts.
  it('serializes racing enqueue/send and makes delivery visible only after adapter confirmation', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const results = await Promise.all(Array.from({ length: 6 }, () => f.service.enqueue(identity, request)));
    const ids = results.flatMap(result => 'id' in result ? [result.id] : []);
    expect(new Set(ids).size).toBe(1);
    const id = ids[0];
    if (!id) throw new Error('Expected id');
    let confirm = () => {};
    const confirmed = new Promise<void>(resolve => { confirm = resolve; });
    let started = () => {};
    const entered = new Promise<void>(resolve => { started = resolve; });
    f.adapter.send.mockImplementationOnce(async () => { started(); await confirmed; return { outcome: 'confirmed', synthetic: true }; });
    const delivery = f.service.send(identity, id);
    await entered;
    expect((await owner`select state from notification_outbox where id = ${id}`)[0]?.state).toBe('sending');
    await f.service.send(identity, id);
    confirm();
    expect(await delivery).toEqual({ status: 'delivered', synthetic: true });
    expect(f.adapter.send).toHaveBeenCalledTimes(1);
    expect(await owner`select * from notification_outbox`).toHaveLength(1);
    const attempts = await owner<{ outcome: string }[]>`select outcome from notification_attempts where job_id = ${id} order by at`;
    expect(attempts.map(a => a.outcome)).toEqual(['started', 'confirmed']);
    expect((await owner`select count(*)::integer as count from notification_audit_pending where not emitted`)[0]?.count).toBe(0);
  });
  // what_bug_this_catches: tenant GUC is missing, leaked from a pooled connection, or RLS grants cross-org access.
  it('isolates all four tables through non-owner RLS including unset scope', async () => {
    const tables = ['notification_preferences', 'notification_outbox', 'notification_attempts', 'notification_audit_pending'];
    for (const table of tables) {
      expect(await runtime.unsafe(`select * from ${table}`)).toHaveLength(0);
      const scoped = await withOrg(runtime, otherOrg, sql => sql.unsafe(`select * from ${table}`));
      expect(scoped).toHaveLength(0);
    }
    await expect(withOrg(runtime, otherOrg, sql => sql`insert into notification_preferences (org_id, user_id, preferences)
      values (${orgId}, ${userId}, '{}'::jsonb)`)).rejects.toThrow();
  });
  // what_bug_this_catches: repository accidentally uses a database owner whose bypass defeats RLS.
  it('refuses owner connections and cross-recipient repository reads', async () => {
    await expect(createPostgresRepository(owner).schedulable(identity)).rejects.toThrow('non-owner');
    const f = fixture();
    const rows = await owner<{ id: string }[]>`select id from notification_outbox limit 1`;
    const id = rows[0]?.id;
    if (!id) throw new Error('Expected job');
    expect(await f.repository.transaction({ orgId, userId: otherUser }, tx => tx.job(id))).toBeNull();
  });
  // what_bug_this_catches: application credentials can rewrite/delete audit attempt history or resurrect terminal delivery.
  it('forbids update/delete/truncate of attempts and constrains outbox identity/state', async () => {
    const rows = await owner<{ id: string }[]>`select id from notification_outbox limit 1`;
    const id = rows[0]?.id;
    if (!id) throw new Error('Expected job');
    await expect(withOrg(runtime, orgId, sql => sql`update notification_attempts set outcome = 'failed' where job_id = ${id}`)).rejects.toThrow();
    await expect(withOrg(runtime, orgId, sql => sql`delete from notification_attempts where job_id = ${id}`)).rejects.toThrow();
    await expect(withOrg(runtime, orgId, sql => sql`truncate notification_attempts`)).rejects.toThrow();
    await expect(withOrg(runtime, orgId, sql => sql`update notification_outbox set state = 'pending' where id = ${id}`)).rejects.toThrow();
    await expect(withOrg(runtime, orgId, sql => sql`update notification_outbox set payload = '{}'::jsonb where id = ${id}`)).rejects.toThrow();
    await expect(withOrg(runtime, orgId, sql => sql`update notification_audit_pending set intent = '{}'::jsonb`)).rejects.toThrow();
  });
  // what_bug_this_catches: quiet-hour deferral loses a job or migration constraints reject legitimate rescheduling.
  it('retains and reschedules quiet jobs without attempts', async () => {
    const f = fixture();
    await f.service.replace(identity, { ...optedIn(), quiet_hours: { start: '09:00', end: '17:00', timezone: 'UTC' } });
    const result = await f.service.enqueue(identity, { ...request, idempotencyKey: 'quiet' });
    if (!('id' in result)) throw new Error('Expected job');
    await f.service.send(identity, result.id);
    const rows = await owner`select state, due_at, attempts from notification_outbox where id = ${result.id}`;
    expect(rows[0]).toMatchObject({ state: 'pending', due_at: new Date('2026-09-10T17:00:00Z'), attempts: 0 });
    expect(f.adapter.send).not.toHaveBeenCalled();
  });
  // what_bug_this_catches: audit sink error loses its intent or emits before its corresponding mutation commits.
  it('keeps audit failure durable until a later after-commit flush', async () => {
    const f = fixture();
    const broken = createNotify({ repository: f.repository, audit: { emit: () => Promise.reject(new Error('sink down')) },
      authorization: { canNotify: () => Promise.resolve(true), canDisclose: () => Promise.resolve(false) },
      flags: { enabled: () => Promise.resolve(false) }, queue: f.queue, adapter: f.adapter,
      renderer: { body: () => Promise.resolve('synthetic'), destination: () => Promise.resolve('synthetic@example.invalid') }, clock: () => new Date() });
    await expect(broken.replace(identity, optedIn())).rejects.toThrow('sink down');
    expect((await f.repository.pendingAudits(identity)).length).toBeGreaterThan(0);
    await f.service.flushAudit(identity);
    expect(await f.repository.pendingAudits(identity)).toHaveLength(0);
  });
  // what_bug_this_catches: direct application SQL can claim delivery without a committed adapter result.
  it('requires confirmation evidence before committing delivered and rejects conflicting attempt results', async () => {
    const f = fixture();
    const result = await f.service.enqueue(identity, { ...request, idempotencyKey: 'evidence-required' });
    if (!('id' in result)) throw new Error('Expected job');
    await withOrg(runtime, orgId, sql => sql`update notification_outbox set state = 'sending', attempts = 1 where id = ${result.id}`);
    await expect(withOrg(runtime, orgId, sql => sql`update notification_outbox set state = 'delivered' where id = ${result.id}`)).rejects.toThrow('confirmation evidence');
    const delivered = await owner<{ id: string }[]>`select id from notification_outbox where state = 'delivered' limit 1`;
    const id = delivered[0]?.id;
    if (!id) throw new Error('Expected delivered row');
    await expect(withOrg(runtime, orgId, sql => sql`insert into notification_attempts (id, org_id, user_id, job_id, sequence, outcome, synthetic)
      values (uuid_generate_v4(), ${orgId}, ${userId}, ${id}, 1, 'failed', true)`)).rejects.toThrow();
  });
  // what_bug_this_catches: shared-phone replacement can commit during sensitive rendering and race the adapter.
  it('holds the recipient lock through sensitive rendering and adapter invocation, then releases before receipt', async () => {
    const f = fixture();
    await f.service.replace(identity, optedIn());
    const queued = await f.service.enqueue(identity, { ...request, idempotencyKey: 'locked-render' });
    if (!('id' in queued)) throw new Error('Expected job');
    let releaseDestination = () => {};
    const destinationGate = new Promise<void>(resolve => { releaseDestination = resolve; });
    let destinationStarted = () => {};
    const entered = new Promise<void>(resolve => { destinationStarted = resolve; });
    let releaseReceipt = () => {};
    const receiptGate = new Promise<void>(resolve => { releaseReceipt = resolve; });
    let adapterStarted = false;
    const service = createNotify({ repository: f.repository, audit: { emit: () => Promise.resolve() },
      authorization: { canNotify: () => Promise.resolve(true), canDisclose: () => Promise.resolve(false) },
      flags: { enabled: () => Promise.resolve(false) }, queue: f.queue,
      adapter: { send: async () => { adapterStarted = true; await receiptGate; return { outcome: 'confirmed', synthetic: true }; } },
      renderer: { destination: async () => { destinationStarted(); await destinationGate; return 'synthetic@example.invalid'; }, body: () => Promise.resolve('synthetic detail') },
      clock: () => new Date('2026-09-10T16:00:00Z') });
    const sending = service.send(identity, queued.id);
    await entered;
    let replaced = false;
    const replacement = f.service.replace(identity, { ...optedIn(), shared_device: true }).then(value => { replaced = true; return value; });
    let waiting = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      const rows = await owner<{ waiting: boolean }[]>`select exists(select 1 from pg_stat_activity where usename = ${role} and wait_event = 'advisory') as waiting`;
      if (rows[0]?.waiting) { waiting = true; break; }
      await owner`select pg_sleep(0.01)`;
    }
    expect(waiting).toBe(true);
    expect(replaced).toBe(false);
    expect(adapterStarted).toBe(false);
    releaseDestination();
    await replacement;
    expect(adapterStarted).toBe(true);
    releaseReceipt();
    expect(await sending).toMatchObject({ status: 'delivered' });
  });
});
