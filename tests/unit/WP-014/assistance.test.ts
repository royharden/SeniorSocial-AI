import { describe, expect, it } from 'vitest';
import {
  AssistanceService, FixedUtcBusinessHours, MemoryAssistanceRepository, ZonedBusinessHours,
  slaDueAt, triageByRules, type AiTriagePort, type Identity, type NarrativeCodec,
} from '../../../packages/assistance/src/index.ts';

const org = '11111111-1111-4111-8111-111111111111';
const resident = '22222222-2222-4222-8222-222222222222';
const staff = '33333333-3333-4333-8333-333333333333';
const requestId = '44444444-4444-4444-8444-444444444444';
const senior: Identity = { orgId: org, userId: resident, roles: ['senior'] };
const operator: Identity = { orgId: org, userId: staff, roles: ['staff'] };
const codec: NarrativeCodec = { seal: value => Promise.resolve(`sealed:${value}`), open: value => Promise.resolve(value.slice(7)) };
function setup(now = new Date('2026-09-14T19:00:00Z'), ai?: AiTriagePort) {
  const repository = new MemoryAssistanceRepository();
  const service = new AssistanceService({ repository, codec, ids: { next: () => requestId },
    hours: new FixedUtcBusinessHours(), now: () => now,
    authorization: { authorize: (identity, request) => Promise.resolve(identity.orgId === org && (request.operation !== 'manage' || identity.roles.includes('staff'))) },
    ...(ai ? { ai } : {}) });
  return { repository, service };
}

describe('native assistance rules', () => {
  it('triages deterministically and computes exact SLA boundaries', () => {
    expect(triageByRules('I smell fire and need a meal')).toBe('immediate_safety');
    expect(triageByRules('I need groceries')).toBe('food');
    expect(triageByRules('Necesito comida')).toBe('food');
    expect(triageByRules('Please help')).toBe('general');
    expect(slaDueAt(new Date('2026-09-14T12:00:00Z'), 'food').toISOString()).toBe('2026-09-14T13:00:00.000Z');
    const easternHours = new ZonedBusinessHours('America/New_York');
    expect(easternHours.isAfterHours(new Date('2026-09-14T12:00:00Z'))).toBe(false);
    expect(easternHours.isAfterHours(new Date('2026-09-14T22:00:00Z'))).toBe(true);
  });

  it('saves pending_unowned after hours with no callback-time field or promise', async () => {
    const { repository, service } = setup();
    const result = await service.create(senior, { summary: 'I need groceries', idempotencyKey: 'request-key-1' });
    expect(result).toMatchObject({ state: 'pending_unowned', ownerId: null, afterHours: true, triageCategory: 'food', triageSource: 'rules' });
    expect(repository.audits).toHaveLength(1);
    expect(repository.audits[0]?.action).toBe('assistance.opened');
    expect(JSON.stringify(result)).not.toMatch(/callback/i);
  });

  it('uses native triage when AI is killed and never gives AI the narrative', async () => {
    let received: unknown;
    const { service } = setup(undefined, { propose: input => { received = input; return Promise.resolve({ outcome: 'killed' }); } });
    const result = await service.create(senior, { summary: 'I need a ride to an appointment', idempotencyKey: 'request-key-2' });
    expect(result.triageCategory).toBe('transportation');
    expect(received).toEqual({ ruleCategory: 'transportation', locale: 'en' });
    expect(JSON.stringify(received)).not.toContain('appointment');
  });

  it('saves with native triage when the AI port times out', async () => {
    const repository = new MemoryAssistanceRepository();
    const service = new AssistanceService({ repository, codec, ids: { next: () => requestId }, hours: new FixedUtcBusinessHours(),
      aiTimeoutMs: 1, ai: { propose: () => new Promise(() => undefined) },
      authorization: { authorize: () => Promise.resolve(true) } });
    const result = await service.create(senior, { summary: 'housing help', idempotencyKey: 'timeout-key' });
    expect(result).toMatchObject({ state: 'pending_unowned', triageCategory: 'housing', triageSource: 'rules' });
    expect(repository.requests.size).toBe(1);
  });

  it('replays an idempotency key without a second request, audit, notification, or SLA job', async () => {
    const repository = new MemoryAssistanceRepository();
    const notifications: unknown[] = [];
    const jobs: unknown[] = [];
    const service = new AssistanceService({ repository, codec, ids: { next: () => requestId }, hours: new FixedUtcBusinessHours(),
      authorization: { authorize: () => Promise.resolve(true) },
      notifications: { queue: input => { notifications.push(input); return Promise.resolve(); } },
      jobs: { enqueue: (...input) => { jobs.push(input); return Promise.resolve(); } } });
    const first = await service.create(senior, { summary: 'help', idempotencyKey: 'replay-key' });
    const second = await service.create(senior, { summary: 'changed retry body', idempotencyKey: 'replay-key' });
    expect(second.id).toBe(first.id);
    expect(repository.requests.size).toBe(1);
    expect(repository.audits.filter(event => event.action === 'assistance.opened')).toHaveLength(1);
    expect(notifications).toHaveLength(1);
    expect(jobs).toHaveLength(1);
  });

  it('queues the exact staff event and SLA job payload at the due instant', async () => {
    const repository = new MemoryAssistanceRepository();
    let notification: unknown;
    let job: unknown;
    const service = new AssistanceService({ repository, codec, ids: { next: () => requestId }, hours: new FixedUtcBusinessHours(),
      now: () => new Date('2026-09-14T12:00:00Z'), authorization: { authorize: () => Promise.resolve(true) },
      notifications: { queue: input => { notification = input; return Promise.resolve(); } },
      jobs: { enqueue: (...input) => { job = input; return Promise.resolve(); } } });
    await service.create(senior, { summary: 'food needed', idempotencyKey: 'delivery-key' });
    expect(notification).toEqual({ idempotencyKey: `assistance:${requestId}:opened`, audience: 'staff', event: 'assistance.opened',
      payload: { request_id: requestId, org_id: org, requester_id: resident, triage_category: 'food', triage_source: 'rules', after_hours: false } });
    expect(job).toEqual(['assistance.sla.tick',
      { idempotency_key: `assistance:${requestId}:sla`, org_id: org, request_id: requestId },
      new Date('2026-09-14T13:00:00Z')]);
  });

  it('keeps the saved request pending when notification and job queueing fail', async () => {
    const repository = new MemoryAssistanceRepository();
    const service = new AssistanceService({ repository, codec, ids: { next: () => requestId }, hours: new FixedUtcBusinessHours(),
      authorization: { authorize: () => Promise.resolve(true) },
      notifications: { queue: () => { throw new Error('notification unavailable'); } },
      jobs: { enqueue: () => Promise.reject(new Error('job queue unavailable')) } });
    const result = await service.create(senior, { summary: 'food needed', idempotencyKey: 'notification-failure-key' });
    expect(result).toMatchObject({ state: 'pending_unowned', ownerId: null });
    expect(repository.requests.get(requestId)).toMatchObject({ state: 'pending_unowned', ownerId: null });
    expect(repository.audits.filter(event => event.action === 'assistance.opened')).toHaveLength(1);
  });

  it('requires authorized ownership and follows the closed state graph with audit events', async () => {
    const { repository, service } = setup();
    await service.create(senior, { summary: 'help', idempotencyKey: 'request-key-3' });
    await service.transition(operator, requestId, { to: 'owned', ownerId: staff, reason: 'accepted queue item' });
    await service.transition(operator, requestId, { to: 'in_progress' });
    await service.transition(operator, requestId, { to: 'resolved', reason: 'resident confirmed complete' });
    expect((await service.get(senior, requestId)).state).toBe('resolved');
    expect(repository.audits.map(event => event.action)).toEqual(['assistance.opened', 'assistance.owned', 'assistance.transitioned', 'assistance.transitioned']);
    await expect(service.transition(operator, requestId, { to: 'in_progress' })).rejects.toThrow('illegal_transition');
  });

  it('breaches before neither, and at the exact due instant once', async () => {
    let time = new Date('2026-09-14T12:00:00Z');
    const repository = new MemoryAssistanceRepository();
    const service = new AssistanceService({ repository, codec, ids: { next: () => requestId }, hours: new FixedUtcBusinessHours(), now: () => time,
      authorization: { authorize: () => Promise.resolve(true) } });
    await service.create(senior, { summary: 'food needed', idempotencyKey: 'request-key-4' });
    time = new Date('2026-09-14T12:59:59.999Z');
    expect((await service.recordSlaBoundary(org, requestId)).slaBreachedAt).toBeNull();
    time = new Date('2026-09-14T13:00:00.000Z');
    expect((await service.recordSlaBoundary(org, requestId)).slaBreachedAt?.toISOString()).toBe(time.toISOString());
    await service.recordSlaBoundary(org, requestId);
    expect(repository.audits.filter(event => event.action === 'assistance.sla_breached')).toHaveLength(1);
  });
});
