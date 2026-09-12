import { describe, expect, it } from 'vitest';
import { createTranslationHandlers } from '../../../apps/web/app/api/v1/admin/translations/route';
import { createDefaultTranslationRuntime, translationProblem, unavailableTranslationRuntime } from '../../../apps/web/app/api/v1/admin/translations/_shared';
import type { TranslationRouteRuntime } from '../../../apps/web/app/api/v1/admin/translations/_shared';
import type { Actor, TranslationWorkflow } from '../../../packages/i18n/src/index';

const authorizedActor: Actor = {
  orgId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  roles: ['admin'],
};

function authorizedRuntime(onExecute?: () => void): TranslationRouteRuntime {
  return {
    execute: <T>(_request: Request, action: (actor: Actor, workflow: TranslationWorkflow) => Promise<T>) => {
      onExecute?.();
      return action(authorizedActor, {} as TranslationWorkflow);
    },
  };
}

describe('WP-021 translation route security', () => {
  it('fails closed without a server-resolved actor and does not disclose a record', async () => {
    // what_bug_this_catches: default route composition accidentally granting anonymous admin access.
    const response = await createTranslationHandlers(unavailableTranslationRuntime).GET(new Request('http://local/api/v1/admin/translations'));
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'not_found', title: 'Translation not found' });
  });

  it('authenticates before parsing an anonymous mutation body', async () => {
    // what_bug_this_catches: malformed anonymous JSON disclosing validation behavior as 422 before auth.
    const response = await createTranslationHandlers(unavailableTranslationRuntime).POST(
      new Request('http://local/api/v1/admin/translations', { method: 'POST', body: '{}' }),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: 'not_found' });
  });

  it.each(['orgId', 'org_id', 'actorId', 'actor_id', 'reviewer', 'reviewedBy', 'reviewed_by', 'qualification'])('rejects client-owned identity field %s before execution', async field => {
    // what_bug_this_catches: a caller self-assigning a tenant, actor, reviewer, or qualification.
    let executed = false;
    const runtime = authorizedRuntime(() => { executed = true; });
    const response = await createTranslationHandlers(runtime).POST(new Request('http://local/api/v1/admin/translations', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'source', key: 'x', text: 'x', critical: false, [field]: 'forged' }) }));
    expect(response.status).toBe(422); expect(executed).toBe(true);
  });

  it('treats malformed percent-encoded session cookies as anonymous', async () => {
    // what_bug_this_catches: decodeURIComponent crashing the route before a nondisclosing auth response.
    const previousOrg = process.env.SENIORSOCIAL_ORG_ID; const previousPepper = process.env.AUTH_TOKEN_PEPPER;
    process.env.SENIORSOCIAL_ORG_ID = '11111111-1111-4111-8111-111111111111'; process.env.AUTH_TOKEN_PEPPER = 'synthetic-pepper-value';
    try {
      const response = await createTranslationHandlers(createDefaultTranslationRuntime()).GET(new Request('http://local/api/v1/admin/translations', { headers: { cookie: 'ss_session=%E0%A4%A' } }));
      expect(response.status).toBe(404);
    } finally {
      if (previousOrg === undefined) delete process.env.SENIORSOCIAL_ORG_ID; else process.env.SENIORSOCIAL_ORG_ID = previousOrg;
      if (previousPepper === undefined) delete process.env.AUTH_TOKEN_PEPPER; else process.env.AUTH_TOKEN_PEPPER = previousPepper;
    }
  });

  it.each([
    { action: 'draft', sourceId: 'not-a-uuid', text: 'Texto' },
    { action: 'publish', draftId: '11111111-1111-4111-8111-111111111111', sourceHash: 'ABC', sourceVersion: 1 },
    { action: 'publish', draftId: '11111111-1111-4111-8111-111111111111', sourceHash: 'a'.repeat(64), sourceVersion: 0 },
    { action: 'source', key: 'x'.repeat(201), text: 'Source', critical: false },
  ])('rejects malformed or unbounded values before SQL casts', async body => {
    // what_bug_this_catches: invalid UUID/hash/version/text reaching PostgreSQL as a 22P02 or oversized value.
    let executed = false; const runtime = authorizedRuntime(() => { executed = true; });
    const response = await createTranslationHandlers(runtime).POST(new Request('http://local/api/v1/admin/translations', { method:'POST', body:JSON.stringify(body) }));
    expect(response.status).toBe(422); expect(executed).toBe(true);
  });

  it.each([
    ['22P02', 422, 'invalid_request'],
    ['42501', 404, 'not_found'],
    ['23505', 409, 'translation_conflict'],
  ])('maps SQLSTATE %s without returning database detail', async (code, status, publicCode) => {
    // what_bug_this_catches: raw PostgreSQL messages or constraint names escaping through API errors.
    const response = translationProblem({ code, message: 'secret SQL detail' });
    expect(response.status).toBe(status);
    const body: unknown = await response.json(); expect(body).toMatchObject({ code: publicCode }); expect(JSON.stringify(body)).not.toContain('secret SQL detail');
  });
});
