import type { CaregiverRouteDependencies } from '../../_shared';
import { identity, run } from '../../_shared';
import { runtimeDependencies } from '../../_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createRevokeCaregiverLinkHandler(dependencies: CaregiverRouteDependencies) {
  return (request: Request, context: { params: Promise<{ linkId: string }> }): Promise<Response> => run(async () => {
    const actor = await identity(dependencies, request); if (actor instanceof Response) return actor;
    const { linkId } = await context.params;
    await dependencies.service.revoke(actor, linkId);
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
  });
}

export const DELETE = createRevokeCaregiverLinkHandler(runtimeDependencies);
