export * from './types.ts';
export * from './repository.ts';
export * from './postgres.ts';

import { roles, scopeRules } from './types.ts';
import type { AccessRequest, Actor, AuditSink, Authorization, ConsentChange, ConsentStore, Scope } from './types.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const denied = { allowed: false, status: 404, error: 'not_found' } as const;
const validActor = (actor: Actor) => uuid.test(actor.id) && uuid.test(actor.orgId)
  && actor.roles.length > 0 && actor.roles.every(role => roles.includes(role));
const isOperator = (actor: Actor) => actor.roles.includes('staff') || actor.roles.includes('admin');

export class ConsentConflict extends Error {
  constructor() { super('Consent changed; repeat the resident read-back.'); }
}

/** Server-only policy boundary. No fallback identities or browser trust. */
export function createPolicy(store: ConsentStore, audit: AuditSink) {
  async function deny(actor: Actor): Promise<typeof denied> {
    // Deliberately do not propagate target org, resource, resident, or decision actor.
    await store.recordDecision({ orgId: actor.orgId, entryActorId: actor.id,
      decisionActorId: actor.id, outcome: 'denied', reason: 'policy_denied' });
    await audit.emit({ actor: `user:${actor.id}`, on_behalf_of: null,
      action: 'caregiver.denied', target: 'policy:authorization', org_id: actor.orgId,
      outcome: 'denied', reason: 'policy_denied' });
    return denied;
  }

  async function authorize(request: AccessRequest): Promise<Authorization> {
    const { actor, decisionActor, orgId, resource, action, actingForResidentId } = request;
    if (!validActor(actor)) return denied; // No authenticated audit identity exists.
    if (!validActor(decisionActor) || actor.orgId !== orgId || resource.orgId !== orgId
      || decisionActor.orgId !== orgId || !uuid.test(resource.id) || !uuid.test(resource.residentId)) return deny(actor);
    const scope = (Object.keys(scopeRules) as Scope[]).find(key =>
      scopeRules[key].resource === resource.kind && scopeRules[key].action === action);
    if (!scope) return deny(actor);

    let allowed = false;
    if (actingForResidentId !== undefined) {
      // Staff/admin identities cannot turn a delegated request into an override.
      if (actor.roles.includes('caregiver') && actingForResidentId === resource.residentId
        && decisionActor.id === actingForResidentId && decisionActor.roles.includes('senior')
        && actor.id !== actingForResidentId) {
        allowed = await store.hasActiveScope({ orgId, residentId: actingForResidentId,
          caregiverId: actor.id, scope });
      }
    } else if (decisionActor.id === actor.id) {
      allowed = actor.roles.includes('senior') && resource.residentId === actor.id;
      // Minimal operator surface: scheduling, ride booking, assistance and events.
      // Profile/alert disclosure needs a dedicated purpose/consent workflow.
      allowed ||= isOperator(actor) && ['schedule', 'ride', 'assistance', 'event'].includes(resource.kind);
    }
    if (!allowed) return deny(actor);
    await store.recordDecision({ orgId, entryActorId: actor.id, decisionActorId: decisionActor.id,
      outcome: 'allowed', reason: 'policy_allowed' });
    await audit.emit({ actor: `user:${actor.id}`,
      on_behalf_of: actingForResidentId ? `user:${actingForResidentId}` : null,
      action: 'caregiver.acted', target: `${resource.kind}:${resource.id}`, org_id: orgId,
      outcome: 'allowed', reason: 'policy_allowed' });
    return { allowed: true };
  }

  async function changeConsent(change: ConsentChange, operation: 'grant' | 'revoke') {
    const { actor, decisionActor, orgId, residentId, caregiverId, scope } = change;
    if (!validActor(actor)) return denied;
    if (!validActor(decisionActor) || actor.orgId !== orgId || decisionActor.orgId !== orgId
      || !uuid.test(residentId) || !uuid.test(caregiverId) || residentId === caregiverId
      || decisionActor.id !== residentId || !decisionActor.roles.includes('senior')
      || !((actor.id === residentId && actor.roles.includes('senior')) || isOperator(actor))
      || actor.id === caregiverId || !Object.hasOwn(scopeRules, scope)
      || !Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 0
      || (operation === 'grant' && (!change.readBackConfirmed
        || (change.expiresAt !== undefined && !(change.expiresAt.getTime() > Date.now()))))) return deny(actor);
    let result;
    try {
      result = await store.change({ orgId, residentId, caregiverId, scope,
        entryActorId: actor.id, decisionActorId: decisionActor.id,
        expectedVersion: change.expectedVersion, operation, expiresAt: change.expiresAt ?? null });
    } catch (error) {
      if (!(error instanceof ConsentConflict)) throw error;
      return deny(actor);
    }
    // The storage transaction has committed. Sink failure propagates; never report
    // success with missing audit. WP-006 owns durable delivery/reconciliation.
    await audit.emit({ actor: `user:${actor.id}`,
      on_behalf_of: actor.id === residentId ? null : `user:${residentId}`,
      action: operation === 'grant' ? 'consent.granted' : 'consent.revoked',
      target: `consent_scope:${result.id}`, org_id: orgId, outcome: 'allowed',
      reason: `${scope} ${operation === 'grant' ? 'granted' : 'revoked'}` });
    return { allowed: true, ...result } as const;
  }

  return { authorize, grant: (change: ConsentChange) => changeConsent(change, 'grant'),
    revoke: (change: ConsentChange) => changeConsent(change, 'revoke') };
}
