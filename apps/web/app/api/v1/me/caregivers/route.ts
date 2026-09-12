import type { CaregiverRouteDependencies } from '../../caregiver/_shared';
import { identity, run } from '../../caregiver/_shared';
import { runtimeDependencies } from '../../caregiver/_runtime';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export function createListMyCaregiversHandler(dependencies: CaregiverRouteDependencies) {
  return (request: Request): Promise<Response> => run(async () => {
    const actor = await identity(dependencies, request); if (actor instanceof Response) return actor;
    return Response.json(await dependencies.service.myCaregivers(actor), { headers: { 'cache-control': 'no-store' } });
  });
}

export const GET = createListMyCaregiversHandler(runtimeDependencies);
