import type { CaregiverRouteDependencies } from '../_shared';
import { identity, json, run } from '../_shared';
import { runtimeDependencies } from '../_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createInviteCaregiverHandler(dependencies: CaregiverRouteDependencies) {
  return (request: Request): Promise<Response> => run(async () => {
    const actor = await identity(dependencies, request); if (actor instanceof Response) return actor;
    return Response.json(await dependencies.service.invite(actor, await json(request)), { status: 201, headers: { 'cache-control': 'no-store' } });
  });
}

export const POST = createInviteCaregiverHandler(runtimeDependencies);
