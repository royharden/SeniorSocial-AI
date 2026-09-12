import { describe, expect, it } from 'vitest';
import { roles, scopeRules } from '../../../packages/policy/src/index.ts';
import type { AccessRequest, Action, ResourceKind, Scope } from '../../../packages/policy/src/index.ts';
import { caregiver, change, fixture, orgId, otherOrg, resident, resourceId } from '../../unit/WP-005/fixture.ts';

const kinds: ResourceKind[] = ['schedule', 'ride', 'alert', 'assistance', 'event', 'profile'];
const actions: Action[] = ['read', 'book', 'manage'];
const validPairs = new Set(['schedule:read', 'ride:book', 'alert:read', 'assistance:read', 'event:manage', 'profile:read']);
describe('WP-005 exhaustive role × resource × action matrix', () => {
  for (const role of roles) for (const kind of kinds) for (const action of actions) {
    for (const own of [false, true]) {
      // what_bug_this_catches: wildcard role grants, unsupported actions and missing ownership checks.
      it(`${role} ${kind}.${action} ${own ? 'own' : 'other resident'}`, async () => {
        const f = fixture();
        const actor = { ...caregiver, roles: [role] };
        const allowed = validPairs.has(`${kind}:${action}`) && ((role === 'senior' && own)
          || (['staff', 'admin'].includes(role) && ['schedule', 'ride', 'assistance', 'event'].includes(kind)));
        const result = await f.policy.authorize({ actor, decisionActor: actor, orgId, action,
          resource: { id: resourceId, kind, orgId, residentId: own ? actor.id : resident.id } });
        expect(result.allowed).toBe(allowed);
      });
    }
    // what_bug_this_catches: any role bypasses organisation isolation or reveals existence.
    it(`${role} ${kind}.${action} cross-org is indistinguishable`, async () => {
      const f = fixture();
      const actor = { ...caregiver, roles: [role] };
      expect(await f.policy.authorize({ actor, decisionActor: actor, orgId, action,
        resource: { id: resourceId, orgId: otherOrg, residentId: resident.id, kind } }))
        .toEqual({ allowed: false, status: 404, error: 'not_found' });
      const serialized = JSON.stringify({ decisions: f.decisions, intents: f.intents });
      for (const hidden of [otherOrg, resident.id, resourceId]) expect(serialized).not.toContain(hidden);
      expect(f.reads()).toBe(0);
    });
  }

  for (const scope of Object.keys(scopeRules) as Scope[]) {
    // what_bug_this_catches: one granted consent implicitly grants another resource or action.
    it(`${scope} grants exactly its own action and resource`, async () => {
      const f = fixture();
      await f.policy.grant(change(scope, 0));
      for (const kind of kinds) for (const action of actions) {
        const result = await f.policy.authorize({ actor: caregiver, decisionActor: resident,
          orgId, actingForResidentId: resident.id, action, resource: { id: resourceId, orgId, residentId: resident.id, kind } });
        expect(result.allowed).toBe(kind === scopeRules[scope].resource && action === scopeRules[scope].action);
      }
    });
  }

  it('cannot use operator roles to bypass delegated consent or substitute another resident', async () => {
    const f = fixture();
    await f.policy.grant(change('book_rides', 0));
    for (const actor of [{ ...caregiver, roles: ['admin'] as const }, caregiver]) {
      expect(await f.policy.authorize({ actor, decisionActor: resident, orgId,
        actingForResidentId: resourceId, action: 'book', resource: { id: resourceId, orgId, residentId: resident.id, kind: 'ride' } }))
        .toMatchObject({ allowed: false });
    }
  });

  it('denies unknown runtime roles, resources, actions and a mismatched decision actor', async () => {
    const f = fixture();
    const base: AccessRequest = { actor: resident, decisionActor: resident, orgId, action: 'read',
      resource: { id: resourceId, orgId, residentId: resident.id, kind: 'profile' } };
    const invalid = [
      { ...base, actor: { ...resident, roles: ['superadmin'] } },
      { ...base, resource: { ...base.resource, kind: 'messages' } },
      { ...base, action: 'delete' },
      { ...base, decisionActor: caregiver },
      { ...base, actor: { ...resident, roles: [] } },
    ];
    for (const request of invalid) {
      expect(await f.policy.authorize(request as AccessRequest)).toEqual({ allowed: false, status: 404, error: 'not_found' });
    }
    expect(f.reads()).toBe(0);
  });
});
