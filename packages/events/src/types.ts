export const eventRoles = ['senior', 'caregiver', 'staff', 'admin', 'partner', 'support'] as const;
export type EventRole = (typeof eventRoles)[number];

/** Trusted session identity. Routes populate this from WP-004, never JSON. */
export interface EventIdentity { orgId: string; userId: string; roles: readonly EventRole[] }
export interface EventView {
  id: string;
  org_id: string;
  title: string;
  starts_at: string;
  time_zone: string;
  location: string;
  capacity: number | null;
  rsvp_count: number;
  accessibility: string[];
}
export interface RsvpView { id: string; event_id: string; state: 'attending' | 'waitlisted' | 'cancelled' }
export interface ProposalView { id: string; state: 'proposed' | 'published' | 'declined'; time_zone: string }
export interface EventProposalInput { title: string; starts_at: string; time_zone?: string; note?: string }
export interface EventListInput { from?: string; to?: string; cursor?: string; limit: number }
export interface EventListQuery { from?: string; to?: string; cursor: EventCursor | null; limit: number }
export interface EventCursor { startsAt: string; id: string }
export interface Page<T> { items: T[]; meta: { next_cursor: string | null; total_known: boolean } }
export interface RecommendationContext { accessibility: readonly string[] }
export interface Recommendation { event: EventView; reason: string }

export type RsvpResult =
  | { kind: 'attending'; rsvp: RsvpView; startsAt: Date }
  | { kind: 'full' }
  | { kind: 'not_found' };
export type WaitlistResult =
  | { kind: 'waitlisted' | 'attending'; rsvp: RsvpView }
  | { kind: 'not_full' }
  | { kind: 'not_found' };
export interface CancelResult { cancelled: boolean; promoted: RsvpView | null; promotedUserId: string | null; startsAt: Date | null }

export interface PublishInput { location?: string; capacity?: number | null; accessibility?: readonly string[] }
export interface ProposalResource { id: string; orgId: string; residentId: string; kind: 'event' }
export interface EventPolicyActor { id: string; orgId: string; roles: readonly EventRole[] }
export interface EventManageAccessRequest {
  actor: EventPolicyActor;
  decisionActor: EventPolicyActor;
  orgId: string;
  resource: ProposalResource;
  action: 'manage';
}
export interface EventAuthorization { authorize(request: EventManageAccessRequest): Promise<{ allowed: true } | { allowed: false; status: 404; error: 'not_found' }> }
export interface ReminderIntent extends ReminderRequest { state: 'pending' | 'drained' }
export interface EventRepository {
  list(identity: EventIdentity, input: EventListQuery): Promise<Page<EventView>>;
  find(identity: EventIdentity, eventId: string): Promise<EventView | null>;
  rsvp(identity: EventIdentity, eventId: string): Promise<RsvpResult>;
  waitlist(identity: EventIdentity, eventId: string): Promise<WaitlistResult>;
  cancel(identity: EventIdentity, eventId: string): Promise<CancelResult>;
  propose(identity: EventIdentity, input: EventProposalInput): Promise<ProposalView>;
  proposalResource(identity: EventIdentity, proposalId: string): Promise<ProposalResource | null>;
  publish(identity: EventIdentity, proposalId: string, input: PublishInput): Promise<EventView | null>;
  recommendationContext(identity: EventIdentity): Promise<RecommendationContext>;
  pendingReminderIntents(identity: EventIdentity): Promise<ReminderIntent[]>;
  completeReminderIntent(identity: EventIdentity, idempotencyKey: string): Promise<void>;
}

export interface ReminderRequest {
  idempotencyKey: string;
  eventId: string;
  orgId: string;
  userId: string;
  purpose: 'event_reminder';
  dueAt: Date;
}
export interface ReminderScheduler { schedule(request: ReminderRequest): Promise<void> }
export interface OrgTimeZone { forOrg(orgId: string): Promise<string> }
export interface EventJobPayload {
  idempotency_key: string;
  event_id: string;
  org_id: string;
  user_id: string;
  purpose: 'event_reminder';
}
export interface EventJobQueue {
  enqueue(name: 'events.reminder.schedule', payload: EventJobPayload, dueAt: Date): Promise<void>;
}
export interface EventReranker {
  enabled(orgId: string): Promise<boolean>;
  rerank(identity: EventIdentity, recommendations: readonly Recommendation[]): Promise<readonly Recommendation[]>;
}
