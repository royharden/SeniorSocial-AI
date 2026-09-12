import { describe, expect, it, vi } from 'vitest';
import { ConciergeService } from '../../../apps/web/app/concierge/core.ts';
import type { ConciergeSession } from '../../../apps/web/app/concierge/types.ts';
import { createStartConversationHandler, POST as runtimeStart } from '../../../apps/web/app/api/v1/concierge/conversations/route.ts';
import { createGetConversationHandler, GET as runtimeGet } from '../../../apps/web/app/api/v1/concierge/conversations/[conversationId]/route.ts';
import { createSendMessageHandler, POST as runtimeMessage } from '../../../apps/web/app/api/v1/concierge/conversations/[conversationId]/messages/route.ts';
import * as handoffModule from '../../../apps/web/app/api/v1/concierge/conversations/[conversationId]/handoff/route.ts';
import { hasRequestPayload } from '../../../apps/web/app/api/v1/concierge/_shared.ts';
import { hasConcreteConciergeProvider, registerConciergeRuntimeForTest, resetConciergeRuntimeForTest } from '../../../apps/web/app/api/v1/concierge/_runtime.ts';

const orgId = '55555555-5555-4555-8555-555555555555';
const userId = '55555555-5555-4555-8555-555555555501';
const conversationId = '55555555-5555-4555-8555-555555555511';
const handoffKey = '55555555-5555-4555-8555-555555555512';
const assistanceId = '55555555-5555-4555-8555-555555555513';
const session: ConciergeSession = { orgId, userId, role: 'senior', locale: 'en', requestId: 'req-contract' };
const sameOrigin = { origin: 'http://local', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };

function dependencies(createAssistance = vi.fn(async () => ({ id: assistanceId, org_id: orgId, state: 'pending_unowned' as const }))) {
  const concierge = new ConciergeService({
    directory: { search: async () => [] }, assistance: { create: createAssistance },
    createId: vi.fn().mockReturnValueOnce(conversationId).mockReturnValueOnce(handoffKey),
  });
  return { authorize: async () => session, concierge, createAssistance };
}

function streamedHandoff(body: ReadableStream<Uint8Array>, headers = sameOrigin): Request {
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers, body, duplex: 'half' };
  return new Request('http://local/handoff', init);
}

function slowZeroByteStream(delayMs: number): ReadableStream<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finishPull: (() => void) | undefined;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      return new Promise<void>(resolve => {
        finishPull = resolve;
        timer = setTimeout(() => {
          finishPull = undefined;
          controller.enqueue(new Uint8Array());
          resolve();
        }, delayMs);
      });
    },
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
      finishPull?.();
    },
  });
}

describe('WP-011 locked HTTP contract', () => {
  it('creates the ConciergeConversation and returns the required answer fields', async () => {
    const deps = dependencies();
    const started = await createStartConversationHandler(deps)(new Request('http://local/api/v1/concierge/conversations', { method: 'POST' }));
    expect(started.status).toBe(201);
    expect(await started.json()).toEqual({ id: conversationId, turns: [], ai_enabled: false });
    const answered = await createSendMessageHandler(deps)(new Request(`http://local/api/v1/concierge/conversations/${conversationId}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'meal delivery', locale: 'en' }) }), { params: Promise.resolve({ conversationId }) });
    expect(answered.status).toBe(200);
    expect(await answered.json()).toMatchObject({ citations: [], disclaimer: expect.any(String), prompt_version: 'native-v1', human_route: '/assistance' });
  });

  it('accepts a browser-like zero-length request stream but rejects every non-empty start payload', async () => {
    registerConciergeRuntimeForTest({ authorize: async () => session, aiAvailability: { enabled: async () => false } });
    try {
      const empty = new Request('http://local/api/v1/concierge/conversations', {
        method: 'POST', headers: sameOrigin, body: '',
      });
      expect(empty.body).not.toBeNull();
      expect((await runtimeStart(empty)).status).toBe(201);

      for (const body of ['{}', '{', ' ', 'null']) {
        const denied = await runtimeStart(new Request('http://local/api/v1/concierge/conversations', {
          method: 'POST', headers: { ...sameOrigin, 'content-type': 'application/json' }, body,
        }));
        expect(denied.status).toBe(400);
        expect(await denied.json()).toMatchObject({
          title: 'Bad Request', status: 400, detail: 'This endpoint does not accept client identity or request fields',
        });
      }
    } finally { resetConciergeRuntimeForTest(); }
  });

  it('rejects client identity fields and requires an authenticated resident confirmation', async () => {
    const deps = dependencies();
    await createStartConversationHandler(deps)(new Request('http://local/api/v1/concierge/conversations', { method: 'POST' }));
    const poisoned = await createSendMessageHandler(deps)(new Request('http://local/messages', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'food', orgId: 'evil', role: 'admin' }) }), { params: Promise.resolve({ conversationId }) });
    expect(poisoned.status).toBe(422);
    const bodyful = await handoffModule.createHandoffHandler(deps)(new Request('http://local/handoff', { method: 'POST', headers: { ...sameOrigin, 'content-type': 'application/json' }, body: '{}' }), { params: Promise.resolve({ conversationId }) });
    expect(bodyful.status).toBe(400);
    const created = await handoffModule.createHandoffHandler(deps)(new Request('http://local/handoff', { method: 'POST', headers: sameOrigin }), { params: Promise.resolve({ conversationId }) });
    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ id: assistanceId, org_id: orgId, state: 'pending_unowned' });
  });

  it('accepts a non-null zero-byte handoff stream and fails closed on bytes, locked streams, and read errors', async () => {
    const accepted = dependencies();
    await createStartConversationHandler(accepted)(new Request('http://local/start', { method: 'POST' }));
    const emptyStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array());
        controller.enqueue(new Uint8Array(0));
        controller.close();
      },
    });
    const emptyRequest = streamedHandoff(emptyStream);
    expect(emptyRequest.body).not.toBeNull();
    expect((await handoffModule.createHandoffHandler(accepted)(emptyRequest, { params: Promise.resolve({ conversationId }) })).status).toBe(201);
    expect(accepted.createAssistance).toHaveBeenCalledTimes(1);

    const bodies = [
      new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }),
      new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error('read failed')); } }),
    ];
    for (const body of bodies) {
      const rejected = dependencies();
      await createStartConversationHandler(rejected)(new Request('http://local/start', { method: 'POST' }));
      expect((await handoffModule.createHandoffHandler(rejected)(streamedHandoff(body), { params: Promise.resolve({ conversationId }) })).status).toBe(400);
      expect(rejected.createAssistance).not.toHaveBeenCalled();
    }

    const locked = streamedHandoff(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }));
    const reader = locked.body!.getReader();
    const rejected = dependencies();
    await createStartConversationHandler(rejected)(new Request('http://local/start', { method: 'POST' }));
    expect((await handoffModule.createHandoffHandler(rejected)(locked, { params: Promise.resolve({ conversationId }) })).status).toBe(400);
    expect(rejected.createAssistance).not.toHaveBeenCalled();
    reader.releaseLock();
  });

  it('bounds hostile empty streams and does not let cleanup errors alter payload classification', async () => {
    const endlessEmptyChunks = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array()); } });
    const rejected = dependencies();
    await createStartConversationHandler(rejected)(new Request('http://local/start', { method: 'POST' }));
    expect((await handoffModule.createHandoffHandler(rejected)(streamedHandoff(endlessEmptyChunks), { params: Promise.resolve({ conversationId }) })).status).toBe(400);
    expect(rejected.createAssistance).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      const neverSettles = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined) });
      const stalled = dependencies();
      await createStartConversationHandler(stalled)(new Request('http://local/start', { method: 'POST' }));
      const response = handoffModule.createHandoffHandler(stalled)(streamedHandoff(neverSettles), { params: Promise.resolve({ conversationId }) });
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await response).status).toBe(400);
      expect(stalled.createAssistance).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    const throwingRelease = (result: ReadableStreamReadResult<Uint8Array>) => ({
      body: {
        getReader: () => ({
          read: () => Promise.resolve(result),
          cancel: () => Promise.resolve(),
          releaseLock: () => { throw new Error('cleanup failed'); },
        }),
      },
      signal: new AbortController().signal,
    }) as unknown as Request;
    expect(await hasRequestPayload(throwingRelease({ done: true, value: undefined }))).toBe(false);
    expect(await hasRequestPayload(throwingRelease({ done: false, value: new Uint8Array([1]) }))).toBe(true);
  });

  it('applies one absolute deadline to slow zero-byte streams in both start and handoff routes', async () => {
    vi.useFakeTimers();
    try {
      const startDeps = dependencies();
      const slowStart = streamedHandoff(slowZeroByteStream(900));
      const startTime = Date.now();
      const startResponse = createStartConversationHandler(startDeps)(slowStart);
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await startResponse).status).toBe(400);
      expect(Date.now() - startTime).toBe(1_000);
      expect(await startDeps.concierge.get(session, conversationId)).toBeNull();

      const handoffDeps = dependencies();
      await createStartConversationHandler(handoffDeps)(new Request('http://local/start', { method: 'POST' }));
      const handoffTime = Date.now();
      const handoffResponse = handoffModule.createHandoffHandler(handoffDeps)(
        streamedHandoff(slowZeroByteStream(900)),
        { params: Promise.resolve({ conversationId }) },
      );
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await handoffResponse).status).toBe(400);
      expect(Date.now() - handoffTime).toBe(1_000);
      expect(handoffDeps.createAssistance).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('checks authentication and then same-origin intent before inspecting a handoff stream', async () => {
    const events: string[] = [];
    const deps = dependencies();
    const bodyRequest = streamedHandoff(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }));
    const body = bodyRequest.body!;
    const getReader = body.getReader.bind(body);
    vi.spyOn(body, 'getReader').mockImplementation(() => {
      events.push('body');
      return getReader();
    });
    const anonymous = handoffModule.createHandoffHandler({
      ...deps,
      authorize: async () => { events.push('authorize'); return null; },
    });
    expect((await anonymous(bodyRequest, { params: Promise.resolve({ conversationId }) })).status).toBe(401);
    expect(events).toEqual(['authorize']);

    const crossOrigin = streamedHandoff(new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), {
      origin: 'http://evil.example', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors',
    });
    const crossOriginBody = crossOrigin.body!;
    const crossOriginGetReader = crossOriginBody.getReader.bind(crossOriginBody);
    vi.spyOn(crossOriginBody, 'getReader').mockImplementation(() => {
      events.push('body');
      return crossOriginGetReader();
    });
    const authorized = handoffModule.createHandoffHandler({
      ...deps,
      authorize: async () => { events.push('authorize'); return session; },
    });
    expect((await authorized(crossOrigin, { params: Promise.resolve({ conversationId }) })).status).toBe(403);
    expect(events).toEqual(['authorize', 'authorize']);
    expect(deps.createAssistance).not.toHaveBeenCalled();
  });

  it('allows only a deliberate same-origin bodyless POST to create assistance', async () => {
    const deps = dependencies();
    await createStartConversationHandler(deps)(new Request('http://local/api/v1/concierge/conversations', { method: 'POST' }));
    const create = handoffModule.createHandoffHandler(deps);
    expect('GET' in handoffModule).toBe(false);
    for (const request of [
      new Request('http://local/handoff', { method: 'GET', headers: sameOrigin }),
      new Request('http://local/handoff', { method: 'POST', headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' } }),
      new Request('http://local/handoff', { method: 'POST', headers: { ...sameOrigin, 'sec-fetch-mode': 'navigate' } }),
      new Request('http://local/handoff', { method: 'POST', headers: { ...sameOrigin, purpose: 'prefetch' } }),
      new Request('https://trusted.example/handoff', { method: 'POST', headers: { host: 'evil.example', origin: 'https://evil.example' } }),
      new Request('https://trusted.example/handoff', { method: 'POST', headers: { host: 'evil.example', origin: 'https://evil.example', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' } }),
    ]) expect((await create(request, { params: Promise.resolve({ conversationId }) })).status).toBe(403);
  });

  it('does not silently map unsupported production providers onto the stub adapter', () => {
    expect(hasConcreteConciergeProvider('stub')).toBe(true);
    expect(hasConcreteConciergeProvider('anthropic-api')).toBe(false);
    expect(hasConcreteConciergeProvider('claude-cli-bridge')).toBe(false);
  });

  it('returns the same 404 for invalid, cross-tenant, and cross-user conversation ids', async () => {
    const deps = dependencies();
    await createStartConversationHandler(deps)(new Request('http://local/api/v1/concierge/conversations', { method: 'POST' }));
    const get = createGetConversationHandler(deps);
    const missing = await get(new Request('http://local/conversation'), { params: Promise.resolve({ conversationId: 'not-an-id' }) });
    const crossTenant = await createGetConversationHandler({ ...deps, authorize: async () => ({ ...session, orgId: '55555555-5555-4555-8555-555555555599' }) })(new Request('http://local/conversation'), { params: Promise.resolve({ conversationId }) });
    const crossUser = await createGetConversationHandler({ ...deps, authorize: async () => ({ ...session, userId: '55555555-5555-4555-8555-555555555598' }) })(new Request('http://local/conversation'), { params: Promise.resolve({ conversationId }) });
    for (const response of [missing, crossTenant, crossUser]) {
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ title: 'Not Found', status: 404, detail: 'Conversation not found' });
    }
  });

  it('smoke-tests the actual exported runtime handlers with zero-network adapters', async () => {
    const serviceId = '55555555-5555-4555-8555-555555555520';
    registerConciergeRuntimeForTest({
      authorize: async () => session,
      directory: { search: async () => [{ id: serviceId, orgId, name: 'Maple Meals', phone: '555-0101' }] },
      ai: { chat: async () => ({ outcome: 'ok', text: 'ignored', citations: [serviceId], toolCalls: [], promptRef: { version: 'v1' } }) },
      aiAvailability: { enabled: async () => true },
      assistance: { create: async input => ({ id: assistanceId, org_id: input.orgId, state: 'pending_unowned' }) },
    });
    try {
      const started = await runtimeStart(new Request('http://local/api/v1/concierge/conversations', { method: 'POST' }));
      expect(started.status).toBe(201);
      const conversation = await started.json() as { id: string };
      const answered = await runtimeMessage(new Request(`http://local/api/v1/concierge/conversations/${conversation.id}/messages`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'meal delivery' }) }), { params: Promise.resolve({ conversationId: conversation.id }) });
      expect(await answered.json()).toMatchObject({ citations: [serviceId], prompt_version: 'v1' });
      expect((await runtimeGet(new Request('http://local/get'), { params: Promise.resolve({ conversationId: conversation.id }) })).status).toBe(200);
      expect((await handoffModule.POST(new Request('http://local/handoff', { method: 'POST', headers: sameOrigin }), { params: Promise.resolve({ conversationId: conversation.id }) })).status).toBe(201);
    } finally { resetConciergeRuntimeForTest(); }
  });

  it('keeps only the not-yet-integrated assistance seam fail-closed at 503', async () => {
    registerConciergeRuntimeForTest({ authorize: async () => session });
    try {
      const started = await runtimeStart(new Request('http://local/api/v1/concierge/conversations', { method: 'POST' }));
      const conversation = await started.json() as { id: string };
      const handoff = await handoffModule.POST(new Request('http://local/handoff', { method: 'POST', headers: sameOrigin }), { params: Promise.resolve({ conversationId: conversation.id }) });
      expect(handoff.status).toBe(503);
      expect(await handoff.json()).toMatchObject({ title: 'Service Unavailable', status: 503 });
    } finally { resetConciergeRuntimeForTest(); }
  });
});
