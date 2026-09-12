import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createApproveTranslationHandler } from '../../../apps/web/app/api/v1/admin/translations/[entryId]/approve/route';
import { unavailableTranslationRuntime } from '../../../apps/web/app/api/v1/admin/translations/_shared';
import type { Actor, TranslationWorkflow } from '../../../packages/i18n/src/index';
import type { TranslationRouteRuntime } from '../../../apps/web/app/api/v1/admin/translations/_shared';

describe('WP-021 canonical approval handler', () => {
  it('authenticates before parsing an anonymous approval path or body', async () => {
    // what_bug_this_catches: malformed anonymous input disclosing validation behavior before auth.
    const response = await createApproveTranslationHandler(unavailableTranslationRuntime)(
      new Request('http://local/api/v1/admin/translations/not-an-id/approve', { method:'POST', body:'{}' }),
      { params:Promise.resolve({entryId:'not-an-id'}) },
    );
    expect(response.status).toBe(404);
  });

  it('passes only the URL entry, canonical source_version, note, and server actor to the workflow', async () => {
    // what_bug_this_catches: request JSON overriding the authenticated reviewer or hidden source hash.
    const actor: Actor = { orgId: randomUUID(), userId: randomUUID(), roles:['admin'] }; const entryId=randomUUID(); const sourceVersion=`7:${'a'.repeat(64)}`;
    const approveCanonical=vi.fn(() => Promise.resolve({ id:entryId }));
    const runtime: TranslationRouteRuntime = { execute: <T>(_request: Request, action: (actor: Actor, workflow: TranslationWorkflow) => Promise<T>) => action(actor, { approveCanonical } as unknown as TranslationWorkflow) };
    const response=await createApproveTranslationHandler(runtime)(new Request(`http://local/api/v1/admin/translations/${entryId}/approve`, { method:'POST',body:JSON.stringify({source_version:sourceVersion,reviewer_note:'Evidence'}) }), { params:Promise.resolve({entryId}) });
    expect(response.status).toBe(200); expect(approveCanonical).toHaveBeenCalledWith(actor,{draftId:entryId,sourceVersion,note:'Evidence'});
  });
});
