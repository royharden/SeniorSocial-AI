import { describe, expect, it } from 'vitest';
import { AssistanceScheduleUnavailableError, createPostgresAssistanceScheduleAdapter } from '../../../packages/assistance/src/index.ts';
import type { DatabaseClient, TenantTransaction } from '../../../packages/db/src/index.ts';

const orgA = '11111111-1111-4111-8111-111111111111';
const orgB = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const residentA = '22222222-2222-4222-8222-222222222222';
const residentB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

interface Row {
  id: string;
  org_id: string;
  requester_id: string;
  state: 'pending_unowned' | 'owned' | 'in_progress' | 'resolved' | 'closed_unable';
  triage_category: 'immediate_safety' | 'food' | 'housing' | 'transportation' | 'social_support' | 'general';
  created_at: string;
  sla_due_at: string;
  sla_breached_at: string | null;
}

function database(rows: readonly Row[], failure?: Error) {
  const queries: { text: string; values: readonly unknown[] }[] = [];
  const transaction = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    queries.push({ text, values });
    if (failure && text.includes('select r.id')) return Promise.reject(failure);
    return Promise.resolve(text.includes('select r.id') ? rows : []);
  }) as unknown as TenantTransaction;
  transaction.release = () => undefined;
  const client = { reserve: () => Promise.resolve(transaction) } as unknown as DatabaseClient;
  return { client, queries };
}

function row(id: string, overrides: Partial<Row> = {}): Row {
  return {
    id, org_id: orgA, requester_id: residentA, state: 'pending_unowned', triage_category: 'housing',
    created_at: '2026-09-16 10:00:00+00', sla_due_at: '2026-09-16 14:00:00+00', sla_breached_at: null,
    ...overrides,
  };
}

describe('WP-014 PostgreSQL assistance schedule adapter', () => {
  it('binds tenant context and filters by the exact resident, pending states, and UTC week in SQL', async () => {
    const db = database([row('44444444-4444-4444-8444-444444444444')]);
    await createPostgresAssistanceScheduleAdapter(db.client, () => new Date('2026-09-16T12:00:00Z'))
      .source.read({ orgId: orgA, userId: residentA }, '2026-09-14');

    expect(db.queries[0]?.text.trim()).toBe('begin');
    expect(db.queries[1]?.text).toContain("set_config('app.current_org_id'");
    expect(db.queries[1]?.values).toEqual([orgA]);
    const select = db.queries.find(query => query.text.includes('select r.id'))!;
    expect(select.text).toContain('where r.org_id = ? and r.requester_id = ?');
    expect(select.text).toContain("latest.to_state in ('pending_unowned', 'owned', 'in_progress')");
    expect(select.text).toContain('transition.org_id = r.org_id and transition.request_id = r.id');
    expect(select.text).toContain('order by transition.sequence desc limit 1');
    expect(select.text).toContain('clock.org_id = r.org_id and clock.request_id = r.id');
    expect(select.text).toContain('r.created_at < ?');
    expect(select.text).not.toMatch(/clock\.due_at\s*(?:>=|>)/u);
    expect(select.values).toEqual([orgA, residentA, new Date('2026-09-21T00:00:00.000Z')]);
    expect(db.queries.at(-1)?.text.trim()).toBe('commit');
  });

  it('selects and emits no narrative, ciphertext, owner, AI provenance, or promise field', async () => {
    const db = database([row('44444444-4444-4444-8444-444444444444')]);
    const snapshot = await createPostgresAssistanceScheduleAdapter(db.client, () => new Date('2026-09-16T12:00:00Z'))
      .source.read({ orgId: orgA, userId: residentA }, '2026-09-14');
    const select = db.queries.find(query => query.text.includes('select r.id'))!.text;
    expect(select).not.toMatch(/summary|ciphertext|owner|triage_source|locale/iu);
    expect(JSON.stringify(snapshot.items)).not.toMatch(/summary|ciphertext|owner|accept|dispatch|provider|triage_source|\bai\b/iu);
    expect(snapshot.items).toEqual([{
      id: '44444444-4444-4444-8444-444444444444', kind: 'assistance', state: 'pending_unowned', triage_category: 'housing',
      requested_at: '2026-09-16T10:00:00.000Z', sla_due_at: '2026-09-16T14:00:00.000Z',
    }]);
  });

  it('defensively drops cross-tenant, cross-resident, terminal, and out-of-week rows even if a driver misbehaves', async () => {
    const visible = row('44444444-4444-4444-8444-444444444444');
    const db = database([
      row('55555555-5555-4555-8555-555555555555', { org_id: orgB }),
      row('66666666-6666-4666-8666-666666666666', { requester_id: residentB }),
      row('77777777-7777-4777-8777-777777777777', { state: 'resolved' }),
      row('88888888-8888-4888-8888-888888888888', { created_at: '2026-09-21 00:00:00+00', sla_due_at: '2026-09-21 01:00:00+00' }),
      visible,
    ]);
    const snapshot = await createPostgresAssistanceScheduleAdapter(db.client, () => new Date('2026-09-16T12:00:00Z'))
      .source.read({ orgId: orgA, userId: residentA }, '2026-09-14');
    expect(snapshot.items.map(item => item.id)).toEqual([visible.id]);
  });

  it('keeps an older overdue request visible while its latest state remains unresolved', async () => {
    const overdue = row('44444444-4444-4444-8444-444444444444', {
      state: 'in_progress', created_at: '2026-09-06 10:00:00+00', sla_due_at: '2026-09-06 11:00:00+00',
      sla_breached_at: '2026-09-06 11:00:00+00',
    });
    const db = database([overdue]);
    const snapshot = await createPostgresAssistanceScheduleAdapter(db.client, () => new Date('2026-09-16T12:00:00Z'))
      .source.read({ orgId: orgA, userId: residentA }, '2026-09-14');
    expect(snapshot.items).toEqual([{
      id: overdue.id, kind: 'assistance', state: 'in_progress', triage_category: 'housing',
      requested_at: '2026-09-06T10:00:00.000Z', sla_due_at: '2026-09-06T11:00:00.000Z',
      sla_breached_at: '2026-09-06T11:00:00.000Z',
    }]);
  });

  it('preserves typed outages and unexpected PostgreSQL failures by exact identity', async () => {
    const expected = new AssistanceScheduleUnavailableError();
    const expectedDb = database([], expected);
    await expect(createPostgresAssistanceScheduleAdapter(expectedDb.client).source
      .read({ orgId: orgA, userId: residentA }, '2026-09-14')).rejects.toBe(expected);
    expect(expectedDb.queries.at(-1)?.text.trim()).toBe('rollback');

    const unexpected = new Error('postgres driver failure');
    const unexpectedDb = database([], unexpected);
    await expect(createPostgresAssistanceScheduleAdapter(unexpectedDb.client).source
      .read({ orgId: orgA, userId: residentA }, '2026-09-14')).rejects.toBe(unexpected);
    expect(unexpectedDb.queries.at(-1)?.text.trim()).toBe('rollback');
  });

  it('surfaces malformed database timestamps as a programming/data error, not source unavailability', async () => {
    const db = database([row('44444444-4444-4444-8444-444444444444', { created_at: 'not-a-date' })]);
    const read = createPostgresAssistanceScheduleAdapter(db.client).source
      .read({ orgId: orgA, userId: residentA }, '2026-09-14');
    await expect(read).rejects.toBeInstanceOf(RangeError);
    await expect(read).rejects.not.toBeInstanceOf(AssistanceScheduleUnavailableError);
    await expect(read).rejects.toThrow('invalid assistance schedule row date');
  });

  it('propagates an unexpected row-mapping failure by exact identity', async () => {
    const failure = new Error('unexpected row mapping failure');
    const malformed = row('44444444-4444-4444-8444-444444444444');
    Object.defineProperty(malformed, 'created_at', { get: () => { throw failure; } });
    const db = database([malformed]);
    await expect(createPostgresAssistanceScheduleAdapter(db.client).source
      .read({ orgId: orgA, userId: residentA }, '2026-09-14')).rejects.toBe(failure);
    expect(db.queries.at(-1)?.text.trim()).toBe('rollback');
  });
});
