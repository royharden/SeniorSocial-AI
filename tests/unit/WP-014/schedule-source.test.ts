import { describe, expect, it, vi } from 'vitest';
import {
  AssistanceScheduleUnavailableError,
  createAssistanceScheduleSource,
  type AssistanceScheduleReadPort,
  type AssistanceRequest,
} from '../../../packages/assistance/src/index.ts';

const org = '11111111-1111-4111-8111-111111111111';
const resident = '22222222-2222-4222-8222-222222222222';
const otherOrg = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const otherResident = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const week = '2026-09-14';

function request(overrides: Partial<AssistanceRequest> = {}): AssistanceRequest {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    orgId: org,
    requesterId: resident,
    summary: 'Private narrative that must never be printed',
    locale: 'en',
    triageCategory: 'food',
    triageSource: 'ai',
    state: 'pending_unowned',
    ownerId: '33333333-3333-4333-8333-333333333333',
    afterHours: false,
    createdAt: new Date('2026-09-14T10:00:00.000Z'),
    slaDueAt: new Date('2026-09-14T11:00:00.000Z'),
    slaBreachedAt: null,
    ...overrides,
  };
}

function repository(rows: AssistanceRequest[], failure?: Error) {
  const listPending = vi.fn<AssistanceScheduleReadPort['listPending']>(() => failure ? Promise.reject(failure) : Promise.resolve(rows));
  return { port: { listPending }, listPending };
}

describe('WP-014 printable assistance source', () => {
  it('exports the exact D1 registration seam and scopes the repository lookup', async () => {
    const store = repository([request()]);
    const registration = createAssistanceScheduleSource(store.port, () => new Date('2026-09-15T12:30:45.000Z'));
    expect(registration.key).toBe('assistance');
    await registration.source.read({ orgId: org, userId: resident }, week);
    expect(store.listPending).toHaveBeenCalledWith(
      { orgId: org, userId: resident },
      new Date('2026-09-14T00:00:00.000Z'),
      new Date('2026-09-21T00:00:00.000Z'),
    );
  });

  it('rejects malformed identities, impossible dates, and non-Monday weeks before repository access', async () => {
    const store = repository([]);
    const source = createAssistanceScheduleSource(store.port).source;
    for (const [identity, weekOf] of [
      [{ orgId: 'not-a-uuid', userId: resident }, week],
      [{ orgId: org, userId: 'not-a-uuid' }, week],
      [{ orgId: org, userId: resident }, '2026-02-30'],
      [{ orgId: org, userId: resident }, '2026-09-15'],
    ] as const) {
      await expect(source.read(identity, weekOf)).rejects.toMatchObject({
        name: 'AssistanceScheduleUnavailableError', code: 'assistance_schedule_unavailable', message: 'assistance_schedule_unavailable',
      });
    }
    expect(store.listPending).not.toHaveBeenCalled();
  });

  it('includes overdue unresolved requests from earlier weeks and excludes requests at the next Monday boundary', async () => {
    const includedOverdue = request({ id: '44444444-4444-4444-8444-444444444446', createdAt: new Date('2026-09-06T22:00:00Z'), slaDueAt: new Date('2026-09-06T23:00:00Z') });
    const includedAtStart = request({ id: '44444444-4444-4444-8444-444444444440', createdAt: new Date('2026-09-13T23:00:00Z'), slaDueAt: new Date('2026-09-14T00:00:00Z') });
    const includedAtEnd = request({ id: '44444444-4444-4444-8444-444444444441', state: 'in_progress', createdAt: new Date('2026-09-20T23:59:59.999Z'), slaDueAt: new Date('2026-09-21T01:00:00Z'), slaBreachedAt: new Date('2026-09-21T01:00:00Z') });
    const rows = [
      request({ id: '44444444-4444-4444-8444-444444444442', state: 'resolved' }),
      request({ id: '44444444-4444-4444-8444-444444444443', orgId: otherOrg }),
      request({ id: '44444444-4444-4444-8444-444444444444', requesterId: otherResident }),
      request({ id: '44444444-4444-4444-8444-444444444445', createdAt: new Date('2026-09-21T00:00:00Z'), slaDueAt: new Date('2026-09-21T01:00:00Z') }),
      includedOverdue,
      includedAtEnd,
      includedAtStart,
    ];
    const snapshot = await createAssistanceScheduleSource(repository(rows).port, () => new Date('2026-09-15T12:30:45Z')).source.read({ orgId: org, userId: resident }, week);
    expect(snapshot.items).toEqual([
      { id: includedOverdue.id, kind: 'assistance', state: 'pending_unowned', triage_category: 'food', requested_at: '2026-09-06T22:00:00.000Z', sla_due_at: '2026-09-06T23:00:00.000Z' },
      { id: includedAtStart.id, kind: 'assistance', state: 'pending_unowned', triage_category: 'food', requested_at: '2026-09-13T23:00:00.000Z', sla_due_at: '2026-09-14T00:00:00.000Z' },
      { id: includedAtEnd.id, kind: 'assistance', state: 'in_progress', triage_category: 'food', requested_at: '2026-09-20T23:59:59.999Z', sla_due_at: '2026-09-21T01:00:00.000Z', sla_breached_at: '2026-09-21T01:00:00.000Z' },
    ]);
  });

  it('does not print narrative, ownership, acceptance, dispatch, provider, or AI claims', async () => {
    const snapshot = await createAssistanceScheduleSource(repository([request()]).port, () => new Date('2026-09-15T12:30:45Z')).source.read({ orgId: org, userId: resident }, week);
    const serialized = JSON.stringify(snapshot.items);
    expect(serialized).not.toContain('Private narrative');
    expect(serialized).not.toMatch(/summary|owner|accept|dispatch|provider|triage_source|\bai\b/iu);
    expect(snapshot.items[0]).toEqual({
      id: '44444444-4444-4444-8444-444444444444', kind: 'assistance', state: 'pending_unowned', triage_category: 'food',
      requested_at: '2026-09-14T10:00:00.000Z', sla_due_at: '2026-09-14T11:00:00.000Z',
    });
  });

  it('sorts deterministically and versions source truth independently of observation time', async () => {
    const later = request({ id: '44444444-4444-4444-8444-444444444445', createdAt: new Date('2026-09-15T10:00:00Z'), slaDueAt: new Date('2026-09-15T11:00:00Z') });
    const earlier = request();
    const first = await createAssistanceScheduleSource(repository([later, earlier]).port, () => new Date('2026-09-15T12:30:45Z')).source.read({ orgId: org, userId: resident }, week);
    const second = await createAssistanceScheduleSource(repository([earlier, later]).port, () => new Date('2026-09-16T08:00:00Z')).source.read({ orgId: org, userId: resident }, week);
    expect(first.items).toEqual(second.items);
    expect(first.source_version).toBe(second.source_version);
    expect(first.source_version).toMatch(/^assistance:v1:[0-9a-f]{64}$/u);
    expect(first.source_version.length).toBeLessThanOrEqual(200);
    expect(first.as_of).toBe('2026-09-15T12:30:45.000Z');
    expect(second.as_of).toBe('2026-09-16T08:00:00.000Z');
  });

  it('preserves expected typed outages and unexpected read-port failures by exact identity', async () => {
    const expected = new AssistanceScheduleUnavailableError();
    await expect(createAssistanceScheduleSource(repository([], expected).port).source
      .read({ orgId: org, userId: resident }, week)).rejects.toBe(expected);

    const unexpected = new Error('database driver programming failure');
    await expect(createAssistanceScheduleSource(repository([], unexpected).port).source
      .read({ orgId: org, userId: resident }, week)).rejects.toBe(unexpected);
  });

  it('propagates a clock failure by exact identity and does not classify invalid clock data as availability', async () => {
    const failure = new Error('clock dependency failed');
    const source = createAssistanceScheduleSource(repository([]).port, () => { throw failure; }).source;
    await expect(source.read({ orgId: org, userId: resident }, week)).rejects.toBe(failure);

    const invalid = createAssistanceScheduleSource(repository([]).port, () => new Date(Number.NaN)).source;
    await expect(invalid.read({ orgId: org, userId: resident }, week)).rejects.not.toBeInstanceOf(AssistanceScheduleUnavailableError);
    await expect(invalid.read({ orgId: org, userId: resident }, week)).rejects.toThrow('invalid assistance schedule clock');
  });

  it('changes its version when current state or breach facts change and removes terminal requests', async () => {
    const rows = [request()];
    const source = createAssistanceScheduleSource(repository(rows).port, () => new Date('2026-09-15T12:30:45Z')).source;
    const read = () => source.read({ orgId: org, userId: resident }, week);
    const pending = await read();
    rows[0] = request({ state: 'owned' });
    const owned = await read();
    expect(owned.items[0]?.state).toBe('owned');
    expect(owned.source_version).not.toBe(pending.source_version);
    rows[0] = request({ state: 'in_progress', slaBreachedAt: new Date('2026-09-14T11:00:00Z') });
    const breached = await read();
    expect(breached.source_version).not.toBe(owned.source_version);
    expect(breached.items[0]?.sla_breached_at).toBe('2026-09-14T11:00:00.000Z');
    rows[0] = request({ state: 'resolved' });
    const resolved = await read();
    expect(resolved.items).toEqual([]);
    expect(resolved.source_version).not.toBe(breached.source_version);
    rows[0] = request({ state: 'closed_unable' });
    expect(await read()).toEqual(resolved);
  });

  it('keeps concurrent resident reads independent and breaks equal-time ties deterministically', async () => {
    const earlierId = request({ id: '44444444-4444-4444-8444-444444444440' });
    const laterId = request({ id: '44444444-4444-4444-8444-444444444449' });
    const other = request({ requesterId: otherResident });
    const store = repository([laterId, other, earlierId]);
    const source = createAssistanceScheduleSource(store.port, () => new Date('2026-09-15T12:30:45Z')).source;
    const [first, second, repeated] = await Promise.all([
      source.read({ orgId: org, userId: resident }, week),
      source.read({ orgId: org, userId: otherResident }, week),
      source.read({ orgId: org, userId: resident }, week),
    ]);
    expect(first.items.map(item => item.id)).toEqual([earlierId.id, laterId.id]);
    expect(second.items.map(item => item.id)).toEqual([other.id]);
    expect(repeated).toEqual(first);
  });
});
