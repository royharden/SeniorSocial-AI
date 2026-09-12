import type { Channel, NotifyPreferences, Purpose } from './preferences.ts';

/** Populated by the authenticated server, never copied from request JSON. */
export interface Identity { orgId: string; userId: string }
export interface AuditIntent {
  actor: string;
  on_behalf_of: null;
  action: 'notification.preferences_changed' | 'notification.queued' | 'notification.attempted' | 'notification.suppressed';
  target: string;
  org_id: string;
  outcome: 'allowed' | 'denied' | 'error';
  reason: string;
}
export interface AuditSink { emit(intent: AuditIntent, pendingId?: string): Promise<void> }
export interface FeatureGate {
  /** Effective global AND org value; evaluated freshly, including at send. */
  enabled(key: 'notify.voice.real_send', orgId: string): Promise<boolean>;
}
export interface Authorization {
  /** Must consult current identity/membership/consent; absence/error denies. */
  canNotify(identity: Identity, recipientId: string, purpose: Purpose, resourceId?: string): Promise<boolean>;
  /** A callback code is a locator only and never grants this permission. */
  canDisclose(identity: Identity, recipientId: string, resourceId: string): Promise<boolean>;
}
export interface Payload {
  idempotency_key: string;
  org_id: string;
  user_id: string;
  purpose: Purpose;
  template: string;
  locale: 'en' | 'es';
  params: Record<string, string>;
  /** Trusted authorization locator, never rendered or treated as authority itself. */
  resource_id?: string;
}
export interface JobQueue {
  /** Bridge must set pg-boss singletonKey = payload.idempotency_key. No delivery here. */
  enqueue(name: `notify.send.${Channel}`, payload: Payload, dueAt: Date): Promise<void>;
}
export type State = 'pending' | 'sending' | 'send_failed' | 'ambiguous' | 'delivered' | 'suppressed';
export interface Job {
  id: string;
  orgId: string;
  userId: string;
  actorId: string;
  channel: Channel;
  payload: Payload;
  state: State;
  dueAt: Date;
  attempts: number;
  synthetic: boolean;
}
export interface Attempt {
  id: string;
  jobId: string;
  sequence: number;
  outcome: 'started' | 'confirmed' | 'failed' | 'ambiguous' | 'suppressed';
  synthetic: boolean;
}
export interface PendingAudit { id: string; intent: AuditIntent }
export interface Transaction {
  preferences(): Promise<NotifyPreferences>;
  savePreferences(preferences: NotifyPreferences): Promise<void>;
  insert(job: Job): Promise<Job>;
  job(id: string): Promise<Job | null>;
  save(job: Job): Promise<void>;
  attempt(attempt: Attempt): Promise<void>;
  audit(intent: AuditIntent): Promise<void>;
}
export interface Repository {
  /** Serializes all preference/outbox mutations for this recipient, commits before returning. */
  transaction<T>(identity: Identity, work: (tx: Transaction) => Promise<T>): Promise<T>;
  pendingAudits(identity: Identity): Promise<PendingAudit[]>;
  acknowledgeAudit(identity: Identity, id: string): Promise<void>;
  /** Pending/failed sends and delivered events missing inbox transfer, scoped to a recipient. */
  schedulable(identity: Identity): Promise<Job[]>;
}
export interface Delivery {
  jobId: string;
  channel: Channel;
  /** Stable across attempts, suitable for adapter idempotency. */
  idempotencyKey: string;
  destination: string;
  body: string;
}
export type Confirmation =
  | { outcome: 'confirmed'; synthetic: true }
  | { outcome: 'failed' | 'ambiguous'; synthetic: true };
export interface Adapter { send(delivery: Delivery): Promise<Confirmation> }
export interface Renderer {
  /** Called only after fresh authorization and preference/flag checks. */
  destination(job: Job): Promise<string>;
  body(job: Job): Promise<string>;
}
export interface InboxPublisher {
  /** Idempotent trusted-server publication into the recipient's private inbox. */
  publish(identity: Identity, sourceKey: string, input: { purpose: Purpose; title: string; body: string }): Promise<void>;
}
