import { createIntakeService, MemoryIntakeRepository, type Actor, type IntakeInput } from '../../../packages/intake/src/index';

export const resident: Actor = { id: '20000000-0000-4000-8000-000000000001', orgId: '30000000-0000-4000-8000-000000000001', roles: ['senior'] };
export const otherOrg: Actor = { ...resident, orgId: '30000000-0000-4000-8000-000000000002' };
export const legalDraft: IntakeInput = { answers: { topic: 'housing', summary: 'A private narrative.' },
  disclaimerAcknowledged: false, locale: 'en', intent: 'save_draft' };

export function fixture() {
  const repository = new MemoryIntakeRepository();
  const service = createIntakeService({ repository, authorization: {
    canManage: (actor, residentId) => Promise.resolve(actor.id === residentId && actor.roles.includes('senior')),
  }, now: () => '2026-09-11T02:00:00.000Z' });
  return { repository, service };
}
