import type { CaregiverRouteDependencies } from '../../../_shared';
import { identity, json, run } from '../../../_shared';
import { runtimeDependencies } from '../../../_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createSetConsentScopesHandler(dependencies: CaregiverRouteDependencies) {
  return (request: Request, context: { params: Promise<{ linkId: string }> }): Promise<Response> => run(async () => {
    const actor = await identity(dependencies, request); if (actor instanceof Response) return actor;
    const { linkId } = await context.params;
    return Response.json(await dependencies.service.setScopes(actor, linkId, await json(request)), { headers: { 'cache-control': 'no-store' } });
  });
}

export const PUT = createSetConsentScopesHandler(runtimeDependencies);
