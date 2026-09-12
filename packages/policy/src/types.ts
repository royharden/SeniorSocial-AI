export const roles = ['senior', 'caregiver', 'staff', 'admin', 'partner', 'support'] as const;
export type Role = (typeof roles)[number];

export const scopeRules = {
  view_schedule: { resource: 'schedule', action: 'read' },
  book_rides: { resource: 'ride', action: 'book' },
  receive_alerts: { resource: 'alert', action: 'read' },
  view_assistance: { resource: 'assistance', action: 'read' },
  manage_events: { resource: 'event', action: 'manage' },
  view_profile: { resource: 'profile', action: 'read' },
} as const;
export type Scope = keyof typeof scopeRules;
export type ResourceKind = (typeof scopeRules)[Scope]['resource'];
export type Action = (typeof scopeRules)[Scope]['action'];

/** Trusted server identity, populated by authentication, never request JSON. */
export interface Actor { id: string; orgId: string; roles: readonly Role[] }
export interface Resource { id: string; orgId: string; residentId: string; kind: ResourceKind }
export interface AccessRequest {
  actor: Actor;
  decisionActor: Actor;
  orgId: string;
  resource: Resource;
  action: Action;
  actingForResidentId?: string;
}
export interface ConsentChange {
  actor: Actor;
  decisionActor: Actor;
  orgId: string;
  residentId: string;
  caregiverId: string;
  scope: Scope;
  /** Version obtained with the consent read-back; prevents stale grant replay. */
  expectedVersion: number;
  readBackConfirmed: boolean;
  expiresAt?: Date;
}
export interface ConsentKey { orgId: string; residentId: string; caregiverId: string; scope: Scope }
export interface ConsentMutation extends ConsentKey {
  entryActorId: string;
  decisionActorId: string;
  expectedVersion: number;
  operation: 'grant' | 'revoke';
  expiresAt: Date | null;
}
export interface DecisionRecord {
  orgId: string;
  entryActorId: string;
  decisionActorId: string;
  outcome: 'allowed' | 'denied';
  reason: 'policy_allowed' | 'policy_denied';
}
export interface ConsentStore {
  /** A fresh committed-state read on EVERY call; never cache this result. */
  hasActiveScope(key: ConsentKey): Promise<boolean>;
  /** Atomic compare-and-increment, individual scope change, attribution/history. */
  change(mutation: ConsentMutation): Promise<{ id: string; version: number }>;
  recordDecision(decision: DecisionRecord): Promise<void>;
}
/** WP-006 supplies database-generated id/at when persisting this intent. */
export interface AuditIntent {
  actor: string;
  on_behalf_of: string | null;
  action: 'consent.granted' | 'consent.revoked' | 'caregiver.acted' | 'caregiver.denied';
  target: string;
  org_id: string;
  outcome: 'allowed' | 'denied';
  reason: string;
}
export interface AuditSink { emit(intent: AuditIntent): Promise<void> }
export type Authorization = { allowed: true } | { allowed: false; status: 404; error: 'not_found' };
