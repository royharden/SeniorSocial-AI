import { describe, expect, it } from 'vitest';
import { createInviteCaregiverHandler } from '../../../apps/web/app/api/v1/caregiver/invitations/route.ts';
import { createAcceptCaregiverInvitationHandler } from '../../../apps/web/app/api/v1/caregiver/invitations/[token]/accept/route.ts';
import { createSetConsentScopesHandler } from '../../../apps/web/app/api/v1/caregiver/links/[linkId]/scopes/route.ts';
import { createRevokeCaregiverLinkHandler } from '../../../apps/web/app/api/v1/caregiver/links/[linkId]/route.ts';
import {
  closeCaregiverRuntimeForTests, runtimeDependencies, setCaregiverRepositoryForTests,
} from '../../../apps/web/app/api/v1/caregiver/_runtime.ts';
import { acceptedFixture, caregiver, crossOrgCaregiver, fixture, linkId, now, rawToken, resident, wrongCaregiver } from '../../unit/WP-017/fixture.ts';

describe('WP-017 route to transaction integration', () => {
  it('runs invite, recipient-bound activation, item read-back and revocation through contract routes', async () => {
    // what_bug_this_catches: route serialization bypasses trusted session identity or changes WP-002 status codes.
    const test = fixture(); let actor = resident;
    const dependencies = { authorize: async () => actor, service: test.service };
    const invite = await createInviteCaregiverHandler(dependencies)(new Request('http://local/api/v1/caregiver/invitations', {
      method: 'POST', body: JSON.stringify({ email_or_phone: 'helper@example.invalid' }), headers: { 'content-type': 'application/json' },
    }));
    expect(invite.status).toBe(201); expect(await invite.json()).toEqual({ id: expect.any(String), expires_at: '2026-09-12T12:00:00.000Z' });
    actor = caregiver;
    const accepted = await createAcceptCaregiverInvitationHandler(dependencies)(new Request('http://local'), { params: Promise.resolve({ token: rawToken }) });
    expect(accepted.status).toBe(200); expect((await accepted.json() as { state: string }).state).toBe('pending');
    actor = resident;
    const scoped = await createSetConsentScopesHandler(dependencies)(new Request('http://local', { method: 'PUT',
      body: JSON.stringify({ scopes: [{ key: 'view_assistance', granted: true }], read_back_confirmed: true }) }),
    { params: Promise.resolve({ linkId }) });
    expect(scoped.status).toBe(200);
    const revoked = await createRevokeCaregiverLinkHandler(dependencies)(new Request('http://local', { method: 'DELETE' }),
      { params: Promise.resolve({ linkId }) });
    expect(revoked.status).toBe(204);
    expect(test.repository.snapshot().audits.at(-1)).toMatchObject({ action: 'consent.revoked', grantorId: resident.userId,
      caregiverId: caregiver.userId, resource: 'assistance', resourceAction: 'read', actorId: resident.userId });
  });

  it('keeps recipient and tenant mismatches opaque while exposing expiry only to the bound recipient', async () => {
    // what_bug_this_catches: the HTTP adapter turns service denials into distinguishable or detail-bearing responses.
    for (const actor of [wrongCaregiver, crossOrgCaregiver]) {
      const test = fixture(); await test.service.invite(resident, { email_or_phone: 'helper@example.invalid', relationship_note: 'Neighbor' });
      const response = await createAcceptCaregiverInvitationHandler({ authorize: async () => actor, service: test.service })
        (new Request('http://local'), { params: Promise.resolve({ token: rawToken }) });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ type: 'about:blank', title: 'Not Found', status: 404, detail: 'not_found' });
    }
    const expired = fixture(); await expired.service.invite(resident, { email_or_phone: 'helper@example.invalid' });
    expired.setNow(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    const response = await createAcceptCaregiverInvitationHandler({ authorize: async () => caregiver, service: expired.service })
      (new Request('http://local'), { params: Promise.resolve({ token: rawToken }) });
    expect(response.status).toBe(410);
    expect(await response.json()).toMatchObject({ status: 410, detail: 'invitation_expired' });
  });

  it('saves scopes through the production service composition without invitation-only configuration', async () => {
    // what_bug_this_catches: scope saves return caregiver_unavailable when Mailpit or the recipient HMAC key is absent.
    const test = await acceptedFixture();
    const previousKey = process.env.CAREGIVER_RECIPIENT_HMAC_KEY;
    const previousMailpit = process.env.MAILPIT_URL;
    delete process.env.MAILPIT_URL;
    try {
      const dependencies = { authorize: async () => resident, service: runtimeDependencies.service };
      for (const recipientKey of [undefined, 'configured-recipient-hmac-key-at-least-32']) {
        if (recipientKey === undefined) delete process.env.CAREGIVER_RECIPIENT_HMAC_KEY;
        else process.env.CAREGIVER_RECIPIENT_HMAC_KEY = recipientKey;
        setCaregiverRepositoryForTests(test.repository);
        const response = await createSetConsentScopesHandler(dependencies)(new Request('http://local', {
          method: 'PUT', body: JSON.stringify({ scopes: [{ key: 'view_schedule', granted: true }], read_back_confirmed: true }),
        }), { params: Promise.resolve({ linkId }) });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ state: 'active', scopes: expect.arrayContaining([
          { key: 'view_schedule', granted: true, granted_at: expect.any(String) },
        ]) });

        const invitation = await createInviteCaregiverHandler(dependencies)(new Request('http://local', {
          method: 'POST', body: JSON.stringify({ email_or_phone: 'helper@example.invalid' }),
        }));
        expect(invitation.status).toBe(503);
        expect(await invitation.json()).toMatchObject({ detail: 'caregiver_unavailable' });
      }
    } finally {
      await closeCaregiverRuntimeForTests();
      if (previousKey === undefined) delete process.env.CAREGIVER_RECIPIENT_HMAC_KEY;
      else process.env.CAREGIVER_RECIPIENT_HMAC_KEY = previousKey;
      if (previousMailpit === undefined) delete process.env.MAILPIT_URL;
      else process.env.MAILPIT_URL = previousMailpit;
    }
  });
});
