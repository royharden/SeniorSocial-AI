import type { CaregiverRouteDependencies } from '../_shared';
import { identity, run } from '../_shared';
import { runtimeDependencies } from '../_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createListCaregiverLinksHandler(dependencies: CaregiverRouteDependencies) {
  return (request: Request): Promise<Response> => run(async () => {
    const actor = await identity(dependencies, request); if (actor instanceof Response) return actor;
    return Response.json(await dependencies.service.links(actor), { headers: { 'cache-control': 'no-store' } });
  });
}

export const GET = createListCaregiverLinksHandler(runtimeDependencies);
