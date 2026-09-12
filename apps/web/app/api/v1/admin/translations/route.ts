import { TranslationInvalid } from '@seniorsocial/i18n';
import { bounded, defaultTranslationRuntime, exactBody, hash, jsonBody, positiveVersion, translationProblem, uuid, type TranslationRouteRuntime } from './_shared';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createTranslationHandlers(dependencies: TranslationRouteRuntime) {
  return {
    GET: async (request: Request): Promise<Response> => {
      try { return Response.json({ items: await dependencies.execute(request, (actor, workflow) => workflow.list(actor)) }, { headers: { 'cache-control': 'no-store' } }); }
      catch (error) { return translationProblem(error); }
    },
    POST: async (request: Request): Promise<Response> => {
      try {
        return await dependencies.execute(request, async (actor, workflow) => {
          const body = await jsonBody(request); const action = body.action;
          if (action === 'source') {
            exactBody(body, ['action', 'key', 'text', 'critical']);
            if (typeof body.critical !== 'boolean') throw new TranslationInvalid('Invalid critical flag');
            const key=bounded(body.key,'key',200); const text=bounded(body.text,'text',20_000); const critical=body.critical;
            return Response.json(await workflow.updateSource(actor, { key, text, critical }), { status: 201, headers: { 'cache-control': 'no-store' } });
          }
          if (action === 'draft') {
            exactBody(body, ['action', 'sourceId', 'text', 'machine', 'requestId']);
            if (body.machine !== undefined && typeof body.machine !== 'boolean') throw new TranslationInvalid('Invalid machine flag');
            const sourceId=uuid(body.sourceId); const text=body.text===undefined ? undefined : bounded(body.text,'text',20_000); const requestId=body.requestId===undefined ? undefined : bounded(body.requestId,'requestId',200);
            return Response.json(await workflow.draft(actor, { sourceId, ...(text ? { text } : {}), ...(typeof body.machine === 'boolean' ? { machine: body.machine } : {}), ...(requestId ? { requestId } : {}) }), { status: 201, headers: { 'cache-control': 'no-store' } });
          }
          if (action === 'publish') {
            exactBody(body, ['action', 'draftId', 'sourceHash', 'sourceVersion']);
            const draftId=uuid(body.draftId); const sourceHash=hash(body.sourceHash); const sourceVersion=positiveVersion(body.sourceVersion);
            return Response.json(await workflow.publish(actor, { draftId, sourceHash, sourceVersion }), { headers: { 'cache-control': 'no-store' } });
          }
          throw new TranslationInvalid('Invalid action');
        });
      } catch (error) {
        return translationProblem(error instanceof Error && error.message === 'invalid' ? new TranslationInvalid('Invalid request') : error);
      }
    },
  };
}

const handlers = createTranslationHandlers(defaultTranslationRuntime);
export const GET = handlers.GET;
export const POST = handlers.POST;
