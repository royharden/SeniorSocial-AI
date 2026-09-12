import { describe, expect, it, vi } from 'vitest';
import { createListAiEventsHandler } from '../../../apps/web/app/api/v1/admin/ai-events/route.ts';
import { createListAuditEventsHandler } from '../../../apps/web/app/api/v1/admin/audit-events/route.ts';
import { createListFlagsHandler, GET as failClosedFlags } from '../../../apps/web/app/api/v1/admin/flags/route.ts';
import { createSetFlagHandler, routeFlagKeys } from '../../../apps/web/app/api/v1/admin/flags/[flagKey]/route.ts';
import { flagKeys } from '../../../packages/flags/src/index.ts';

const orgId = '11111111-1111-4111-8111-111111111111';
const userId = '11111111-1111-4111-8111-111111111101';

describe('WP-006 locked admin route behavior', () => {
  it('keeps route validation synchronized with the closed package vocabulary', () => expect(routeFlagKeys).toEqual(flagKeys));
  it('exports fail-closed handlers until the authentication composition root injects context', async () => {
    expect((await failClosedFlags(new Request('http://local/admin/flags'))).status).toBe(403);
  });

  it('lists flags in the locked FlagPage shape using only injected org context', async () => {
    const list = vi.fn(async () => ({ items: [{ key: 'ai.master' as const, enabled: false, scope: 'global' as const, updated_by: userId }] }));
    const handler = createListFlagsHandler({ authorize: async () => ({ orgId, userId, roles: ['admin'] }), flags: { list } });
    const response = await handler(new Request('http://local/admin/flags', { headers: { 'x-org-id': '22222222-2222-4222-8222-222222222222' } }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ key: 'ai.master', enabled: false, scope: 'global', updated_by: userId }] });
    expect(list).toHaveBeenCalledWith(orgId);
  });

  it('requires a reason and passes explicit mutation scope and actor', async () => {
    const set = vi.fn(async () => ({ key: 'ai.master' as const, enabled: false, scope: 'global' as const, updated_by: userId }));
    const handler = createSetFlagHandler({ authorize: async () => ({ orgId, userId, roles: ['admin'], flagScope: 'global', requestId: 'req-1' }), flags: { set } });
    const missing = await handler(new Request('http://local/admin/flags/ai.master', { method: 'PATCH', body: JSON.stringify({ enabled: false }) }), { params: Promise.resolve({ flagKey: 'ai.master' }) });
    expect(missing.status).toBe(400);
    const response = await handler(new Request('http://local/admin/flags/ai.master', { method: 'PATCH', body: JSON.stringify({ enabled: false, reason: 'incident response' }) }), { params: Promise.resolve({ flagKey: 'ai.master' }) });
    expect(response.status).toBe(200);
    expect(set).toHaveBeenCalledWith('ai.master', false, 'incident response', { orgId, actorId: userId, scope: 'global', requestId: 'req-1' });
  });

  it('passes locked audit and AI filters without accepting an org query/header override', async () => {
    const auditList = vi.fn(async () => ({ items: [], meta: { next_cursor: null, total_known: true } }));
    const aiList = vi.fn(async () => ({ items: [], meta: { next_cursor: null, total_known: true } }));
    const authorize = async () => ({ orgId, roles: ['admin'] });
    await createListAuditEventsHandler({ authorize, audit: { list: auditList } })(new Request('http://local/admin/audit-events?action=flag.changed&limit=10&org_id=evil'));
    await createListAiEventsHandler({ authorize, events: { list: aiList } })(new Request('http://local/admin/ai-events?feature=concierge&limit=5'));
    expect(auditList).toHaveBeenCalledWith(orgId, { action: 'flag.changed', limit: 10 });
    expect(aiList).toHaveBeenCalledWith(orgId, { feature: 'concierge', limit: 5 });
  });

  it('bounds audit filters before storage and rejects duplicate known parameters', async () => {
    const list = vi.fn(async () => ({ items: [], meta: { next_cursor: null, total_known: true } }));
    const handler = createListAuditEventsHandler({
      authorize: async () => ({ orgId, roles: ['admin'] }),
      audit: { list },
    });
    const malformed = [
      'action=not.real',
      'target=missing-kind',
      'cursor=not-a-cursor',
      'limit=0',
      'limit=101',
      'limit=1.5',
      'action=flag.changed&action=assistance.owned',
    ];
    for (const query of malformed) {
      const response = await handler(new Request(`http://local/admin/audit-events?${query}`));
      expect(response.status, query).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }
    expect(list).not.toHaveBeenCalled();
  });

  it('requires an injected admin and maps unavailable identity or storage to non-disclosing responses', async () => {
    const list = vi.fn(async () => { throw new Error('postgres detail must not escape'); });
    const nonAdmin = createListAuditEventsHandler({
      authorize: async () => ({ orgId, roles: ['staff'] }), audit: { list },
    });
    const forbidden = await nonAdmin(new Request('http://local/admin/audit-events'));
    expect(forbidden.status).toBe(403);
    expect(list).not.toHaveBeenCalled();

    const unavailable = createListAuditEventsHandler({
      authorize: async () => ({ orgId, roles: ['admin'] }), audit: { list },
    });
    const failed = await unavailable(new Request('http://local/admin/audit-events?action=assistance.owned'));
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain('postgres detail');

    const authFailure = createListAuditEventsHandler({
      authorize: async () => { throw new Error('credential detail must not escape'); }, audit: { list },
    });
    const authFailed = await authFailure(new Request('http://local/admin/audit-events'));
    expect(authFailed.status).toBe(503);
    expect(await authFailed.text()).not.toContain('credential detail');
  });
});
