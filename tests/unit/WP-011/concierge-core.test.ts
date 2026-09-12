import { describe, expect, it, vi } from 'vitest';
import { ConciergeService } from '../../../apps/web/app/concierge/core.ts';
import type { ConciergeSession } from '../../../apps/web/app/concierge/types.ts';

const orgId = '11111111-1111-4111-8111-111111111111';
const userId = '11111111-1111-4111-8111-111111111101';
const conversationId = '11111111-1111-4111-8111-111111111201';
const handoffKey = '11111111-1111-4111-8111-111111111202';
const session: ConciergeSession = { orgId, userId, role: 'senior', locale: 'en', requestId: 'req-unit' };

function service() {
  const search = vi.fn(async () => []);
  const chat = vi.fn(async () => ({ outcome: 'ok' as const, text: 'unsafe free text', citations: [], toolCalls: [] }));
  const instance = new ConciergeService({
    directory: { search }, assistance: { create: async () => ({ id: handoffKey, org_id: orgId, state: 'pending_unowned' }) }, ai: { chat },
    createId: vi.fn().mockReturnValueOnce(conversationId).mockReturnValueOnce(handoffKey),
  });
  return { instance, search, chat };
}

describe('WP-011 deterministic concierge policy', () => {
  it.each([
    'Do I have diabetes?', 'Is my rash shingles?', 'Should I sign this legal notice?', 'Can I sue my landlord?',
    'Am I definitely eligible?', 'Do I qualify for Medicaid?', 'Dispatch an ambulance for me', 'Get me an ambulance',
    '¿Tengo diabetes?', '¿Es mi sarpullido culebrilla?', '¿Debo firmar este aviso legal?', '¿Puedo demandar a mi casero?',
    '¿Soy elegible?', '¿Califico para Medicaid?', 'Envíame una ambulancia', 'Consígueme una ambulancia',
  ])('refuses normalized EN/ES prohibited-authority paraphrase: %s', async question => {
    const { instance, search, chat } = service();
    const conversation = await instance.start(session);
    const answer = await instance.answer(session, conversation.id, question, 'en');
    expect(answer).toMatchObject({ refused: true, citations: [], human_route: '/assistance', prompt_version: 'deterministic-v1' });
    expect(answer?.text).toContain('cannot diagnose');
    expect(search).not.toHaveBeenCalled();
    expect(chat).not.toHaveBeenCalled();
  });

  it.each(['shingles clinic', 'tenant legal aid directory', 'Medicaid eligibility counselor', 'ambulance transport information'])(
    'does not refuse an obvious benign directory query: %s', async question => {
      const { instance, search } = service();
      const conversation = await instance.start(session);
      const answer = await instance.answer(session, conversation.id, question, 'en');
      expect(answer?.refused).not.toBe(true);
      expect(search).toHaveBeenCalledOnce();
    },
  );

  it('uses deterministic Spanish refusal and honest unknown copy', async () => {
    const { instance } = service();
    const conversation = await instance.start({ ...session, locale: 'es' });
    const refusal = await instance.answer({ ...session, locale: 'es' }, conversation.id, '¿Debo firmar este aviso legal?', 'es');
    expect(refusal?.text).toContain('no puedo diagnosticar');
    expect(refusal?.disclaimer).toContain('directorio puede cambiar');
  });

  it('reports actual injected AI availability and fails closed on a flag-read error', async () => {
    const create = (enabled: () => Promise<boolean>) => new ConciergeService({
      directory: { search: async () => [] },
      assistance: { create: async () => ({ id: handoffKey, org_id: orgId, state: 'pending_unowned' }) },
      ai: { chat: async () => ({ outcome: 'ok', text: '', citations: [], toolCalls: [] }) },
      aiAvailability: { enabled },
      createId: vi.fn().mockReturnValueOnce(conversationId).mockReturnValueOnce(handoffKey),
    });
    expect((await create(async () => true).start(session)).ai_enabled).toBe(true);
    expect((await create(async () => false).start(session)).ai_enabled).toBe(false);
    expect((await create(async () => { throw new Error('flag store unavailable'); }).start(session)).ai_enabled).toBe(false);
  });
});
