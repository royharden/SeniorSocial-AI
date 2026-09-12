import { describe, expect, it } from 'vitest';
import { createSubmitIntakeHandler } from '../../../apps/web/app/api/v1/intake/_submit';
import { createIntakeSubmissionHandlers } from '../../../apps/web/app/api/v1/intake/[submissionId]/route';
import { fixture, resident } from '../../unit/WP-018/fixture';

function deps() { const f = fixture(); return { f, dependencies: { authorize: () => Promise.resolve(resident), intake: f.service } }; }
function request(path: string, body: unknown, key: string, method = 'POST') {
  return new Request(`http://local${path}`, { method, headers: { 'content-type': 'application/json', 'idempotency-key': key }, body: JSON.stringify(body) });
}

describe('WP-018 route contract', () => {
  it('POST save_draft returns a resumable draft without routing', async () => {
    const { dependencies } = deps(); const handler = createSubmitIntakeHandler('legal', dependencies);
    const response = await handler(request('/api/v1/intake/legal', { answers: {}, disclaimer_acknowledged: false,
      locale: 'en', intent: 'save_draft' }, 'route-key-0001'));
    expect(response.status).toBe(201);
    const value: unknown = await response.json();
    expect(value).toMatchObject({ kind: 'legal', state: 'draft', answers: {},
      disclaimer_acknowledged: false });
    expect(value).not.toHaveProperty('routed_to_partner_category');
  });

  it('legacy POST means submit and false acknowledgment fails closed', async () => {
    const { dependencies } = deps(); const handler = createSubmitIntakeHandler('health', dependencies);
    const response = await handler(request('/api/v1/intake/health', { answers: {}, disclaimer_acknowledged: false,
      locale: 'en' }, 'route-key-0002'));
    expect(response.status).toBe(422); expect((await response.json() as { title: string }).title).toBe('Invalid intake request');
  });

  it('GET resumes an owned draft and PATCH atomically submits replacement answers', async () => {
    const { f, dependencies } = deps(); const draft = await f.service.save(resident, 'legal', {
      answers: { topic: 'housing', removed_on_replace: 'yes' }, disclaimerAcknowledged: false, locale: 'en', intent: 'save_draft',
    }, 'route-key-0003');
    const handlers = createIntakeSubmissionHandlers(dependencies); const context = { params: Promise.resolve({ submissionId: draft.id }) };
    expect((await handlers.GET(new Request(`http://local/api/v1/intake/${draft.id}`), context)).status).toBe(200);
    const response = await handlers.PATCH(request(`/api/v1/intake/${draft.id}`, { answers: { topic: 'benefits' },
      disclaimer_acknowledged: true, locale: 'es', intent: 'submit' }, 'route-key-0004', 'PATCH'), context);
    const value = await response.json() as Record<string, unknown>;
    expect(value).toMatchObject({ state: 'routed', answers: { topic: 'benefits' }, routed_to_partner_category: 'Beneficios' });
    expect(value).not.toHaveProperty('answers.removed_on_replace');
  });

  it('PATCH accepts a closed partial shape, preserves omitted values, and defaults to save_draft', async () => {
    const { f, dependencies } = deps(); const draft = await f.service.save(resident, 'legal', {
      answers: { topic: 'housing' }, disclaimerAcknowledged: true, locale: 'es', intent: 'save_draft',
    }, 'route-key-0005');
    const handlers = createIntakeSubmissionHandlers(dependencies); const response = await handlers.PATCH(
      request(`/api/v1/intake/${draft.id}`, { answers: {} }, 'route-key-0006', 'PATCH'),
      { params: Promise.resolve({ submissionId: draft.id }) });
    expect(await response.json()).toMatchObject({ state: 'draft', answers: {}, locale: 'es', disclaimer_acknowledged: true });
  });

  it('requires acknowledgment true in the same PATCH that submits a draft', async () => {
    const { f, dependencies } = deps(); const draft = await f.service.save(resident, 'legal', {
      answers: { topic: 'housing' }, disclaimerAcknowledged: true, locale: 'en', intent: 'save_draft',
    }, 'route-key-0008');
    const handlers = createIntakeSubmissionHandlers(dependencies); const response = await handlers.PATCH(
      request(`/api/v1/intake/${draft.id}`, { intent: 'submit' }, 'route-key-0009', 'PATCH'),
      { params: Promise.resolve({ submissionId: draft.id }) });
    expect(response.status).toBe(422);
    expect(f.repository.submissions[0]?.state).toBe('draft');
  });

  it('rejects unknown transport fields instead of silently discarding them', async () => {
    const { dependencies } = deps(); const handler = createSubmitIntakeHandler('legal', dependencies);
    const response = await handler(request('/api/v1/intake/legal', { answers: {}, disclaimer_acknowledged: true,
      locale: 'en', intent: 'submit', resident_id: resident.id }, 'route-key-0007'));
    expect(response.status).toBe(422);
  });

  it('unauthenticated reads use cross-tenant-safe 404', async () => {
    const { f } = deps(); const handlers = createIntakeSubmissionHandlers({ authorize: () => Promise.resolve(null), intake: f.service });
    expect((await handlers.GET(new Request('http://local/api/v1/intake/nope'), { params: Promise.resolve({ submissionId: 'nope' }) })).status).toBe(404);
  });

  it('rejects malformed submission identifiers as non-disclosing 404', async () => {
    const { dependencies } = deps(); const handlers = createIntakeSubmissionHandlers(dependencies);
    expect((await handlers.GET(new Request('http://local/api/v1/intake/not-a-uuid'),
      { params: Promise.resolve({ submissionId: 'not-a-uuid' }) })).status).toBe(404);
  });
});
