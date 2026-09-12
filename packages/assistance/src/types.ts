export const assistanceStates = ['pending_unowned', 'owned', 'in_progress', 'resolved', 'closed_unable'] as const;
export type AssistanceState = (typeof assistanceStates)[number];
export type TriageCategory = 'immediate_safety' | 'food' | 'housing' | 'transportation' | 'social_support' | 'general';
export type TriageSource = 'rules' | 'ai' | 'staff';

export interface Identity {
  orgId: string;
  userId: string;
  roles: readonly ('senior' | 'caregiver' | 'staff' | 'admin' | 'partner' | 'support')[];
}

export interface AssistanceRequest {
  id: string;
  orgId: string;
  requesterId: string;
  summary: string;
  locale: 'en' | 'es';
  triageCategory: TriageCategory;
  triageSource: TriageSource;
  state: AssistanceState;
  ownerId: string | null;
  afterHours: boolean;
  slaDueAt: Date;
  slaBreachedAt: Date | null;
  createdAt: Date;
}

export interface CreateInput { summary: string; locale?: 'en' | 'es'; idempotencyKey: string }
export interface TransitionInput { to: AssistanceState; ownerId?: string; reason?: string }
export interface AuditIntent {
  actor: string;
  action: 'assistance.opened' | 'assistance.owned' | 'assistance.transitioned' | 'assistance.sla_breached';
  target: string;
  org_id: string;
  outcome: 'allowed';
  reason: string;
  fields: readonly string[];
}
/** Plaintext is transient for the returned value; repositories persist only ciphertext. */
export interface NewRequest extends AssistanceRequest { summaryCiphertext: string }

export interface AssistanceTransaction {
  insert(request: NewRequest, idempotencyKey: string): Promise<{ request: AssistanceRequest; created: boolean }>;
  find(id: string): Promise<AssistanceRequest | null>;
  listForRequester(requesterId: string): Promise<AssistanceRequest[]>;
  listQueue(): Promise<AssistanceRequest[]>;
  transition(id: string, expected: AssistanceState, to: AssistanceState, ownerId: string | null, actorId: string, reason: string): Promise<AssistanceRequest>;
  markBreached(id: string, at: Date): Promise<{ request: AssistanceRequest; created: boolean }>;
  audit(intent: AuditIntent): Promise<void>;
}
export interface AssistanceRepository {
  transaction<T>(orgId: string, work: (transaction: AssistanceTransaction) => Promise<T>): Promise<T>;
}
export interface AuthorizationPort {
  authorize(identity: Identity, request: { residentId: string; resourceId: string; operation: 'create' | 'read' | 'manage' }): Promise<boolean>;
}
export interface NarrativeCodec { seal(plaintext: string): Promise<string>; open(ciphertext: string): Promise<string> }
export interface AiTriagePort {
  propose(input: { ruleCategory: TriageCategory; locale: 'en' | 'es' }): Promise<{ category: TriageCategory; source: 'ai' } | { outcome: 'refused' | 'timeout' | 'error' | 'killed' }>;
}
export const assistanceOpenedEvent = 'assistance.opened' as const;
export const assistanceSlaTickJob = 'assistance.sla.tick' as const;
export interface NotificationPort {
  queue(input: {
    idempotencyKey: string;
    audience: 'staff';
    event: typeof assistanceOpenedEvent;
    payload: {
      request_id: string;
      org_id: string;
      requester_id: string;
      triage_category: TriageCategory;
      triage_source: TriageSource;
      after_hours: boolean;
    };
  }): Promise<void>;
}
export interface AssistanceJobPort {
  enqueue(
    name: typeof assistanceSlaTickJob,
    payload: { idempotency_key: string; org_id: string; request_id: string },
    dueAt: Date,
  ): Promise<void>;
}
export interface BusinessHours { isAfterHours(at: Date): boolean }
export interface IdSource { next(): string }

export class NotFoundError extends Error { constructor() { super('not_found'); } }
export class ForbiddenError extends Error { constructor() { super('forbidden'); } }
export class ConflictError extends Error { constructor(message = 'illegal_transition') { super(message); } }
