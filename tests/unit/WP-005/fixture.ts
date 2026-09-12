import { randomUUID } from 'node:crypto';
import { ConsentConflict, createPolicy } from '../../../packages/policy/src/index.ts';
import type { Actor, AuditIntent, ConsentChange, ConsentKey, ConsentMutation, ConsentStore, DecisionRecord, Scope } from '../../../packages/policy/src/index.ts';

export const orgId = '11111111-1111-4111-8111-111111111111';
export const otherOrg = '22222222-2222-4222-8222-222222222222';
export const resident: Actor = { id: '11111111-1111-4111-8111-111111111101', orgId, roles: ['senior'] };
export const caregiver: Actor = { id: '11111111-1111-4111-8111-111111111102', orgId, roles: ['caregiver'] };
export const staff: Actor = { id: '11111111-1111-4111-8111-111111111103', orgId, roles: ['staff'] };
export const resourceId = '11111111-1111-4111-8111-111111111104';
export const change = (scope: Scope, expectedVersion: number): ConsentChange => ({
  actor: staff, decisionActor: resident, orgId, residentId: resident.id,
  caregiverId: caregiver.id, scope, expectedVersion, readBackConfirmed: true,
});

export function fixture() {
  const scopes = new Map<string, { id: string; expiresAt: Date | null }>();
  const history: ConsentMutation[] = [];
  const decisions: DecisionRecord[] = [];
  const intents: AuditIntent[] = [];
  let version = 0;
  let reads = 0;
  const keyOf = (key: ConsentKey) => [key.orgId, key.residentId, key.caregiverId, key.scope].join(':');
  const store: ConsentStore = {
    hasActiveScope: key => {
      reads += 1;
      const record = scopes.get(keyOf(key));
      return Promise.resolve(!!record && (!record.expiresAt || record.expiresAt.getTime() > Date.now()));
    },
    change: mutation => {
      if (mutation.expectedVersion !== version) return Promise.reject(new ConsentConflict());
      const key = keyOf(mutation);
      const existing = scopes.get(key);
      if ((mutation.operation === 'grant' && existing) || (mutation.operation === 'revoke' && !existing)) {
        return Promise.reject(new ConsentConflict());
      }
      const id = existing?.id ?? randomUUID();
      if (mutation.operation === 'grant') scopes.set(key, { id, expiresAt: mutation.expiresAt });
      else scopes.delete(key);
      history.push(mutation);
      return Promise.resolve({ id, version: ++version });
    },
    recordDecision: decision => { decisions.push(decision); return Promise.resolve(); },
  };
  const policy = createPolicy(store, { emit: intent => { intents.push(intent); return Promise.resolve(); } });
  return { store, policy, history, intents, decisions, reads: () => reads };
}
