import { describe, expect, it, vi } from 'vitest';
import { createPolicy, scopeRules } from '../../../packages/policy/src/index.ts';
import { caregiver, change, fixture, orgId, resident, resourceId } from './fixture.ts';

describe('WP-005 consent decisions', () => {
  // what_bug_this_catches: a cached authorization survives revocation or removes unrelated scopes.
  it('revokes one scope on the next request while preserving another scope', async () => {
    const f = fixture();
    const access = (scope: 'view_schedule' | 'book_rides') => f.policy.authorize({ actor: caregiver,
      decisionActor: resident, orgId, actingForResidentId: resident.id, action: scopeRules[scope].action,
      resource: { id: resourceId, orgId, residentId: resident.id, kind: scopeRules[scope].resource } });
    expect(await f.policy.grant(change('view_schedule', 0))).toMatchObject({ allowed: true, version: 1 });
    expect(await f.policy.grant(change('book_rides', 1))).toMatchObject({ allowed: true, version: 2 });
    expect(await access('view_schedule')).toEqual({ allowed: true });
    expect(await f.policy.revoke(change('view_schedule', 2))).toMatchObject({ allowed: true, version: 3 });
    expect(await access('view_schedule')).toEqual({ allowed: false, status: 404, error: 'not_found' });
    expect(await access('book_rides')).toEqual({ allowed: true });
    expect(f.reads()).toBe(3);
    expect(f.history.map(h => [h.entryActorId, h.decisionActorId])).toEqual(
      Array.from({ length: 3 }, () => [change('book_rides', 0).actor.id, resident.id]));
  });

  // what_bug_this_catches: a queued older grant recreates authority after revocation.
  it('rejects stale grants, unconfirmed read-back and grantee self-grants', async () => {
    const f = fixture();
    await f.policy.grant(change('view_profile', 0));
    await f.policy.revoke(change('view_profile', 1));
    expect(await f.policy.grant(change('view_profile', 0))).toMatchObject({ allowed: false });
    expect(await f.policy.grant({ ...change('view_profile', 2), readBackConfirmed: false })).toMatchObject({ allowed: false });
    expect(await f.policy.grant({ ...change('view_profile', 2), actor: caregiver })).toMatchObject({ allowed: false });
    expect(f.history).toHaveLength(2);
  });

  // what_bug_this_catches: expiry is checked only at grant time.
  it('checks expiration on each access and refuses already expired grants', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-09-10T12:00:00Z'));
      const f = fixture();
      expect(await f.policy.grant({ ...change('view_profile', 0), expiresAt: new Date('2026-09-10T11:00:00Z') })).toMatchObject({ allowed: false });
      await f.policy.grant({ ...change('view_profile', 0), expiresAt: new Date('2026-09-10T12:01:00Z') });
      vi.setSystemTime(new Date('2026-09-10T12:01:00Z'));
      expect(await f.policy.authorize({ actor: caregiver, decisionActor: resident, orgId,
        actingForResidentId: resident.id, action: 'read', resource: { id: resourceId,
          orgId, residentId: resident.id, kind: 'profile' } })).toMatchObject({ allowed: false });
    } finally { vi.useRealTimers(); }
  });

  // what_bug_this_catches: an audit write failure is swallowed and reported as a successful consent change.
  it('emits only after commit and propagates audit failures', async () => {
    const f = fixture();
    const policy = createPolicy(f.store, { emit: () => {
      expect(f.history).toHaveLength(1);
      return Promise.reject(new Error('audit unavailable'));
    } });
    await expect(policy.grant(change('book_rides', 0))).rejects.toThrow('audit unavailable');
    expect(f.history).toHaveLength(1);
  });

  // what_bug_this_catches: self-service consent is incorrectly labelled as acting for someone else.
  it('records null on_behalf_of for resident self-entry and the resident for operator entry', async () => {
    for (const selfEntry of [true, false]) {
      const f = fixture();
      const command = { ...change('book_rides', 0),
        actor: selfEntry ? resident : change('book_rides', 0).actor };
      expect(await f.policy.grant(command)).toMatchObject({ allowed: true });
      expect(await f.policy.revoke({ ...command, expectedVersion: 1 })).toMatchObject({ allowed: true });
      expect(f.intents.map(intent => intent.on_behalf_of)).toEqual(
        [selfEntry ? null : `user:${resident.id}`, selfEntry ? null : `user:${resident.id}`]);
      expect(f.history.every(row => row.entryActorId === command.actor.id && row.decisionActorId === resident.id)).toBe(true);
    }
  });
});
