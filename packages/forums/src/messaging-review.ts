import { appendAudit } from '../../audit/src/index.ts';
import type { TenantTransaction } from '../../db/src/index.ts';
import type { ForumIdentity, ModerationDecision, ModerationItem, Page } from './types.ts';

/** Pinned forever: changing it would invalidate externally visible queue item IDs. */
export const messageModerationNamespace = '7699a1f4-6b0f-4f69-8dc7-1da9236df15e';

export class MessagingHumanReviewAdapter {
  async list(sql: TenantTransaction, identity: ForumIdentity, offset: number, limit: number): Promise<Page<ModerationItem>> {
    const rows = await sql<(ModerationItem & { created_at: string })[]>`with review_queue as (
      select item.id,item.source,item.target_type,item.target_id,item.decision,item.decided_by,item.created_at
      from moderation_items item where item.org_id=${identity.orgId} and item.decision is null
      union all
      select uuid_generate_v5(${messageModerationNamespace}::uuid,report.id::text),'user_report'::text,
        'message'::text,report.conversation_id,null::text,null::uuid,report.created_at
      from messaging_reports report where report.org_id=${identity.orgId} and report.state='open'
    ) select id,source,target_type,target_id,decision,decided_by,created_at::text from review_queue
      where exists(select 1 from user_roles role where role.org_id=${identity.orgId}
        and role.user_id=${identity.userId} and role.role in ('staff','admin'))
      order by review_queue.created_at,id offset ${offset} limit ${limit + 1}`;
    return { items: rows.slice(0,limit).map(({created_at: _createdAt,...item})=>item),
      meta:{next_cursor:rows.length>limit?String(offset+limit):null,total_known:true} };
  }

  async decide(sql: TenantTransaction, identity: ForumIdentity, itemId: string, decision: ModerationDecision, reason: string): Promise<ModerationItem | null> {
    const reports = await sql<{ id: string; conversation_id: string }[]>`select report.id,report.conversation_id from messaging_reports report
      where report.org_id=${identity.orgId} and report.state='open'
        and uuid_generate_v5(${messageModerationNamespace}::uuid,report.id::text)=${itemId}
        and exists(select 1 from user_roles role where role.org_id=${identity.orgId}
          and role.user_id=${identity.userId} and role.role in ('staff','admin')) for update`;
    const report = reports[0]; if (!report) return null;
    await sql`insert into messaging_moderation_decisions(queue_id,org_id,report_id,decision,reason,decided_by)
      values(${itemId},${identity.orgId},${report.id},${decision},${reason},${identity.userId})`;
    const updated = await sql`update messaging_reports report set state='decided'
      where report.org_id=${identity.orgId} and report.state='open'
        and uuid_generate_v5(${messageModerationNamespace}::uuid,report.id::text)=${itemId}`;
    if (updated.count !== 1) throw new Error('messaging moderation state transition did not commit');
    await appendAudit(sql,{actor:`user:${identity.userId}`,action:'moderation.decided',target:`moderation_item:${itemId}`,
      org_id:identity.orgId,outcome:'allowed',reason:`human_moderation_${decision}`,fields:['decision','decision_reason','decided_at','decided_by']});
    return {id:itemId,source:'user_report',target_type:'message',target_id:report.conversation_id,decision,decided_by:identity.userId};
  }
}
