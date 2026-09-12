import { bounded, canonicalSourceVersion, defaultTranslationRuntime, exactBody, jsonBody, translationProblem, uuid, type TranslationRouteRuntime } from '../../_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createApproveTranslationHandler(dependencies: TranslationRouteRuntime) {
  return async function POST(request: Request, context: { params: Promise<{ entryId: string }> }): Promise<Response> {
    try {
      return await dependencies.execute(request, async (actor, workflow) => {
        const { entryId } = await context.params; const draftId = uuid(entryId); const body = await jsonBody(request);
        exactBody(body, ['source_version', 'reviewer_note']);
        const sourceVersion = bounded(body.source_version, 'source_version', 100); canonicalSourceVersion(sourceVersion);
        const note = bounded(body.reviewer_note, 'reviewer_note', 500);
        return Response.json(await workflow.approveCanonical(actor, { draftId, sourceVersion, note }), { headers: { 'cache-control': 'no-store' } });
      });
    } catch (error) { return translationProblem(error); }
  };
}

export const POST = createApproveTranslationHandler(defaultTranslationRuntime);
