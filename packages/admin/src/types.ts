export const adminRoles = ['staff', 'admin'] as const;
export type AdminRole = (typeof adminRoles)[number];
export interface AdminActor { id: string; orgId: string; roles: readonly string[] }
export interface Page<T> { items: T[]; meta: { next_cursor: string | null; total_known: boolean } }

export type AccountState = 'active' | 'held_for_review';
export interface AdminUser { id: string; org_id: string; display_name: string; roles: string[]; account_state: AccountState | 'deactivated'; version: number }
export interface UserPatch { roles?: string[]; account_state?: AccountState; expected_version: number }
export interface MutationMetadata { idempotencyKey: string; requestHash: string; expectedVersion?: number }

export interface ContentPage { id: string; slug: string; version: number; critical: boolean }
export interface ContentPageInput { slug: string; critical?: boolean }
export interface Faq { id: string; question: string; answer: string; version: number }
export interface FaqInput { question: string; answer: string }
export interface Announcement { id: string; title: string; publish_at: string; version: number }
export interface AnnouncementInput { title: string; publish_at: string }
export interface Partner { id: string; name: string; categories: string[]; contact: string; version: number }
export interface PartnerInput { name: string; categories?: string[]; contact: string }
export interface AnalyticsTile { key: string; value: number; unit_definition: string; known_gap: string | null }
export interface AnalyticsTiles { tiles: AnalyticsTile[]; as_of: string; source_version: string }

export type QueueKind = 'assistance' | 'rides' | 'moderation' | 'translation';
export interface QueueItem {
  id: string;
  queue: QueueKind;
  label: string | null;
  state: string;
  actor: string | null;
  at: string | null;
}
export interface QueueDefinition<TRow> {
  kind: QueueKind;
  endpoint: string;
  parse: (source: unknown) => Page<TRow>;
  item: (source: TRow) => QueueItem;
}
export interface QueueTransport { get(endpoint: string): Promise<unknown> }

export interface AdminRepository {
  listUsers(orgId: string): Promise<Page<AdminUser>>;
  findUser(orgId: string, userId: string): Promise<AdminUser | null>;
  updateUser(orgId: string, actorId: string, userId: string, patch: UserPatch, mutation: MutationMetadata): Promise<AdminUser | null>;
  listContentPages(orgId: string): Promise<Page<ContentPage>>;
  createContentPage(orgId: string, actorId: string, input: ContentPageInput, mutation: MutationMetadata): Promise<ContentPage>;
  listFaqs(orgId: string): Promise<Page<Faq>>;
  createFaq(orgId: string, actorId: string, input: FaqInput, mutation: MutationMetadata): Promise<Faq>;
  listAnnouncements(orgId: string): Promise<Page<Announcement>>;
  createAnnouncement(orgId: string, actorId: string, input: AnnouncementInput, mutation: MutationMetadata): Promise<Announcement>;
  listPartners(orgId: string): Promise<Page<Partner>>;
  createPartner(orgId: string, actorId: string, input: PartnerInput, mutation: MutationMetadata): Promise<Partner>;
  analytics(orgId: string): Promise<AnalyticsTiles>;
}
