import { describe, expect, it } from 'vitest';
import { AuthService, MemoryAuthStore, RateLimitError } from '../../../packages/auth/src/index.ts';
import { FixedWindowRateLimiter } from '../../../packages/ai/src/index.ts';
import { roles } from '../../../packages/policy/src/index.ts';
import type { Action, ResourceKind } from '../../../packages/policy/src/index.ts';
import { caregiver, fixture, orgId, otherOrg, resident, resourceId } from '../../unit/WP-005/fixture.ts';

const kinds: ResourceKind[] = ['schedule', 'ride', 'alert', 'assistance', 'event', 'profile'];
const actions: Action[] = ['read', 'book', 'manage'];
const direct = new Set(['senior:schedule:read', 'senior:ride:book', 'senior:alert:read',
  'senior:assistance:read', 'senior:event:manage', 'senior:profile:read',
  'staff:schedule:read', 'staff:ride:book', 'staff:assistance:read', 'staff:event:manage',
  'admin:schedule:read', 'admin:ride:book', 'admin:assistance:read', 'admin:event:manage']);

describe('WP-033 exhaustive authorization negatives', () => {
  for (const role of roles) for (const kind of kinds) for (const action of actions) {
    it(`${role} ${kind}.${action}: exact decision and opaque cross-org denial`, async () => {
      const test = fixture();
      const actor = { ...caregiver, id: role === 'senior' ? resident.id : caregiver.id, roles: [role] };
      const own = role === 'senior';
      const request = { actor, decisionActor: actor, orgId, action,
        resource: { id: resourceId, kind, orgId, residentId: own ? actor.id : resident.id } };
      const expected = direct.has(`${role}:${kind}:${action}`);
      const decision = await test.policy.authorize(request);
      expect(decision).toEqual(expected ? { allowed: true } : { allowed: false, status: 404, error: 'not_found' });

      const crossOrg = await test.policy.authorize({ ...request,
        resource: { ...request.resource, orgId: otherOrg } });
      expect(crossOrg).toEqual({ allowed: false, status: 404, error: 'not_found' });
      expect(JSON.stringify(crossOrg)).not.toMatch(new RegExp(`${otherOrg}|${resourceId}`, 'u'));
    });
  }
});

describe('WP-033 identity, IP and organisation rate-limit partitions', () => {
  const pepper = 'wp033-rate-limit-pepper';
  it('partitions authentication request limits by identifier, IP and organisation', async () => {
    const store = new MemoryAuthStore();
    const auth = new AuthService(store, { pepper });
    for (let index = 0; index < 3; index += 1) {
      await expect(auth.requestMagicLink(orgId, 'one@example.invalid', `browser-${index}`, '198.51.100.10')).resolves.toEqual({ accepted: true });
    }
    await expect(auth.requestMagicLink(orgId, 'one@example.invalid', 'browser-4', '198.51.100.11')).rejects.toBeInstanceOf(RateLimitError);
    await expect(auth.requestMagicLink(orgId, 'two@example.invalid', 'browser-5', '198.51.100.11')).resolves.toEqual({ accepted: true });
    await expect(auth.requestMagicLink(otherOrg, 'one@example.invalid', 'browser-6', '198.51.100.10')).resolves.toEqual({ accepted: true });

    const ipStore = new MemoryAuthStore();
    const ipAuth = new AuthService(ipStore, { pepper });
    for (let index = 0; index < 30; index += 1) {
      await ipAuth.requestMagicLink(orgId, `person-${index}@example.invalid`, `nonce-${index}`, '203.0.113.7');
    }
    await expect(ipAuth.requestMagicLink(orgId, 'overflow@example.invalid', 'overflow', '203.0.113.7')).rejects.toBeInstanceOf(RateLimitError);
    await expect(ipAuth.requestMagicLink(otherOrg, 'overflow@example.invalid', 'other-org', '203.0.113.7')).resolves.toEqual({ accepted: true });
  });

  it('partitions AI limits by identity and organisation while enforcing the org aggregate', async () => {
    const limiter = new FixedWindowRateLimiter(2, 3, 60_000, () => 1_000);
    const context = { orgId, userId: resident.id, userRole: 'senior' as const, locale: 'en' as const, requestId: 'wp033' };
    expect((await limiter.consume(context, 'concierge')).allowed).toBe(true);
    expect((await limiter.consume(context, 'concierge')).allowed).toBe(true);
    expect((await limiter.consume(context, 'concierge')).allowed).toBe(false);
    expect((await limiter.consume({ ...context, userId: caregiver.id }, 'concierge')).allowed).toBe(true);
    expect((await limiter.consume({ ...context, userId: resourceId }, 'concierge')).allowed).toBe(false);
    expect((await limiter.consume({ ...context, orgId: otherOrg }, 'concierge')).allowed).toBe(true);
  });
});
