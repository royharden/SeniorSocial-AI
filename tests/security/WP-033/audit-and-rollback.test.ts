import { describe, expect, it } from 'vitest';
import { validateAuditInput } from '../../../packages/audit/src/index.ts';
import { MemoryCaregiverRepository, createCaregiverService } from '../../../packages/caregiver/src/index.ts';
import type { CaregiverRepository, InvitationDeliveryPort } from '../../../packages/caregiver/src/index.ts';

const orgId = '10000000-0000-4000-8000-000000000001';
const residentId = '10000000-0000-4000-8000-000000000011';
const caregiverId = '10000000-0000-4000-8000-000000000021';
const invitationId = '10000000-0000-4000-8000-000000000031';
const rawToken = 'wp033_invitation_token_1234567890_SAFE';

describe('WP-033 audit minimization', () => {
  const base = { actor: `user:${residentId}`, action: 'service.updated' as const,
    target: 'service:directory-entry', org_id: orgId, outcome: 'allowed' as const };

  it('accepts field names while rejecting narrative, contact, and assignment values in fields[]', () => {
    expect(() => validateAuditInput({ ...base, fields: ['description', 'name_en', 'phone'] })).not.toThrow();
    for (const leaked of ['Resident asked for housing help', 'person@example.invalid', 'phone=+15550199', 'street_address: 12 Main']) {
      expect(() => validateAuditInput({ ...base, fields: [leaked] })).toThrow('invalid audit field name');
    }
  });

  it('rejects duplicate, multiline and oversized metadata rather than normalizing leaked content', () => {
    expect(() => validateAuditInput({ ...base, fields: ['phone', 'phone'] })).toThrow('must be unique');
    expect(() => validateAuditInput({ ...base, outcome: 'denied', reason: 'policy_denied\nresident narrative' })).toThrow('one line');
    expect(() => validateAuditInput({ ...base, outcome: 'denied', reason: 'x'.repeat(501) })).toThrow('at most 500');
  });
});

describe('WP-033 WP-017 invitation rollback regression', () => {
  it('leaves a ghost delivery token unusable when the following atomic transaction fails', async () => {
    const backing = new MemoryCaregiverRepository({ [caregiverId]: ['helper@example.invalid'] });
    let forceAuditFailure = true;
    const repository: CaregiverRepository = { transaction: (tenant, work) => backing.transaction(tenant, async transaction => {
      const result = await work({ ...transaction, appendAudit: async event => {
        if (forceAuditFailure) throw new Error('forced audit failure');
        return transaction.appendAudit(event);
      } });
      return result;
    }) };
    const captures: Parameters<InvitationDeliveryPort['enqueue']>[1][] = [];
    const delivery: InvitationDeliveryPort = { enqueue: (_identity, request) => {
      captures.push(structuredClone(request));
      return Promise.resolve({ status: 'pending', synthetic: true });
    } };
    const service = createCaregiverService({ repository, delivery,
      recipientDigestKey: 'wp033-recipient-digest-key-at-least-32', token: () => rawToken,
      id: () => invitationId, clock: () => new Date('2026-09-11T12:00:00Z') });
    const resident = { orgId, userId: residentId, roles: ['senior'] as const };
    const caregiver = { orgId, userId: caregiverId, roles: ['caregiver'] as const };

    await expect(service.invite(resident, { email_or_phone: 'helper@example.invalid' })).rejects.toThrow('forced audit failure');
    expect(captures[0]?.params.invitation_token).toBe(rawToken);
    expect(backing.snapshot().invitations).toEqual([]);
    forceAuditFailure = false;
    await expect(service.accept(caregiver, rawToken)).rejects.toMatchObject({ status: 404, code: 'not_found' });
  });
});
