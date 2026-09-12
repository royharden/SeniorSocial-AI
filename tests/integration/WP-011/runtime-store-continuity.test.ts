import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistanceCreationPort, ConciergeAnswer, ConciergeSession } from '../../../apps/web/app/concierge/types.ts';
import type * as RuntimeExports from '../../../apps/web/app/api/v1/concierge/_runtime.ts';
import type * as StartExports from '../../../apps/web/app/api/v1/concierge/conversations/route.ts';
import type * as GetExports from '../../../apps/web/app/api/v1/concierge/conversations/[conversationId]/route.ts';
import type * as MessageExports from '../../../apps/web/app/api/v1/concierge/conversations/[conversationId]/messages/route.ts';
import type * as HandoffExports from '../../../apps/web/app/api/v1/concierge/conversations/[conversationId]/handoff/route.ts';

type RuntimeModule = typeof RuntimeExports;
type StartModule = typeof StartExports;
type GetModule = typeof GetExports;
type MessageModule = typeof MessageExports;
type HandoffModule = typeof HandoffExports;

interface RouteGraph {
  readonly runtime: RuntimeModule;
  readonly start: StartModule;
  readonly get: GetModule;
  readonly message: MessageModule;
  readonly handoff: HandoffModule;
}

const orgId = '88888888-8888-4888-8888-888888888888';
const userId = '88888888-8888-4888-8888-888888888801';
const serviceId = '88888888-8888-4888-8888-888888888802';
const assistanceId = '88888888-8888-4888-8888-888888888803';
const session: ConciergeSession = { orgId, userId, role: 'senior', locale: 'en', requestId: 'req-route-graph' };
const sameOrigin = { origin: 'http://local', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };
const loadedRuntimes: RuntimeModule[] = [];

async function loadIndependentRouteGraph(): Promise<RouteGraph> {
  vi.resetModules();
  const [runtime, start, get, message, handoff] = await Promise.all([
    import('../../../apps/web/app/api/v1/concierge/_runtime.ts'),
    import('../../../apps/web/app/api/v1/concierge/conversations/route.ts'),
    import('../../../apps/web/app/api/v1/concierge/conversations/[conversationId]/route.ts'),
    import('../../../apps/web/app/api/v1/concierge/conversations/[conversationId]/messages/route.ts'),
    import('../../../apps/web/app/api/v1/concierge/conversations/[conversationId]/handoff/route.ts'),
  ]);
  loadedRuntimes.push(runtime);
  return { runtime, start, get, message, handoff };
}

function configure(graph: RouteGraph, assistance: AssistanceCreationPort): void {
  graph.runtime.registerConciergeRuntimeForTest({
    authorize: () => Promise.resolve(session),
    directory: { search: () => Promise.resolve([{ id: serviceId, orgId, name: 'Maple Meals', phone: '555-0101' }]) },
    aiAvailability: { enabled: () => Promise.resolve(false) },
    assistance,
  });
}

afterEach(() => {
  for (const runtime of loadedRuntimes.splice(0)) runtime.resetConciergeRuntimeForTest();
  vi.resetModules();
});

describe('WP-011 process-local route graph continuity', () => {
  it('continues a conversation across independently loaded Next route graphs without weakening tenant isolation', async () => {
    const createAssistance = vi.fn<AssistanceCreationPort['create']>(input => Promise.resolve({
      id: assistanceId, org_id: input.orgId, state: 'pending_unowned' as const, summary: input.summary,
    }));
    const firstGraph = await loadIndependentRouteGraph();
    configure(firstGraph, { create: createAssistance });
    const started = await firstGraph.start.POST(new Request('http://local/api/v1/concierge/conversations', { method: 'POST' }));
    expect(started.status).toBe(201);
    const conversation = await started.json() as { id: string };

    const secondGraph = await loadIndependentRouteGraph();
    configure(secondGraph, { create: createAssistance });
    const context = { params: Promise.resolve({ conversationId: conversation.id }) };

    expect((await secondGraph.get.GET(new Request('http://local/get'), context)).status).toBe(200);
    const answered = await secondGraph.message.POST(new Request('http://local/message', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'meal delivery', locale: 'en' }),
    }), context);
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ citations: [serviceId] });

    for (const foreign of [
      { ...session, orgId: '88888888-8888-4888-8888-888888888899' },
      { ...session, userId: '88888888-8888-4888-8888-888888888898' },
    ]) {
      secondGraph.runtime.registerConciergeRuntimeForTest({ authorize: () => Promise.resolve(foreign) });
      const response = await secondGraph.get.GET(new Request('http://local/get'), context);
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ title: 'Not Found', detail: 'Conversation not found' });
    }
    secondGraph.runtime.registerConciergeRuntimeForTest({ authorize: () => Promise.resolve(session) });

    const firstView = await firstGraph.runtime.conciergeRouteDependencies.concierge.get(session, conversation.id);
    (firstView?.turns as ConciergeAnswer[]).push({
      text: 'caller mutation', citations: [], disclaimer: 'mutation', human_route: '/mutation', prompt_version: 'mutation',
    });
    expect((await secondGraph.runtime.conciergeRouteDependencies.concierge.get(session, conversation.id))?.turns).toHaveLength(1);

    const request = () => new Request('http://local/handoff', { method: 'POST', headers: sameOrigin });
    const [fromFirst, fromSecond] = await Promise.all([
      firstGraph.handoff.POST(request(), context),
      secondGraph.handoff.POST(request(), context),
    ]);
    expect([fromFirst.status, fromSecond.status]).toEqual([201, 201]);
    expect(await fromFirst.json()).toEqual(await fromSecond.json());
    expect(createAssistance).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('clears the shared process-local store from any test wrapper while keeping overrides wrapper-local', async () => {
    const firstGraph = await loadIndependentRouteGraph();
    configure(firstGraph, { create: input => Promise.resolve({ id: assistanceId, org_id: input.orgId, state: 'pending_unowned' }) });
    const started = await firstGraph.start.POST(new Request('http://local/start', { method: 'POST' }));
    const conversation = await started.json() as { id: string };

    const secondGraph = await loadIndependentRouteGraph();
    secondGraph.runtime.resetConciergeRuntimeForTest();
    expect(await firstGraph.runtime.conciergeRouteDependencies.concierge.get(session, conversation.id)).toBeNull();

    const restarted = await firstGraph.start.POST(new Request('http://local/start', { method: 'POST' }));
    expect(restarted.status).toBe(201);
  });
});
