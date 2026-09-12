import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { assistanceOpenedEvent, assistanceSlaTickJob, assistanceStates } from '../../../packages/assistance/src/index.ts';
import { createAssistanceHandlers, createSessionAuthenticator } from '../../../apps/web/app/api/v1/assistance-requests/_route.ts';

describe('WP-002 assistance surface', () => {
  it('uses the immutable five-state vocabulary', () => {
    expect(assistanceStates).toEqual(['pending_unowned', 'owned', 'in_progress', 'resolved', 'closed_unable']);
  });
  it('uses the immutable assistance event and job names', () => {
    expect(assistanceOpenedEvent).toBe('assistance.opened');
    expect(assistanceSlaTickJob).toBe('assistance.sla.tick');
  });
  it('derives identity only from a WP-004 session cookie', async () => {
    const authenticate = createSessionAuthenticator((orgId, token) => Promise.resolve(token === 'valid' ? { orgId, userId: '22222222-2222-4222-8222-222222222222', roles: ['senior'] } : null), '11111111-1111-4111-8111-111111111111');
    expect(await authenticate(new Request('http://local', { headers: { 'x-user-id': 'attacker', 'x-role': 'admin' } }))).toBeNull();
    expect((await authenticate(new Request('http://local', { headers: { cookie: 'ss_session=valid' } })))?.roles).toEqual(['senior']);
  });
  it('serializes a new request in the contract shape', async () => {
    const handlers = createAssistanceHandlers({ authenticate: () => Promise.resolve({ orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', roles: ['senior'] }),
      service: { create: () => Promise.resolve({ id: '44444444-4444-4444-8444-444444444444', orgId: '11111111-1111-4111-8111-111111111111', requesterId: '22222222-2222-4222-8222-222222222222', summary: 'help', locale: 'en', triageCategory: 'general', triageSource: 'rules', state: 'pending_unowned', ownerId: null, afterHours: true, slaDueAt: new Date('2026-09-14T13:00:00Z'), slaBreachedAt: null, createdAt: new Date('2026-09-14T12:00:00Z') }), listMine: () => Promise.resolve([]), get: () => Promise.reject(new Error()), queue: () => Promise.resolve([]), transition: () => Promise.reject(new Error()) } });
    const response = await handlers.POST(new Request('http://local/api/v1/assistance-requests', { method: 'POST', headers: { 'content-type': 'application/json', 'idempotency-key': 'contract-key' }, body: JSON.stringify({ summary: 'help' }) }));
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ state: 'pending_unowned', owner_id: null, after_hours: true, triage_source: 'rules' });
  });
  it('does not add an undocumented required idempotency header to the locked create contract', async () => {
    let receivedKey = '';
    const handlers = createAssistanceHandlers({ authenticate: () => Promise.resolve({ orgId: '11111111-1111-4111-8111-111111111111', userId: '22222222-2222-4222-8222-222222222222', roles: ['senior'] }),
      service: { create: (_identity, input) => { receivedKey = input.idempotencyKey; return Promise.resolve({ id: '44444444-4444-4444-8444-444444444444', orgId: '11111111-1111-4111-8111-111111111111', requesterId: '22222222-2222-4222-8222-222222222222', summary: 'help', locale: 'en', triageCategory: 'general', triageSource: 'rules', state: 'pending_unowned', ownerId: null, afterHours: false, slaDueAt: new Date('2026-09-14T13:00:00Z'), slaBreachedAt: null, createdAt: new Date('2026-09-14T12:00:00Z') }); }, listMine: () => Promise.resolve([]), get: () => Promise.reject(new Error()), queue: () => Promise.resolve([]), transition: () => Promise.reject(new Error()) } });
    const response = await handlers.POST(new Request('http://local/api/v1/assistance-requests', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ summary: 'help' }) }));
    expect(response.status).toBe(201);
    expect(receivedKey).toMatch(/^[0-9a-f-]{36}$/iu);
  });
  it('ships tenant RLS, append-only transitions, owner authorization and exact SLA enforcement', async () => {
    const migration = await readFile(
      new URL('../../../packages/db/migrations/0080_wp-014_assistance.sql', import.meta.url),
      'utf8',
    );
    expect(migration).toContain("ARRAY['assistance_requests', 'assistance_transitions', 'sla_clocks']");
    expect(migration).toContain('FORCE ROW LEVEL SECURITY');
    expect(migration).toContain('assistance_transitions_immutable');
    expect(migration).toContain('assistance_transition_one_initial');
    expect(migration).toContain('assistance_transition_one_departure');
    expect(migration).toContain('assistance owner must be staff or admin');
    expect(migration).toContain('invalid deterministic assistance SLA clock');
    expect(migration).toContain("breached_at IS NULL OR breached_at >= due_at");
  });

  it('implements the locked staff queue route without a query-parameter alias', async () => {
    const staffRoute = await readFile(
      new URL('../../../apps/web/app/api/v1/staff/assistance-requests/route.ts', import.meta.url),
      'utf8',
    );
    const residentHandlers = await readFile(
      new URL('../../../apps/web/app/api/v1/assistance-requests/_route.ts', import.meta.url),
      'utf8',
    );
    expect(staffRoute).toContain('handlers.STAFF_QUEUE(request)');
    expect(residentHandlers).not.toContain("searchParams.get('queue')");
  });
});
