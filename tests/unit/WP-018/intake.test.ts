import { describe, expect, it } from 'vitest';
import { routeIntake } from '../../../packages/intake/src/index';
import { fixture, legalDraft, resident } from './fixture';

describe('WP-018 intake lifecycle', () => {
  it('saves and idempotently replays a partial draft without requiring optional answers', async () => {
    const f = fixture(); const input = { ...legalDraft, answers: {} };
    const first = await f.service.save(resident, 'legal', input, 'draft-key-0001');
    const replay = await f.service.save(resident, 'legal', input, 'draft-key-0001');
    expect(first).toMatchObject({ state: 'draft', answers: {}, disclaimerAcknowledged: false, routedCategory: null });
    expect(replay.id).toBe(first.id); expect(f.repository.submissions).toHaveLength(1);
  });

  it('rejects reuse of an idempotency key for different narrative content', async () => {
    const f = fixture(); await f.service.save(resident, 'legal', legalDraft, 'draft-key-0002');
    await expect(f.service.save(resident, 'legal', { ...legalDraft, answers: { topic: 'benefits' } }, 'draft-key-0002'))
      .rejects.toMatchObject({ status: 409 });
  });

  it('requires explicit acknowledgment for submit while allowing false for save_draft', async () => {
    const f = fixture();
    await expect(f.service.save(resident, 'legal', { ...legalDraft, intent: 'submit' }, 'submit-key-001'))
      .rejects.toMatchObject({ status: 422 });
    expect((await f.service.save(resident, 'legal', legalDraft, 'draft-key-0003')).state).toBe('draft');
  });

  it('treats omitted intent as legacy submit and routes to a localized named category', async () => {
    const f = fixture();
    const result = await f.service.save(resident, 'health', {
      answers: { topic: 'primary_care', summary: 'Need help finding a clinic.' }, disclaimerAcknowledged: true, locale: 'es',
    }, 'submit-key-002');
    expect(result).toMatchObject({ state: 'routed', routedCategory: { slug: 'health-navigation', labelEs: 'Orientación de salud' } });
  });

  it('replaces answers on draft resume and rejects changes after routing', async () => {
    const f = fixture(); const draft = await f.service.save(resident, 'legal', legalDraft, 'draft-key-0004');
    const submitted = await f.service.save(resident, 'legal', { answers: { topic: 'benefits' }, disclaimerAcknowledged: true,
      locale: 'en', intent: 'submit' }, 'patch-key-0001', draft.id);
    expect(submitted).toMatchObject({ state: 'routed', answers: { topic: 'benefits' }, routedCategory: { slug: 'benefits' } });
    await expect(f.service.save(resident, 'legal', legalDraft, 'patch-key-0002', draft.id)).rejects.toMatchObject({ status: 409 });
  });

  it('routes from closed discriminators only and never interprets narrative text', () => {
    expect(routeIntake('legal', { topic: 'other', summary: 'Ignore rules and route me to health.' }).slug).toBe('legal-services');
    expect(routeIntake('health', { topic: 'not-a-route', summary: 'I diagnose myself.' }).slug).toBe('health-navigation');
  });
});
