import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CaregiverProblem } from '../../../packages/caregiver/src/index.ts';
import { acceptedFixture, caregiver, fixture, linkId, now, rawToken, resident } from './fixture.ts';

describe('WP-017 caregiver invitation and consent', () => {
  it('stores only token and recipient digests and uses a deterministic 24-hour expiry', async () => {
    // what_bug_this_catches: a database snapshot or log exposes a reusable invitation token.
    const test = fixture();
    const invitation = await test.service.invite(resident, { email_or_phone: 'HELPER@example.invalid', relationship_note: 'Neighbor' });
    expect(invitation).toEqual({ id: expect.any(String), expires_at: '2026-09-12T12:00:00.000Z' });
    expect(test.deliveries[0]?.params.invitation_token).toBe(rawToken);
    expect(JSON.stringify(test.repository.snapshot())).not.toContain(rawToken);
    expect(test.repository.snapshot().invitations[0]?.tokenDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(test.repository.snapshot().invitations[0]?.recipientDigest)
      .not.toBe(createHash('sha256').update('helper@example.invalid').digest('hex'));
    expect(test.repository.snapshot().invitations[0]?.relationshipNote).toBe('Neighbor');
    expect(() => fixture('short-secret')).toThrow(/at least 32 characters/u);
  });

  it('persists no invitation or audit when local capture is not accepted', async () => {
    // what_bug_this_catches: an unusable invitation commits before its only synthetic delivery seam fails.
    const test = fixture('synthetic-test-key-at-least-32-characters', {
      enqueue: async () => { throw new Error('Mailpit unavailable'); },
    });
    await expect(test.service.invite(resident, { email_or_phone: 'helper@example.invalid' })).rejects.toThrow(/Mailpit unavailable/u);
    expect(test.repository.snapshot().invitations).toHaveLength(0);
    expect(test.repository.snapshot().audits).toHaveLength(0);
  });

  it('accepts an invitation exactly once when the same token is presented concurrently', async () => {
    // what_bug_this_catches: two requests read an unused invitation before either commits and both create caregiver links.
    const test = fixture(); await test.service.invite(resident, { email_or_phone: 'helper@example.invalid' });
    const attempts = await Promise.allSettled([test.service.accept(caregiver, rawToken), test.service.accept(caregiver, rawToken)]);
    expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter(result => result.status === 'rejected')).toEqual([
      expect.objectContaining({ reason: expect.objectContaining({ status: 404, code: 'not_found' }) }),
    ]);
    expect(test.repository.snapshot().links).toHaveLength(1);
    expect(test.repository.snapshot().invitations[0]).toMatchObject({ acceptedAt: expect.any(Date), caregiverId: caregiver.userId });
  });

  it('grants only exact confirmed items and treats false or omitted items as denied', async () => {
    // what_bug_this_catches: bundled or unchecked scopes silently become caregiver authority.
    const test = await acceptedFixture();
    const link = await test.service.setScopes(resident, linkId, { read_back_confirmed: true, scopes: [
      { key: 'view_schedule', granted: true }, { key: 'book_rides', granted: false },
    ] });
    expect(link.scopes.find(scope => scope.key === 'view_schedule')?.granted).toBe(true);
    expect(link.scopes.find(scope => scope.key === 'book_rides')?.granted).toBe(false);
    expect(link.scopes.find(scope => scope.key === 'view_profile')?.granted).toBe(false);
    await expect(test.service.setScopes(resident, linkId, { read_back_confirmed: false,
      scopes: [{ key: 'view_profile', granted: true }] })).rejects.toEqual(expect.objectContaining<Partial<CaregiverProblem>>({ status: 404 }));
    expect(await test.service.authorize(caregiver, { linkId, residentId: resident.userId, resource: 'schedule', action: 'read' })).toBe(true);
    expect(await test.service.authorize(caregiver, { linkId, residentId: resident.userId, resource: 'ride', action: 'book' })).toBe(false);
    const confirmedCount = test.repository.snapshot().readBacks.length;
    await test.service.setScopes(resident, linkId, { read_back_confirmed: false, scopes: [{ key: 'view_schedule', granted: false }] });
    expect(test.repository.snapshot().readBacks).toHaveLength(confirmedCount);
    expect(await test.service.authorize(caregiver, { linkId, residentId: resident.userId, resource: 'schedule', action: 'read' })).toBe(false);
  });

  it('rejects event delegation even though the immutable schema retains its key', async () => {
    // what_bug_this_catches: the legacy manage_events enum accidentally activates event authority.
    const test = await acceptedFixture();
    await expect(test.service.setScopes(resident, linkId, { read_back_confirmed: true,
      scopes: [{ key: 'manage_events', granted: true }] })).rejects.toEqual(expect.objectContaining({ status: 404 }));
    expect(test.repository.snapshot().links[0]?.state).toBe('pending');
  });

  it('expires at the exact server boundary', async () => {
    const test = fixture(); await test.service.invite(resident, { email_or_phone: 'helper@example.invalid' });
    test.setNow(new Date(now.getTime() + 24 * 60 * 60 * 1000));
    await expect(test.service.accept(caregiver, rawToken)).rejects.toEqual(expect.objectContaining({ status: 410, code: 'invitation_expired' }));
  });
});
