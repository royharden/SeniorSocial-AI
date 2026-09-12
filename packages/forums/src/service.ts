import { randomUUID } from 'node:crypto';
import type { ForumIdentity, ForumRateLimiter, ForumRepository, ModerationClassifier, ModerationDecision } from './types.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const roles = new Set(['senior', 'caregiver', 'staff', 'admin', 'partner', 'support']);
const opaque = { status: 404, code: 'not_found' } as const;
const invalid = { status: 422, code: 'invalid_forum_input' } as const;

function valid(identity: ForumIdentity): boolean {
  return uuid.test(identity.orgId) && uuid.test(identity.userId) && identity.roles.length > 0 && identity.roles.every(role => roles.has(role));
}
function paging(input: { cursor?: string; limit?: number }): { cursor: number; limit: number } | null {
  const limit = input.limit ?? 25;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return null;
  if (input.cursor !== undefined && !/^\d{1,6}$/u.test(input.cursor)) return null;
  const cursor = Number(input.cursor ?? 0);
  return cursor <= 100_000 ? { cursor, limit } : null;
}
function body(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const clean = value.trim();
  return clean.length >= 1 && clean.length <= 8_000 ? clean : null;
}

export function createForums(repository: ForumRepository, classifier?: ModerationClassifier, limiter?: ForumRateLimiter) {
  async function rate(identity: ForumIdentity, operation: 'post' | 'reply' | 'report' | 'block') {
    const result = await limiter?.consume(identity, operation);
    return result && !result.allowed
      ? { status: 429, code: 'rate_limited', retry_after: result.retryAfterSeconds ?? 60 } as const : null;
  }
  async function listTopics(identity: ForumIdentity, input: { cursor?: string; limit?: number } = {}) {
    const page = paging(input); return valid(identity) && page ? repository.listTopics(identity, page.cursor, page.limit) : opaque;
  }
  async function listPosts(identity: ForumIdentity, topicId: string, input: { cursor?: string; limit?: number } = {}) {
    const page = paging(input); return valid(identity) && uuid.test(topicId) && page ? await repository.listPosts(identity, topicId, page.cursor, page.limit) ?? opaque : opaque;
  }
  async function createPost(identity: ForumIdentity, topicId: string, input: { body?: unknown }) {
    const clean = body(input.body);
    if (!valid(identity) || !uuid.test(topicId)) return opaque;
    if (!clean) return invalid;
    const limited = await rate(identity, 'post'); if (limited) return limited;
    const post = await repository.createPost(identity, topicId, clean);
    if (!post) return opaque;
    if (classifier) {
      try {
        if (!await classifier.enabled(identity.orgId)) return post;
        const result = await classifier.classify({ orgId: identity.orgId, userId: identity.userId,
          role: identity.roles[0]!, locale: identity.locale ?? 'en', requestId: identity.requestId ?? randomUUID(), content: clean });
        if (result.outcome === 'ok' && result.label === 'review') {
          if (await repository.flag(identity, post.id, result.eventId, result.promptVersion ?? null)) post.flag_state = 'flagged_awaiting_human';
        }
      } catch { /* AI failure never prevents or hides resident content. */ }
    }
    return post;
  }
  async function createReply(identity: ForumIdentity, postId: string, input: { body?: unknown }) {
    const clean = body(input.body);
    if (!valid(identity) || !uuid.test(postId)) return opaque;
    if (!clean) return invalid;
    const limited = await rate(identity, 'reply'); if (limited) return limited;
    return await repository.createReply(identity, postId, clean) ?? opaque;
  }
  async function reportPost(identity: ForumIdentity, postId: string, input: { reason?: unknown; note?: unknown }) {
    if (!valid(identity) || !uuid.test(postId)) return opaque;
    if (typeof input.reason !== 'string' || input.reason.trim().length < 1 || input.reason.length > 100 || /[\r\n]/u.test(input.reason)) return invalid;
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 2_000)) return invalid;
    const limited = await rate(identity, 'report'); if (limited) return limited;
    return await repository.reportPost(identity, postId, input.reason.trim(), typeof input.note === 'string' ? input.note.trim() : null) ?? opaque;
  }
  async function listBlocks(identity: ForumIdentity) { return valid(identity) ? { items: await repository.listBlocks(identity) } : opaque; }
  async function block(identity: ForumIdentity, input: { user_id?: unknown }) {
    if (!valid(identity) || typeof input.user_id !== 'string' || !uuid.test(input.user_id)) return invalid;
    if (input.user_id === identity.userId) return { status: 422, code: 'cannot_block_self' } as const;
    const limited = await rate(identity, 'block'); if (limited) return limited;
    return await repository.block(identity, input.user_id) ?? opaque;
  }
  async function listModeration(identity: ForumIdentity, input: { cursor?: string; limit?: number } = {}) {
    if (!valid(identity) || !identity.roles.some(role => role === 'staff' || role === 'admin')) return { status: 403, code: 'forbidden' } as const;
    const page = paging(input); return page ? repository.listModeration(identity, page.cursor, page.limit) : invalid;
  }
  async function decide(identity: ForumIdentity, itemId: string, input: { decision?: unknown; reason?: unknown }) {
    if (!valid(identity) || !identity.roles.some(role => role === 'staff' || role === 'admin')) return { status: 403, code: 'forbidden' } as const;
    if (!uuid.test(itemId)) return opaque;
    if (!['keep', 'remove', 'warn'].includes(String(input.decision)) || typeof input.reason !== 'string' ||
      input.reason.trim().length < 1 || input.reason.length > 500 || /[\r\n]/u.test(input.reason)) return invalid;
    return await repository.decide(identity, itemId, input.decision as ModerationDecision, input.reason.trim()) ?? opaque;
  }
  return { listTopics, listPosts, createPost, createReply, reportPost, listBlocks, block, listModeration, decide };
}
export type ForumsService = ReturnType<typeof createForums>;
