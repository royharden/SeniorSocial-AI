import { describe, expect, it, vi } from 'vitest';
import { ConciergeService, InMemoryConversationStore } from '../../../apps/web/app/concierge/core.ts';
import type { ConciergeAiResult, ConciergeSession, DirectoryRecord } from '../../../apps/web/app/concierge/types.ts';

const orgId = '22222222-2222-4222-8222-222222222222';
const userId = '22222222-2222-4222-8222-222222222201';
const conversationId = '22222222-2222-4222-8222-222222222211';
const handoffKey = '22222222-2222-4222-8222-222222222212';
const serviceId = '22222222-2222-4222-8222-222222222221';
const session: ConciergeSession = { orgId, userId, role: 'senior', locale: 'en', requestId: 'req-integration' };
const record: DirectoryRecord = { id: serviceId, orgId, name: 'Harbor Legal Aid', phone: '555-0188', description: 'Appointments on weekdays.' };

function make(aiResult: ConciergeAiResult) {
  const create = vi.fn(async () => ({ id: '22222222-2222-4222-8222-222222222231', org_id: orgId, state: 'pending_unowned' as const }));
  const concierge = new ConciergeService({
    directory: { search: async () => [record] }, assistance: { create }, ai: { chat: async () => aiResult },
    createId: vi.fn().mockReturnValueOnce(conversationId).mockReturnValueOnce(handoffKey),
  });
  return { concierge, create };
}

describe('WP-011 injected gateway, directory and assistance ports', () => {
  it('uses AI only to select an exact authorized citation and never renders model prose', async () => {
    const { concierge } = make({ outcome: 'ok', text: 'You are approved. SS-CANARY-9F13', citations: [serviceId], toolCalls: [], promptRef: { version: 'v1' } });
    const conversation = await concierge.start(session);
    const answer = await concierge.answer(session, conversation.id, 'legal aid phone number', 'en');
    expect(answer?.citations).toEqual([serviceId]);
    expect(answer?.text).toContain('555-0188');
    expect(answer?.text).not.toContain('approved');
    expect(answer?.text).not.toContain('CANARY');
  });

  it('renders localized unknown when an ok AI result selects no authorized record', async () => {
    const { concierge } = make({ outcome: 'ok', text: 'invented answer', citations: [], toolCalls: [], promptRef: { version: 'v1' } });
    const conversation = await concierge.start({ ...session, locale: 'es' });
    const answer = await concierge.answer({ ...session, locale: 'es' }, conversation.id, 'servicio de comidas', 'es');
    expect(answer?.citations).toEqual([]);
    expect(answer?.text).toContain('No lo sé según los registros autorizados');
    expect(answer?.text).not.toContain('Harbor Legal Aid');
  });

  it('does not turn a model refusal into a native directory listing', async () => {
    const { concierge } = make({ outcome: 'refused', text: '', citations: [], toolCalls: [] });
    const conversation = await concierge.start(session);
    const answer = await concierge.answer(session, conversation.id, 'meal delivery', 'en');
    expect(answer?.citations).toEqual([]);
    expect(answer?.text).toContain("I don't know based on the authorized directory records");
    expect(answer?.text).not.toContain('Harbor Legal Aid');
  });

  it.each(['killed', 'error', 'egress_blocked'] as const)('retains native search when gateway outcome is %s', async outcome => {
    const { concierge } = make({ outcome, text: '', citations: [], toolCalls: [] });
    const conversation = await concierge.start(session);
    const answer = await concierge.answer(session, conversation.id, 'food delivery', 'en');
    expect(answer?.citations).toEqual([serviceId]);
    expect(answer?.text).toContain('Harbor Legal Aid');
    expect((await concierge.get(session, conversation.id))?.ai_enabled).toBe(false);
  });

  it('creates one idempotent assistance request after explicit resident confirmation even concurrently', async () => {
    const { concierge, create } = make({ outcome: 'killed', text: '', citations: [], toolCalls: [] });
    const conversation = await concierge.start(session);
    await concierge.answer(session, conversation.id, 'I need help finding meals', 'en');
    const [first, second] = await Promise.all([concierge.handoff(session, conversation.id), concierge.handoff(session, conversation.id)]);
    expect(first).toEqual(second);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ orgId, actorId: userId, idempotencyKey: handoffKey }));
  });

  it('deduplicates a cross-instance handoff through the shared atomic store and stable key', async () => {
    const store = new InMemoryConversationStore();
    const create = vi.fn(async () => ({ id: '22222222-2222-4222-8222-222222222232', org_id: orgId, state: 'pending_unowned' as const }));
    const ids = vi.fn().mockReturnValueOnce(conversationId).mockReturnValueOnce(handoffKey);
    const options = { directory: { search: async () => [record] }, assistance: { create }, conversations: store };
    const firstService = new ConciergeService({ ...options, createId: ids });
    const secondService = new ConciergeService(options);
    const conversation = await firstService.start(session);
    const [first, second] = await Promise.all([firstService.handoff(session, conversation.id), secondService.handoff(session, conversation.id)]);
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: handoffKey }));
    if (first) (first as { state: string }).state = 'caller-mutated';
    expect((await secondService.handoff(session, conversation.id))?.state).toBe('pending_unowned');
  });

  it('keeps standalone service stores isolated by default', async () => {
    const first = make({ outcome: 'killed', text: '', citations: [], toolCalls: [] }).concierge;
    const second = make({ outcome: 'killed', text: '', citations: [], toolCalls: [] }).concierge;
    const conversation = await first.start(session);

    expect(await second.get(session, conversation.id)).toBeNull();
  });

  it('does not let stale answer or handoff work cross a shared-store reset boundary', async () => {
    const store = new InMemoryConversationStore();
    const oldConversation = {
      id: conversationId, orgId, userId, handoffKey, turns: [], aiEnabled: false, lastQuestion: 'old question',
    };
    await store.create(oldConversation);
    const staleAnswer = await store.get(conversationId);
    if (!staleAnswer) throw new Error('expected old conversation');

    let resolveOldHandoff!: (value: { id: string; org_id: string; state: 'pending_unowned' }) => void;
    const oldHandoff = store.getOrCreateHandoff(conversationId, orgId, userId, () => new Promise(resolve => {
      resolveOldHandoff = resolve;
    }));

    store.clear();
    await store.create({ ...oldConversation, turns: [], lastQuestion: 'new question' });
    staleAnswer.turns.push({
      text: 'stale answer', citations: [], disclaimer: 'stale', human_route: '/assistance', prompt_version: 'test',
    });
    await store.save(staleAnswer);

    let resolveNewHandoff!: (value: { id: string; org_id: string; state: 'pending_unowned' }) => void;
    const newCreate = vi.fn(() => new Promise<{ id: string; org_id: string; state: 'pending_unowned' }>(resolve => {
      resolveNewHandoff = resolve;
    }));
    const newHandoff = store.getOrCreateHandoff(conversationId, orgId, userId, newCreate);
    resolveOldHandoff({ id: '22222222-2222-4222-8222-222222222241', org_id: orgId, state: 'pending_unowned' });
    await oldHandoff;

    const joinedNewHandoff = store.getOrCreateHandoff(conversationId, orgId, userId, newCreate);
    expect(newCreate).toHaveBeenCalledTimes(1);
    resolveNewHandoff({ id: '22222222-2222-4222-8222-222222222242', org_id: orgId, state: 'pending_unowned' });
    expect(await joinedNewHandoff).toEqual(await newHandoff);

    const current = await store.get(conversationId);
    expect(current?.turns).toEqual([]);
    expect(current?.handoff?.id).toBe('22222222-2222-4222-8222-222222222242');
  });

  it('preserves both the answer and handoff when they complete concurrently', async () => {
    let resolveDirectory!: (value: DirectoryRecord[]) => void;
    const search = vi.fn(() => new Promise<DirectoryRecord[]>(resolve => { resolveDirectory = resolve; }));
    const create = vi.fn(async () => ({
      id: '22222222-2222-4222-8222-222222222251', org_id: orgId, state: 'pending_unowned' as const,
    }));
    const concierge = new ConciergeService({
      directory: { search }, assistance: { create },
      createId: vi.fn().mockReturnValueOnce(conversationId).mockReturnValueOnce(handoffKey),
    });
    const conversation = await concierge.start(session);

    const answer = concierge.answer(session, conversation.id, 'food delivery', 'en');
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    const handoff = await concierge.handoff(session, conversation.id);
    resolveDirectory([record]);
    await answer;

    expect((await concierge.get(session, conversation.id))?.turns).toHaveLength(1);
    expect((await concierge.handoff(session, conversation.id))?.id).toBe(handoff?.id);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
