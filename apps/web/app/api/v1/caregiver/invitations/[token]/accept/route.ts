import type { CaregiverRouteDependencies } from '../../../_shared';
import { identity, run } from '../../../_shared';
import { runtimeDependencies } from '../../../_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createAcceptCaregiverInvitationHandler(dependencies: CaregiverRouteDependencies) {
  return (request: Request, context: { params: Promise<{ token: string }> }): Promise<Response> => run(async () => {
    const actor = await identity(dependencies, request); if (actor instanceof Response) return actor;
    const { token } = await context.params;
    return Response.json(await dependencies.service.accept(actor, token), { headers: { 'cache-control': 'no-store' } });
  });
}

export const POST = createAcceptCaregiverInvitationHandler(runtimeDependencies);
