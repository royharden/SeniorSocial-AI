import { appendAudit } from '../../audit/src/index.ts';
import { withOrg, type DatabaseClient, type TenantTransaction } from '../../db/src/index.ts';
import type { Block, ForumIdentity, ForumPost, ForumReply, ForumTopic, ModerationDecision, ModerationItem, Page, Report } from './types.ts';
import { MessagingHumanReviewAdapter } from './messaging-review.ts';

const visibleTo = (alias: string) => `not exists (select 1 from blocks b where b.org_id=$1 and
  ((b.blocker_id=$2 and b.blocked_id=${alias}.author_id) or (b.blocker_id=${alias}.author_id and b.blocked_id=$2)))`;
const topicVisibleTo = (alias: string) => `not exists (select 1 from blocks b where b.org_id=$1 and
  ((b.blocker_id=$2 and b.blocked_id=${alias}.created_by) or (b.blocker_id=${alias}.created_by and b.blocked_id=$2)))`;
function page<T>(rows: T[], offset: number, limit: number): Page<T> {
  return { items: rows.slice(0, limit), meta: { next_cursor: rows.length > limit ? String(offset + limit) : null, total_known: true } };
}

export class PostgresForumRepository {
  constructor(private readonly client: DatabaseClient, private readonly messageReviews = new MessagingHumanReviewAdapter()) {}

  private scoped<T>(identity: ForumIdentity, work: (sql: TenantTransaction) => Promise<T>): Promise<T> {
    return withOrg(this.client, identity.orgId, async sql => {
      await sql`select set_config('app.current_user_id', ${identity.userId}, true)`;
      return work(sql);
    });
  }

  listTopics(identity: ForumIdentity, offset: number, limit: number): Promise<Page<ForumTopic>> {
    return this.scoped(identity, async sql => {
      const rows = await sql<ForumTopic[]>`select t.id, t.title,
        count(p.id)::int as post_count from forum_topics t
        left join forum_posts p on p.org_id=t.org_id and p.topic_id=t.id and p.visibility='visible'
          and not exists (select 1 from blocks pb where pb.org_id=${identity.orgId} and
            ((pb.blocker_id=${identity.userId} and pb.blocked_id=p.author_id) or
             (pb.blocker_id=p.author_id and pb.blocked_id=${identity.userId})))
        where t.org_id=${identity.orgId} and t.active=true
          and not exists (select 1 from blocks b where b.org_id=${identity.orgId} and
            ((b.blocker_id=${identity.userId} and b.blocked_id=t.created_by) or
             (b.blocker_id=t.created_by and b.blocked_id=${identity.userId})))
        group by t.id,t.title,t.sort_order order by t.sort_order,t.id offset ${offset} limit ${limit + 1}`;
      return page(rows, offset, limit);
    });
  }

  listPosts(identity: ForumIdentity, topicId: string, offset: number, limit: number): Promise<Page<ForumPost> | null> {
    return this.scoped(identity, async sql => {
      const topics = await sql<{ id: string }[]>`select t.id from forum_topics t where t.org_id=${identity.orgId} and t.id=${topicId}
        and t.active=true and not exists (select 1 from blocks b where b.org_id=${identity.orgId} and
          ((b.blocker_id=${identity.userId} and b.blocked_id=t.created_by) or (b.blocker_id=t.created_by and b.blocked_id=${identity.userId})))`;
      if (!topics[0]) return null;
      const rows = await sql<ForumPost[]>`select p.id,p.author_id,p.body,p.flag_state from forum_posts p
        where p.org_id=${identity.orgId} and p.topic_id=${topicId} and p.visibility='visible'
          and not exists (select 1 from blocks b where b.org_id=${identity.orgId} and
            ((b.blocker_id=${identity.userId} and b.blocked_id=p.author_id) or (b.blocker_id=p.author_id and b.blocked_id=${identity.userId})))
        order by p.created_at desc,p.id desc offset ${offset} limit ${limit + 1}`;
      return page(rows, offset, limit);
    });
  }

  createPost(identity: ForumIdentity, topicId: string, body: string): Promise<ForumPost | null> {
    return this.scoped(identity, async sql => {
      const rows = await sql<ForumPost[]>`insert into forum_posts(org_id,topic_id,author_id,body)
        select ${identity.orgId},t.id,${identity.userId},${body} from forum_topics t
        where t.org_id=${identity.orgId} and t.id=${topicId} and t.active=true
          and not exists (select 1 from blocks b where b.org_id=${identity.orgId} and
            ((b.blocker_id=${identity.userId} and b.blocked_id=t.created_by) or (b.blocker_id=t.created_by and b.blocked_id=${identity.userId})))
        returning id,author_id,body,flag_state`;
      return rows[0] ?? null;
    });
  }

  createReply(identity: ForumIdentity, postId: string, body: string): Promise<ForumReply | null> {
    return this.scoped(identity, async sql => {
      const rows = await sql<ForumReply[]>`insert into forum_replies(org_id,post_id,author_id,body)
        select ${identity.orgId},p.id,${identity.userId},${body} from forum_posts p
        where p.org_id=${identity.orgId} and p.id=${postId} and p.visibility='visible'
          and not exists (select 1 from blocks b where b.org_id=${identity.orgId} and
            ((b.blocker_id=${identity.userId} and b.blocked_id=p.author_id) or (b.blocker_id=p.author_id and b.blocked_id=${identity.userId})))
        returning id,body`;
      return rows[0] ?? null;
    });
  }

  reportPost(identity: ForumIdentity, postId: string, reason: string, note: string | null): Promise<Report | null> {
    return this.scoped(identity, async sql => {
      const reports = await sql<Report[]>`insert into reports(org_id,reporter_id,target_type,target_id,reason,note)
        select ${identity.orgId},${identity.userId},'post',p.id,${reason},${note} from forum_posts p
        where p.org_id=${identity.orgId} and p.id=${postId} and p.visibility='visible'
          and not exists (select 1 from blocks b where b.org_id=${identity.orgId} and
            ((b.blocker_id=${identity.userId} and b.blocked_id=p.author_id) or (b.blocker_id=p.author_id and b.blocked_id=${identity.userId})))
        returning id,state`;
      const report = reports[0]; if (!report) return null;
      await sql`insert into moderation_items(org_id,source,target_type,target_id,report_id)
        values(${identity.orgId},'user_report','post',${postId},${report.id})`;
      return report;
    });
  }

  listBlocks(identity: ForumIdentity): Promise<Block[]> {
    return this.scoped(identity, sql => sql<Block[]>`select blocked_id as user_id,created_at::text
      from blocks where org_id=${identity.orgId} and blocker_id=${identity.userId} order by created_at desc,blocked_id`);
  }

  block(identity: ForumIdentity, userId: string): Promise<Block | null> {
    return this.scoped(identity, async sql => {
      const rows = await sql<Block[]>`insert into blocks(org_id,blocker_id,blocked_id)
        select ${identity.orgId},${identity.userId},u.id from users u where u.org_id=${identity.orgId} and u.id=${userId}
        on conflict(org_id,blocker_id,blocked_id) do nothing
        returning blocked_id as user_id,created_at::text`;
      if (rows[0]) return rows[0];
      const existing = await sql<Block[]>`select blocked_id as user_id,created_at::text from blocks
        where org_id=${identity.orgId} and blocker_id=${identity.userId} and blocked_id=${userId}`;
      return existing[0] ?? null;
    });
  }

  listModeration(identity: ForumIdentity, offset: number, limit: number): Promise<Page<ModerationItem>> {
    return this.scoped(identity, sql => this.messageReviews.list(sql,identity,offset,limit));
  }

  decide(identity: ForumIdentity, itemId: string, decision: ModerationDecision, reason: string): Promise<ModerationItem | null> {
    return this.scoped(identity, async sql => {
      const locked = await sql<{ id: string }[]>`select id from moderation_items
        where org_id=${identity.orgId} and id=${itemId} and decision is null
          and exists(select 1 from user_roles role where role.org_id=${identity.orgId}
            and role.user_id=${identity.userId} and role.role in ('staff','admin')) for update`;
      if (!locked[0]) return this.messageReviews.decide(sql,identity,itemId,decision,reason);
      const rows = await sql<ModerationItem[]>`update moderation_items set decision=${decision},decision_reason=${reason},
        decided_by=${identity.userId},decided_at=statement_timestamp()
        where org_id=${identity.orgId} and id=${itemId} and decision is null
        returning id,source,target_type,target_id,decision,decided_by`;
      const item = rows[0]; if (!item) return null;
      if (item.target_type === 'post') await sql`update forum_posts set visibility=${decision === 'remove' ? 'removed' : 'visible'},
        flag_state=${decision === 'remove' ? 'removed_by_human' : 'cleared_by_human'}
        where org_id=${identity.orgId} and id=${item.target_id}`;
      if (item.target_type === 'reply') await sql`update forum_replies set visibility=${decision === 'remove' ? 'removed' : 'visible'}
        where org_id=${identity.orgId} and id=${item.target_id}`;
      await sql`update reports set state='decided' where org_id=${identity.orgId} and id=(select report_id from moderation_items where org_id=${identity.orgId} and id=${itemId})`;
      await appendAudit(sql, { actor: `user:${identity.userId}`, action: 'moderation.decided', target: `moderation_item:${item.id}`,
        org_id: identity.orgId, outcome: 'allowed', reason: `human_moderation_${decision}`, fields: ['decision','decision_reason','decided_at','decided_by'] });
      return item;
    });
  }

  flag(identity: ForumIdentity, postId: string, aiEventId: string, promptVersion: string | null): Promise<boolean> {
    return this.scoped(identity, async sql => {
      const updated = await sql<{ id: string }[]>`update forum_posts set flag_state='flagged_awaiting_human'
        where org_id=${identity.orgId} and id=${postId} and visibility='visible' and flag_state='none' returning id`;
      if (!updated[0]) return false;
      const items = await sql<{ id: string }[]>`insert into moderation_items(org_id,source,target_type,target_id,ai_event_id)
        values(${identity.orgId},'ai_flag','post',${postId},${aiEventId}) returning id`;
      const item = items[0]; if (!item) throw new Error('AI moderation queue insert failed');
      await appendAudit(sql, { actor: 'ai:moderation', action: 'moderation.flagged', target: `moderation_item:${item.id}`,
        org_id: identity.orgId, outcome: 'allowed', reason: 'classifier requested human review', fields: ['flag_state'],
        prompt_version: promptVersion, ai_event_id: aiEventId });
      return true;
    });
  }
}

// Kept exported for security tests that assert one canonical symmetric predicate shape.
export const symmetricBlockPredicates = { content: visibleTo('content'), topic: topicVisibleTo('topic') };
