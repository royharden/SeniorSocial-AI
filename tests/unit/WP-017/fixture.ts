import {
  MemoryCaregiverRepository, createCaregiverService, type InvitationDeliveryPort, type SessionIdentity,
} from '../../../packages/caregiver/src/index.ts';

export const orgA = '10000000-0000-4000-8000-000000000001';
export const orgB = '20000000-0000-4000-8000-000000000002';
export const resident: SessionIdentity = { orgId: orgA, userId: '10000000-0000-4000-8000-000000000011', roles: ['senior'] };
export const otherResident: SessionIdentity = { orgId: orgA, userId: '10000000-0000-4000-8000-000000000012', roles: ['senior'] };
export const caregiver: SessionIdentity = { orgId: orgA, userId: '10000000-0000-4000-8000-000000000021', roles: ['caregiver'] };
export const wrongCaregiver: SessionIdentity = { orgId: orgA, userId: '10000000-0000-4000-8000-000000000022', roles: ['caregiver'] };
export const crossOrgCaregiver: SessionIdentity = { orgId: orgB, userId: '20000000-0000-4000-8000-000000000021', roles: ['caregiver'] };
export const invitationId = '10000000-0000-4000-8000-000000000031';
export const linkId = '10000000-0000-4000-8000-000000000032';
export const rawToken = 'caregiver_invitation_token_1234567890_SAFE';
export const now = new Date('2026-09-11T12:00:00.000Z');

export function fixture(recipientDigestKey = 'synthetic-test-key-at-least-32-characters', deliveryOverride?: InvitationDeliveryPort) {
  const repository = new MemoryCaregiverRepository({
    [caregiver.userId]: ['helper@example.invalid'], [wrongCaregiver.userId]: ['wrong@example.invalid'],
    [crossOrgCaregiver.userId]: ['helper@example.invalid'],
  });
  const deliveries: Parameters<InvitationDeliveryPort['enqueue']>[1][] = [];
  const delivery: InvitationDeliveryPort = { enqueue: async (_identity, request) => {
    deliveries.push(structuredClone(request)); return { status: 'pending', synthetic: true };
  } };
  const ids = [invitationId, linkId];
  let current = new Date(now);
  const service = createCaregiverService({ repository, delivery: deliveryOverride ?? delivery, clock: () => new Date(current), token: () => rawToken,
    id: () => ids.shift() ?? '10000000-0000-4000-8000-000000000099', recipientDigestKey });
  return { repository, deliveries, service, setNow: (value: Date) => { current = new Date(value); } };
}

export async function acceptedFixture() {
  const result = fixture();
  await result.service.invite(resident, { email_or_phone: 'HELPER@example.invalid', relationship_note: 'Friend' });
  const link = await result.service.accept(caregiver, rawToken);
  return { ...result, link };
}
