export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

export type FlagScope = 'global' | 'org';
export const routeFlagKeys = [
  'ai.master', 'ai.concierge', 'ai.moderation', 'ai.translation_assist', 'ai.triage', 'ai.intake_routing',
  'ai.event_rerank', 'ai.conversation_starters', 'ai.summaries', 'ai.provider.anthropic_api',
  'ai.provider.cli_bridge', 'ai.cache.exact_match', 'ai.batch.moderation', 'rag.enabled',
  'notify.sms.real_send', 'notify.voice.real_send', 'notify.web_push', 'messages.one_to_one', 'intake.health',
  'translate.review_queue_ui', 'admin.analytics_extended', 'events.resident_proposals', 'easy_mode.voice_io',
  'demo.reset_endpoint',
] as const;
export type RouteFlagKey = (typeof routeFlagKeys)[number];
const routeFlagSet = new Set<string>(routeFlagKeys);
export interface AdminFlagContext { orgId: string; userId: string; roles: readonly string[]; flagScope: FlagScope; requestId?: string }
export interface SetFlagDependencies {
  authorize: (request: Request) => Promise<AdminFlagContext | null>;
  flags: { set: (flag: RouteFlagKey, enabled: boolean, reason: string, context: { orgId: string; actorId: string; scope: FlagScope; requestId?: string }) => Promise<unknown> };
}

function problem(status: number, detail: string): Response {
  return Response.json({ type: 'about:blank', title: status === 403 ? 'Forbidden' : 'Bad Request', status, detail }, { status, headers: { 'cache-control': 'no-store' } });
}

export function createSetFlagHandler(dependencies: SetFlagDependencies) {
  return async function patch(request: Request, route: { params: Promise<{ flagKey: string }> }): Promise<Response> {
    const context = await dependencies.authorize(request);
    if (!context?.roles.includes('admin')) return problem(403, 'An explicit authenticated admin context is required');
    const { flagKey } = await route.params;
    if (!routeFlagSet.has(flagKey)) return problem(400, 'Unknown feature flag');
    let body: unknown;
    try { body = await request.json(); } catch { return problem(400, 'A JSON body is required'); }
    if (!body || typeof body !== 'object' || typeof (body as { enabled?: unknown }).enabled !== 'boolean' || typeof (body as { reason?: unknown }).reason !== 'string') {
      return problem(400, 'enabled and reason are required');
    }
    try {
      const result = await dependencies.flags.set(flagKey as RouteFlagKey, (body as { enabled: boolean }).enabled, (body as { reason: string }).reason, {
        orgId: context.orgId, actorId: context.userId, scope: context.flagScope, ...(context.requestId ? { requestId: context.requestId } : {}),
      });
      return Response.json(result, { headers: { 'cache-control': 'no-store' } });
    } catch (error) {
      return problem(400, error instanceof Error ? error.message : 'Flag change failed');
    }
  };
}

const unavailable: SetFlagDependencies = {
  authorize: () => Promise.resolve(null),
  flags: { set: () => Promise.reject(new Error('Authentication integration unavailable')) },
};
export const PATCH = createSetFlagHandler(unavailable);
