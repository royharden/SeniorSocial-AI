export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export interface AdminAiContext { orgId: string; roles: readonly string[] }
export interface AiEventRouteDependencies { authorize: (request: Request) => Promise<AdminAiContext | null>; events: { list: (orgId: string, query: { feature?: string; cursor?: string; limit?: number }) => Promise<unknown> } }

function forbidden(): Response { return Response.json({ type: 'about:blank', title: 'Forbidden', status: 403, detail: 'An explicit authenticated admin context is required' }, { status: 403, headers: { 'cache-control': 'no-store' } }); }
export function createListAiEventsHandler(dependencies: AiEventRouteDependencies) {
  return async function get(request: Request): Promise<Response> {
    const context = await dependencies.authorize(request);
    if (!context?.roles.includes('admin')) return forbidden();
    const url = new URL(request.url);
    const feature = url.searchParams.get('feature');
    const cursor = url.searchParams.get('cursor');
    const rawLimit = url.searchParams.get('limit');
    const result = await dependencies.events.list(context.orgId, {
      ...(feature ? { feature } : {}), ...(cursor ? { cursor } : {}), ...(rawLimit ? { limit: Number(rawLimit) } : {}),
    });
    return Response.json(result, { headers: { 'cache-control': 'no-store' } });
  };
}
const unavailable: AiEventRouteDependencies = { authorize: () => Promise.resolve(null), events: { list: () => Promise.resolve({ items: [], meta: { next_cursor: null, total_known: true } }) } };
export const GET = createListAiEventsHandler(unavailable);
