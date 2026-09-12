export type ForumRole = 'senior' | 'caregiver' | 'staff' | 'admin' | 'partner' | 'support';
export interface ForumIdentity { orgId: string; userId: string; roles: readonly ForumRole[]; locale?: 'en' | 'es'; requestId?: string }
export type FlagState = 'none' | 'flagged_awaiting_human' | 'cleared_by_human' | 'removed_by_human';
export interface ForumTopic { id: string; title: string; post_count: number }
export interface ForumPost { id: string; author_id: string; body: string; flag_state: FlagState }
export interface ForumReply { id: string; body: string }
export interface Report { id: string; state: 'open' | 'decided' }
export interface Block { user_id: string; created_at: string }
export type ModerationDecision = 'keep' | 'remove' | 'warn';
export interface ModerationItem {
  id: string; source: 'ai_flag' | 'user_report'; target_type: 'post' | 'reply' | 'message';
  target_id: string; decision: ModerationDecision | null; decided_by: string | null;
}
export interface Page<T> { items: T[]; meta: { next_cursor: string | null; total_known: true } }
export interface ModerationClassifier {
  enabled(orgId: string): Promise<boolean>;
  classify(input: { orgId: string; userId: string; role: ForumRole; locale: 'en' | 'es'; requestId: string; content: string }):
    Promise<{ outcome: 'ok' | 'refused' | 'error' | 'killed' | 'egress_blocked'; label: 'safe' | 'review'; eventId: string; promptVersion?: string }>;
}
export interface ForumRateLimiter {
  consume(identity: ForumIdentity, operation: 'post' | 'reply' | 'report' | 'block'):
    Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
}
export interface ForumRepository {
  listTopics(identity: ForumIdentity, cursor: number, limit: number): Promise<Page<ForumTopic>>;
  listPosts(identity: ForumIdentity, topicId: string, cursor: number, limit: number): Promise<Page<ForumPost> | null>;
  createPost(identity: ForumIdentity, topicId: string, body: string): Promise<ForumPost | null>;
  createReply(identity: ForumIdentity, postId: string, body: string): Promise<ForumReply | null>;
  reportPost(identity: ForumIdentity, postId: string, reason: string, note: string | null): Promise<Report | null>;
  listBlocks(identity: ForumIdentity): Promise<Block[]>;
  block(identity: ForumIdentity, userId: string): Promise<Block | null>;
  listModeration(identity: ForumIdentity, cursor: number, limit: number): Promise<Page<ModerationItem>>;
  decide(identity: ForumIdentity, itemId: string, decision: ModerationDecision, reason: string): Promise<ModerationItem | null>;
  flag(identity: ForumIdentity, postId: string, aiEventId: string, promptVersion: string | null): Promise<boolean>;
}
