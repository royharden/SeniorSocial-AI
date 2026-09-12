import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { acceptedFixture, caregiver, crossOrgCaregiver, fixture, linkId, rawToken, resident, wrongCaregiver } from '../../unit/WP-017/fixture.ts';

describe('WP-017 security boundaries', () => {
  it('hardens the database with digest-only invitations, fixed expiry and tenant RLS', () => {
    // what_bug_this_catches: an application-only check leaves raw tokens, variable TTL, event grants, or cross-org rows available below it.
    const migration = readFileSync(new URL('../../../packages/db/migrations/0110_wp-017_caregiver_invitations.sql', import.meta.url), 'utf8');
    expect(migration).not.toMatch(/\b(raw_token|invitation_token)\b/iu);
    expect(migration).toContain("expires_at = created_at + interval '24 hours'");
    expect(migration).toContain("CHECK (scope <> 'manage_events')");
    expect(migration).toContain("char_length(relationship_note) BETWEEN 1 AND 500");
    expect(migration).toMatch(/UPDATE caregiver_links l SET state = 'active'[\s\S]*s\.revoked_at IS NULL/u);
    expect(migration.match(/FORCE ROW LEVEL SECURITY/gu)).toHaveLength(2);
  });

  it('returns the same opaque denial for a wrong recipient and cross-org token replay', async () => {
    // what_bug_this_catches: token possession reveals a resident, organization, recipient, or relationship note.
    for (const actor of [wrongCaregiver, crossOrgCaregiver]) {
      const test = fixture(); await test.service.invite(resident, { email_or_phone: 'helper@example.invalid', relationship_note: 'Neighbor' });
      const error = await test.service.accept(actor, rawToken).catch((reason: unknown) => reason);
      expect(error).toMatchObject({ status: 404, code: 'not_found' });
      expect(JSON.stringify(error)).not.toMatch(/Neighbor|helper@|resident|organization/iu);
    }
  });

  it('rejects self-asserted legal roles, caregiver sub-grants, and another resident changing scopes', async () => {
    // what_bug_this_catches: a kinship or guardian claim becomes an authorization shortcut.
    const test = await acceptedFixture();
    const assertedGuardian = { ...caregiver, roles: ['caregiver', 'admin'] as const };
    await expect(test.service.setScopes(assertedGuardian, linkId, { read_back_confirmed: true,
      scopes: [{ key: 'view_profile', granted: true }] })).rejects.toMatchObject({ status: 404 });
    const anotherResident = { ...resident, userId: '10000000-0000-4000-8000-000000000012' };
    await expect(test.service.setScopes(anotherResident, linkId, { read_back_confirmed: true,
      scopes: [{ key: 'view_profile', granted: true }] })).rejects.toMatchObject({ status: 404 });
  });

  it('rechecks committed state on every request so revocation is immediate', async () => {
    // what_bug_this_catches: cached caregiver authority remains usable after the resident revokes it.
    const test = await acceptedFixture();
    await test.service.setScopes(resident, linkId, { read_back_confirmed: true, scopes: [{ key: 'view_schedule', granted: true }] });
    expect(await test.service.authorize(caregiver, { linkId, residentId: resident.userId, resource: 'schedule', action: 'read' })).toBe(true);
    await test.service.revoke(resident, linkId);
    expect(await test.service.authorize(caregiver, { linkId, residentId: resident.userId, resource: 'schedule', action: 'read' })).toBe(false);
  });
});
