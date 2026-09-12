export const caregiverScopeKeys = [
  'view_schedule', 'book_rides', 'receive_alerts', 'view_assistance', 'manage_events', 'view_profile',
] as const;
export type CaregiverScopeKey = (typeof caregiverScopeKeys)[number];

export const delegableCaregiverScopes = [
  'view_schedule', 'book_rides', 'receive_alerts', 'view_assistance', 'view_profile',
] as const satisfies readonly CaregiverScopeKey[];

export const caregiverScopeRules = {
  view_schedule: { resource: 'schedule', action: 'read' },
  book_rides: { resource: 'ride', action: 'book' },
  receive_alerts: { resource: 'alert', action: 'read' },
  view_assistance: { resource: 'assistance', action: 'read' },
  manage_events: { resource: 'event', action: 'manage' },
  view_profile: { resource: 'profile', action: 'read' },
} as const;

/** Trusted WP-004 session projection. None of these fields come from request JSON. */
export interface SessionIdentity {
  orgId: string;
  userId: string;
  roles: readonly ('senior' | 'caregiver' | 'staff' | 'admin' | 'partner' | 'support')[];
}

export interface CaregiverInviteInput { email_or_phone: string; relationship_note?: string }
export interface CaregiverInvitation { id: string; expires_at: string }
export interface ConsentScope { key: CaregiverScopeKey; granted: boolean; granted_at: string | null }
export interface ConsentScopeSet { scopes: ConsentScope[]; read_back_confirmed: boolean }
export interface CaregiverLink {
  id: string; resident_id: string; caregiver_id: string; scopes: ConsentScope[]; state: 'pending' | 'active' | 'revoked';
}

export interface StoredInvitation {
  id: string; orgId: string; residentId: string; recipientDigest: string; tokenDigest: string;
  relationshipNote: string | null;
  createdAt: Date; expiresAt: Date; acceptedAt: Date | null; caregiverId: string | null;
}
export interface StoredScope { key: CaregiverScopeKey; grantedAt: Date; revokedAt: Date | null }
export interface StoredLink {
  id: string; orgId: string; residentId: string; caregiverId: string; state: 'pending' | 'active' | 'revoked'; scopes: StoredScope[];
}
export interface AtomicAudit {
  action: 'caregiver.invited' | 'caregiver.accepted' | 'caregiver.denied' | 'consent.granted' | 'consent.revoked';
  actorId: string; grantorId: string; caregiverId: string | null; resource: string; resourceAction: string;
  outcome: 'allowed' | 'denied'; reason: string;
}
export interface ReadBackRecord { linkId: string; residentId: string; actorId: string; scopes: CaregiverScopeKey[]; confirmedAt: Date }

export interface CaregiverTransaction {
  insertInvitation(invitation: StoredInvitation): Promise<void>;
  invitationByTokenDigest(tokenDigest: string): Promise<StoredInvitation | null>;
  acceptInvitation(invitationId: string, caregiverId: string, linkId: string, at: Date): Promise<StoredLink>;
  linkById(linkId: string): Promise<StoredLink | null>;
  linksForCaregiver(caregiverId: string): Promise<StoredLink[]>;
  linksForResident(residentId: string): Promise<StoredLink[]>;
  accountRecipients(userId: string): Promise<string[]>;
  replaceScopes(linkId: string, scopes: readonly CaregiverScopeKey[], at: Date): Promise<StoredLink>;
  revokeLink(linkId: string, at: Date): Promise<StoredLink>;
  appendReadBack(record: ReadBackRecord): Promise<void>;
  appendAudit(event: AtomicAudit): Promise<void>;
}
export interface CaregiverRepository {
  /** Must use a fresh WP-003 tenant transaction; mutations and audit commit atomically. */
  transaction<T>(orgId: string, work: (transaction: CaregiverTransaction) => Promise<T>): Promise<T>;
}

/** Deliberately shaped like WP-009 enqueue without importing an in-flight branch. */
export interface InvitationDeliveryPort {
  enqueue(identity: { orgId: string; userId: string }, request: {
    recipient: string; channel: 'email' | 'sms'; purpose: 'task_notice'; idempotencyKey: string;
    template: 'caregiver.invitation'; params: { invitation_token: string; expires_at: string }; synthetic: true;
  }): Promise<{ status: 'pending' | 'delivered' | 'suppressed'; synthetic: true }>;
}
