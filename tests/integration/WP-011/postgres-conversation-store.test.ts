import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ConciergeService } from '../../../apps/web/app/concierge/core.ts';
import { PostgresConversationStore } from '../../../apps/web/app/concierge/postgres.ts';
import type { ConciergeSession, DirectoryRecord } from '../../../apps/web/app/concierge/types.ts';
import { createDatabaseClient, type DatabaseClient } from '../../../packages/db/src/index.ts';

const databaseUrl = process.env.WP011_TEST_DATABASE_URL;
if (databaseUrl && process.env.WP011_TEST_DB_ALLOWED !== 'true') {
  throw new Error('WP-011 live tests require WP011_TEST_DB_ALLOWED=true for destructive dedicated-database setup');
}
const live = databaseUrl !== undefined && process.env.WP011_TEST_DB_ALLOWED === 'true';
const migration = (name: string) => readFile(new URL(`../../../packages/db/migrations/${name}`, import.meta.url), 'utf8');
const role = `seniorsocial_wp011_${process.pid}`;
const password = 'synthetic-wp011-only';
const orgA = randomUUID();
const orgB = randomUUID();
const residentA = randomUUID();
const residentA2 = randomUUID();
const residentB = randomUUID();
const conversationId = randomUUID();
const handoffKey = randomUUID();
const serviceA = randomUUID();
const serviceB = randomUUID();
const sessionA: ConciergeSession = { orgId: orgA, userId: residentA, role: 'senior', locale: 'en', requestId: 'wp011-live-a' };
const mealRecord: DirectoryRecord = { id: serviceA, orgId: orgA, name: 'Maple Meals' };
const rideRecord: DirectoryRecord = { id: serviceB, orgId: orgA, name: 'Harbor Rides' };
let owner: DatabaseClient;
let runtimeA: DatabaseClient;
let runtimeB: DatabaseClient;

function concierge(client: DatabaseClient, createAssistance: ReturnType<typeof assistanceMock>): ConciergeService {
  return new ConciergeService({
    conversations: new PostgresConversationStore(() => client),
    directory: { search: input => Promise.resolve([input.query.includes('ride') ? rideRecord : mealRecord]) },
    assistance: { create: createAssistance },
  });
}

function assistanceMock() {
  return vi.fn((input: { orgId: string; summary: string }) => Promise.resolve({
    id: randomUUID(), org_id: input.orgId, state: 'pending_unowned' as const, summary: input.summary,
  }));
}

/** Protocol double: verifies adapter behavior, not PostgreSQL locking or RLS semantics. */
function connectionDouble() {
  const row = {
    id: conversationId, org_id: orgA, user_id: residentA, handoff_key: handoffKey,
    turns: [{ text: 'original', citations: [], disclaimer: 'directory', human_route: '/assistance', prompt_version: 'v1' }],
    ai_enabled: true, last_question: '', handoff: null,
  };
  const calls: { text: string; values: unknown[] }[] = [];
  let failUpdate = false;
  const query = (parts: TemplateStringsArray, ...values: unknown[]) => {
    const text = parts.join('?').replace(/\s+/gu, ' ').trim();
    calls.push({ text, values });
    if (text.startsWith('select id,')) return Promise.resolve([row]);
    if (text.startsWith('update') && failUpdate) return Promise.reject(new Error('injected update failure'));
    return Promise.resolve([]);
  };
  const release = vi.fn();
  const sql = Object.assign(query, { json: (value: unknown) => value, release });
  const reserve = vi.fn(() => Promise.resolve(sql));
  const client = { reserve } as unknown as DatabaseClient;
  return { row, calls, release, reserve, client, failUpdates: () => { failUpdate = true; } };
}

describe('WP-011 PostgreSQL adapter protocol (no live database)', () => {
  it('requires trusted identity before reserving a connection', async () => {
    const db = connectionDouble();
    const store = new PostgresConversationStore(() => db.client);
    expect(await store.get(conversationId)).toBeNull();
    expect(await store.get("' OR true --", orgA, residentA)).toBeNull();
    await expect(store.create({ id: conversationId, orgId: orgA, userId: residentA, handoffKey, turns: [], aiEnabled: true, lastQuestion: '' })).rejects.toThrow('trusted concierge identity');
    expect(db.reserve).not.toHaveBeenCalled();
  });

  it('binds identity on one reserved transaction and returns isolated clones across stores', async () => {
    const db = connectionDouble();
    const first = new PostgresConversationStore(() => db.client);
    const second = new PostgresConversationStore(() => db.client);
    const loaded = (await first.get(conversationId, orgA, residentA))!;
    loaded.turns[0] = { ...loaded.turns[0]!, text: 'caller mutation' };
    expect((await second.get(conversationId, orgA, residentA))?.turns[0]?.text).toBe('original');
    expect(db.calls.map(call => call.text)).toContain("select set_config('app.current_org_id', ?, true)");
    expect(db.calls.find(call => call.text.includes('app.current_org_id'))?.values).toEqual([orgA]);
    expect(db.calls.find(call => call.text.includes('app.current_user_id'))?.values).toEqual([residentA]);
    expect(db.calls.filter(call => call.text === 'commit')).toHaveLength(2);
    expect(db.release).toHaveBeenCalledTimes(2);
  });

  it('sends only each observed snapshot delta and leaves handoff outside answer updates', async () => {
    const db = connectionDouble();
    const store = new PostgresConversationStore(() => db.client);
    const left = (await store.get(conversationId, orgA, residentA))!;
    const right = (await store.get(conversationId, orgA, residentA))!;
    const answerA = { ...left.turns[0]!, text: "resident's answer; --" };
    const answerB = { ...right.turns[0]!, text: 'second answer' };
    left.turns.push(answerA);
    right.turns.push(answerB);
    await Promise.all([store.save(left, orgA, residentA), store.save(right, orgA, residentA)]);
    const updates = db.calls.filter(call => call.text.startsWith('update'));
    expect(updates.map(call => call.values[0])).toEqual([[answerA], [answerB]]);
    expect(updates.every(call => !call.text.includes('handoff =') && !call.text.includes(answerA.text))).toBe(true);
    left.turns.push(answerB);
    await store.save(left, orgA, residentA);
    expect(db.calls.filter(call => call.text.startsWith('update')).at(-1)?.values[0]).toEqual([answerB]);
  });

  it('rolls back and releases a failed append without consuming its delta', async () => {
    const db = connectionDouble();
    const store = new PostgresConversationStore(() => db.client);
    const loaded = (await store.get(conversationId, orgA, residentA))!;
    loaded.turns.push({ ...loaded.turns[0]!, text: 'new turn' });
    db.failUpdates();
    await expect(store.save(loaded, orgA, residentA)).rejects.toThrow('injected update failure');
    await expect(store.save(loaded, orgA, residentA)).rejects.toThrow('injected update failure');
    expect(db.calls.filter(call => call.text.startsWith('update')).map(call => call.values[0])).toEqual([[loaded.turns[1]], [loaded.turns[1]]]);
    expect(db.calls.filter(call => call.text === 'rollback')).toHaveLength(2);
    expect(db.release).toHaveBeenCalledTimes(3);
  });

  it('rolls back a failed or foreign handoff and does not persist its result', async () => {
    const db = connectionDouble();
    const store = new PostgresConversationStore(() => db.client);
    await expect(store.getOrCreateHandoff(conversationId, orgA, residentA, () => Promise.reject(new Error('assistance unavailable')))).rejects.toThrow('assistance unavailable');
    await expect(store.getOrCreateHandoff(conversationId, orgA, residentA, () => Promise.resolve({ id: randomUUID(), org_id: orgB, state: 'pending_unowned', summary: '' }))).rejects.toThrow('cross-tenant');
    expect(db.calls.some(call => call.text.startsWith('update'))).toBe(false);
    expect(db.calls.filter(call => call.text === 'rollback')).toHaveLength(2);
    expect(db.release).toHaveBeenCalledTimes(2);
  });
});

describe.skipIf(!live)('WP-011 live PostgreSQL conversation continuity', () => {
  beforeAll(async () => {
    owner = createDatabaseClient(databaseUrl);
    await owner.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
    await owner.unsafe(await migration('0001_wp-003_core_tables.sql'));
    const up = await migration('0190_wp-011_concierge_conversations.sql');
    const down = await migration('0190_wp-011_concierge_conversations.down.sql');
    await owner.unsafe(up);
    await owner.unsafe(down);
    expect((await owner<{ table_name: string | null }[]>`select to_regclass('public.concierge_conversations')::text as table_name`)[0]?.table_name).toBeNull();
    await owner.unsafe(up);
    await owner`insert into orgs (id, name, slug) values (${orgA}, 'WP-011 A', ${`wp011-a-${process.pid}`}), (${orgB}, 'WP-011 B', ${`wp011-b-${process.pid}`})`;
    await owner`insert into users (id, org_id, display_name) values
      (${residentA}, ${orgA}, 'Resident A'), (${residentA2}, ${orgA}, 'Resident A2'), (${residentB}, ${orgB}, 'Resident B')`;
    await owner.unsafe(`drop role if exists ${role}; create role ${role} login password '${password}' in role seniorsocial_app`);
    const runtimeUrl = new URL(databaseUrl!);
    runtimeUrl.username = role;
    runtimeUrl.password = password;
    runtimeA = createDatabaseClient(runtimeUrl.toString());
    runtimeB = createDatabaseClient(runtimeUrl.toString());
  }, 60_000);

  afterAll(async () => {
    if (runtimeA) await runtimeA.end();
    if (runtimeB) await runtimeB.end();
    if (owner) {
      await owner.unsafe('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
      await owner.unsafe(`drop role if exists ${role}`);
      await owner.end();
    }
  }, 30_000);

  it('survives fresh service/store/client instances and conceals foreign org and user lookups', async () => {
    const roleState = (await runtimeA<{ unsafe: boolean }[]>`
      select r.rolsuper or r.rolbypassrls or c.relowner = r.oid as unsafe
      from pg_roles r cross join pg_class c
      where r.rolname = current_user and c.relname = 'concierge_conversations'
    `)[0];
    expect(roleState).toEqual({ unsafe: false });
    const createAssistance = assistanceMock();
    const first = new ConciergeService({
      conversations: new PostgresConversationStore(() => runtimeA),
      directory: { search: () => Promise.resolve([mealRecord]) }, assistance: { create: createAssistance },
      createId: vi.fn().mockReturnValueOnce(conversationId).mockReturnValueOnce(handoffKey),
    });
    await first.start(sessionA);
    const foreign = new ConciergeService({
      conversations: new PostgresConversationStore(() => runtimeB),
      directory: { search: () => Promise.resolve([]) }, assistance: { create: createAssistance },
      createId: vi.fn().mockReturnValueOnce(conversationId).mockReturnValueOnce(randomUUID()),
    });
    await foreign.start({ ...sessionA, orgId: orgB, userId: residentB });
    const fresh = concierge(runtimeB, createAssistance);
    expect((await fresh.get(sessionA, conversationId))?.id).toBe(conversationId);
    expect(await fresh.get({ ...sessionA, orgId: orgB }, conversationId)).toBeNull();
    expect((await fresh.get({ ...sessionA, orgId: orgB, userId: residentB }, conversationId))?.turns).toEqual([]);
    expect(await fresh.get({ ...sessionA, userId: residentA2 }, conversationId)).toBeNull();
  });

  it('does not lose concurrent answer turns or erase a persisted handoff', async () => {
    const createAssistance = assistanceMock();
    const first = concierge(runtimeA, createAssistance);
    const second = concierge(runtimeB, createAssistance);
    const [meal, ride] = await Promise.all([
      first.answer(sessionA, conversationId, 'meal delivery', 'en'),
      second.answer(sessionA, conversationId, 'ride service', 'en'),
    ]);
    expect(meal?.citations).toEqual([serviceA]);
    expect(ride?.citations).toEqual([serviceB]);
    const handoff = await first.handoff(sessionA, conversationId);
    await second.answer(sessionA, conversationId, 'another ride service', 'en');
    expect((await first.get(sessionA, conversationId))?.turns).toHaveLength(3);
    expect((await second.handoff(sessionA, conversationId))?.id).toBe(handoff?.id);
  });

  it('enforces resident RLS on unfiltered SQL and denies deletion and identity mutation', async () => {
    // what_bug_this_catches: adapter WHERE clauses alone can conceal a broken database boundary.
    expect(await runtimeA`select id from concierge_conversations`).toHaveLength(0);
    const sql = await runtimeA.reserve();
    try {
      await sql`begin`;
      await sql`select set_config('app.current_org_id', ${orgA}, true), set_config('app.current_user_id', ${residentA2}, true)`;
      expect(await sql`select id from concierge_conversations`).toHaveLength(0);
      await sql`select set_config('app.current_user_id', ${residentA}, true)`;
      expect(await sql`select id from concierge_conversations`).toEqual([{ id: conversationId }]);
      await expect(sql`delete from concierge_conversations where id = ${conversationId}`).rejects.toThrow(/permission denied/iu);
    } finally {
      await sql`rollback`;
      sql.release();
    }
    const mutation = await runtimeA.reserve();
    try {
      await mutation`begin`;
      await mutation`select set_config('app.current_org_id', ${orgA}, true), set_config('app.current_user_id', ${residentA}, true)`;
      await expect(mutation`update concierge_conversations set user_id = ${residentA2} where id = ${conversationId}`).rejects.toThrow(/permission denied/iu);
    } finally {
      await mutation`rollback`;
      mutation.release();
    }
    expect(await runtimeA`select id from concierge_conversations`).toHaveLength(0);
  });

  it('preserves both results when a cross-instance answer and handoff overlap', async () => {
    const createAssistance = assistanceMock();
    const id = randomUUID();
    let releaseSearch!: () => void;
    let markSearchStarted!: () => void;
    const searchStarted = new Promise<void>(resolve => { markSearchStarted = resolve; });
    const first = new ConciergeService({
      conversations: new PostgresConversationStore(() => runtimeA),
      directory: { search: async () => {
        markSearchStarted();
        await new Promise<void>(resolve => { releaseSearch = resolve; });
        return [mealRecord];
      } },
      assistance: { create: createAssistance },
      createId: vi.fn().mockReturnValueOnce(id).mockReturnValueOnce(randomUUID()),
    });
    await first.start(sessionA);
    const second = concierge(runtimeB, createAssistance);
    const answer = first.answer(sessionA, id, 'meal delivery', 'en');
    await searchStarted;
    const handoff = await second.handoff(sessionA, id);
    releaseSearch();
    await answer;
    expect((await second.get(sessionA, id))?.turns).toHaveLength(1);
    expect((await first.handoff(sessionA, id))?.id).toBe(handoff?.id);
    expect(createAssistance).toHaveBeenCalledTimes(1);
  });

  it('serializes cross-replica handoff creation and returns the one persisted result', async () => {
    const createAssistance = assistanceMock();
    const first = concierge(runtimeA, createAssistance);
    const second = concierge(runtimeB, createAssistance);
    const [left, right] = await Promise.all([
      first.handoff(sessionA, conversationId),
      second.handoff(sessionA, conversationId),
    ]);
    expect(left).toEqual(right);
    expect(createAssistance).toHaveBeenCalledTimes(0);

    const newId = randomUUID();
    const seeded = new ConciergeService({
      conversations: new PostgresConversationStore(() => runtimeA),
      directory: { search: () => Promise.resolve([]) }, assistance: { create: createAssistance },
      createId: vi.fn().mockReturnValueOnce(newId).mockReturnValueOnce(randomUUID()),
    });
    await seeded.start(sessionA);
    const other = concierge(runtimeB, createAssistance);
    const [created, replayed] = await Promise.all([seeded.handoff(sessionA, newId), other.handoff(sessionA, newId)]);
    expect(created).toEqual(replayed);
    expect(createAssistance).toHaveBeenCalledTimes(1);
    const durable = await owner<{ handoff: { id: string } }[]>`
      select handoff from concierge_conversations where org_id = ${orgA} and id = ${newId}
    `;
    expect(durable[0]?.handoff.id).toBe(created?.id);
  });

  it('rejects reordered, duplicate-replaced and altered historical turns under the app role', async () => {
    // what_bug_this_catches: JSONB containment permits all three history rewrites.
    const store = new PostgresConversationStore(() => runtimeA);
    const id = randomUUID();
    const first = { text: 'first', citations: [], disclaimer: 'directory', human_route: '/assistance', prompt_version: 'v1' };
    const second = { ...first, text: 'second' };
    const original = [first, first, second];
    await store.create({ id, orgId: orgA, userId: residentA, handoffKey: randomUUID(), turns: original, aiEnabled: false, lastQuestion: '' }, orgA, residentA);
    for (const replacement of [[second, first, first], [first, second, second], [{ ...first, refused: true }, first, second]]) {
      const sql = await runtimeA.reserve();
      try {
        await sql`begin`;
        await sql`select set_config('app.current_org_id', ${orgA}, true), set_config('app.current_user_id', ${residentA}, true)`;
        await expect(sql`update concierge_conversations set turns = ${sql.json(replacement)}, revision = revision + 1
          where org_id = ${orgA} and id = ${id}`).rejects.toThrow('append-only continuity');
      } finally {
        await sql`rollback`;
        sql.release();
      }
    }
    expect((await store.get(id, orgA, residentA))?.turns).toEqual(original);
    const loaded = (await store.get(id, orgA, residentA))!;
    loaded.turns.push(second);
    await store.save(loaded, orgA, residentA);
    expect((await store.get(id, orgA, residentA))?.turns).toEqual([...original, second]);
  });
});
