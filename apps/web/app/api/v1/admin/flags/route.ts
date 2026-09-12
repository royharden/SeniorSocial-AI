export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export interface AdminContext { orgId: string; userId: string; roles: readonly string[] }
export interface FlagRouteDependencies { authorize: (request: Request) => Promise<AdminContext | null>; flags: { list: (orgId: string) => Promise<unknown> } }

function problem(status: number, detail: string): Response {
  return Response.json({ type: 'about:blank', title: status === 403 ? 'Forbidden' : 'Bad Request', status, detail }, { status, headers: { 'cache-control': 'no-store' } });
}
export function createListFlagsHandler(dependencies: FlagRouteDependencies) {
  return async function get(request: Request): Promise<Response> {
    const context = await dependencies.authorize(request);
    if (!context?.roles.includes('admin')) return problem(403, 'An explicit authenticated admin context is required');
    return Response.json(await dependencies.flags.list(context.orgId), { headers: { 'cache-control': 'no-store' } });
  };
}

const unavailable: FlagRouteDependencies = {
  authorize: () => Promise.resolve(null),
  flags: { list: () => Promise.resolve({ items: [] }) },
};
export const GET = createListFlagsHandler(unavailable);
