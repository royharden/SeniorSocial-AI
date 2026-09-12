import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssistanceRequest, AssistanceService, Identity } from '../../../packages/assistance/src/index.ts';
import type { ConciergeSession } from '../../../apps/web/app/concierge/types.ts';
import {
  createPostgresConciergeAssistanceAdapter,
  registerConciergeRuntimeForTest,
  resetConciergeRuntimeForTest,
} from '../../../apps/web/app/api/v1/concierge/_runtime.ts';
import { POST as startConversation } from '../../../apps/web/app/api/v1/concierge/conversations/route.ts';
import { POST as handoff } from '../../../apps/web/app/api/v1/concierge/conversations/[conversationId]/handoff/route.ts';

const orgId = '77777777-7777-4777-8777-777777777777';
const userId = '77777777-7777-4777-8777-777777777701';
const assistanceId = '77777777-7777-4777-8777-777777777702';
const session: ConciergeSession = { orgId, userId, role: 'senior', locale: 'es', requestId: 'req-runtime' };
const sameOrigin = { origin: 'http://local', 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' };

function streamedHandoff(body: ReadableStream<Uint8Array>): Request {
  const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers: sameOrigin, body, duplex: 'half' };
  return new Request('http://local/handoff', init);
}

function assistanceRequest(): AssistanceRequest {
  return {
    id: assistanceId,
    orgId,
    requesterId: userId,
    summary: 'Concierge handoff requested by resident',
    locale: 'es',
    triageCategory: 'general',
    triageSource: 'rules',
    state: 'pending_unowned',
    ownerId: null,
    afterHours: false,
    slaDueAt: new Date('2026-09-10T18:00:00.000Z'),
    slaBreachedAt: null,
    createdAt: new Date('2026-09-10T17:00:00.000Z'),
  };
}

afterEach(() => resetConciergeRuntimeForTest());

describe('WP-011 to WP-014 runtime composition', () => {
  it('creates a real assistance request from a browser-compatible zero-byte handoff stream', async () => {
    const create = vi.fn(() => Promise.resolve({ id: assistanceId, org_id: orgId, state: 'pending_unowned' as const }));
    registerConciergeRuntimeForTest({
      authorize: () => Promise.resolve(session),
      aiAvailability: { enabled: () => Promise.resolve(false) },
      assistance: { create },
    });
    const started = await startConversation(new Request('http://local/start', { method: 'POST' }));
    const conversation = await started.json() as { id: string };
    const context = { params: Promise.resolve({ conversationId: conversation.id }) };
    const zeroByteBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array()); controller.close(); },
    });

    expect((await handoff(streamedHandoff(zeroByteBody), context)).status).toBe(201);
    expect(create).toHaveBeenCalledTimes(1);

    const byteBody = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); },
    });
    expect((await handoff(streamedHandoff(byteBody), context)).status).toBe(400);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps the trusted WP-004 session and returns the exact concierge record idempotently', async () => {
    const create = vi.fn((identity: Identity, input: { summary: string; locale?: 'en' | 'es'; idempotencyKey: string }) => {
      expect(identity).toEqual({ orgId, userId, roles: ['senior'] });
      expect(input).toMatchObject({ summary: 'Concierge handoff requested by resident', locale: 'es' });
      return Promise.resolve(assistanceRequest());
    });
    const run = vi.fn((
      _configuration: { readonly encryptionKey: string; readonly timeZone: string },
      work: (service: Pick<AssistanceService, 'create'>) => Promise<AssistanceRequest>,
    ) => work({ create }));
    registerConciergeRuntimeForTest({
      authorize: () => Promise.resolve(session),
      aiAvailability: { enabled: () => Promise.resolve(false) },
      assistance: createPostgresConciergeAssistanceAdapter({
        encryptionKey: () => Buffer.alloc(32, 7).toString('base64'),
        timeZone: () => 'America/New_York',
        run,
      }),
    });

    const started = await startConversation(new Request('http://local/api/v1/concierge/conversations', { method: 'POST' }));
    const conversation = await started.json() as { id: string };
    const request = () => new Request(`http://local/api/v1/concierge/conversations/${conversation.id}/handoff`, { method: 'POST', headers: sameOrigin });
    const context = { params: Promise.resolve({ conversationId: conversation.id }) };
    const [first, second] = await Promise.all([handoff(request(), context), handoff(request(), context)]);
    const repeated = await handoff(request(), context);

    expect([first.status, second.status, repeated.status]).toEqual([201, 201, 201]);
    const expected = {
      id: assistanceId,
      org_id: orgId,
      state: 'pending_unowned',
      summary: 'Concierge handoff requested by resident',
      triage_category: 'general',
      triage_source: 'rules',
      owner_id: null,
      sla_due_at: '2026-09-10T18:00:00.000Z',
      after_hours: false,
    };
    expect(await first.json()).toEqual(expected);
    expect(await second.json()).toEqual(expected);
    expect(await repeated.json()).toEqual(expected);
    expect(run).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1].idempotencyKey).toMatch(/^[0-9a-f-]{36}$/u);
  });
});
