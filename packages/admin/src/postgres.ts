import { withOrg, type DatabaseClient, type TenantTransaction } from '@seniorsocial/db';
import type { AdminRepository, AdminUser, AnalyticsTiles, Announcement, AnnouncementInput, ContentPage, ContentPageInput, Faq, FaqInput, MutationMetadata, Page, PartnerInput, UserPatch } from './types.ts';
import { analyticsFromSnapshot, DEFAULT_SUPPRESSION_THRESHOLD } from './analytics.ts';
import { AdminConflict, assertReplay, assertVersion } from './mutation.ts';

const page = <T>(items: T[]): Page<T> => ({ items, meta: { next_cursor: null, total_known: true } });
function contactValue(value:unknown):string{if(typeof value==='string')return value;if(typeof value==='object'&&value!==null&&'value'in value&&typeof value.value==='string')return value.value;throw new Error('partner contact has an invalid stored shape');}

async function audit(transaction: TenantTransaction, orgId: string, actorId: string, action: string, target: string, fields: string[], reason: string): Promise<void> {
  await transaction`
    insert into audit_events (actor, action, target, org_id, outcome, reason, fields)
    values (${`user:${actorId}`}, ${action}, ${target}, ${orgId}, 'allowed', ${reason}, ${fields})
  `;
}
async function beginMutation(transaction:TenantTransaction,orgId:string,actorId:string,operation:string,mutation:MutationMetadata):Promise<unknown>{const inserted=(await transaction<Array<{mutation_key:string}>>`insert into admin_mutations(org_id,actor_id,mutation_key,operation,request_hash) values(${orgId},${actorId},${mutation.idempotencyKey},${operation},${mutation.requestHash}) on conflict do nothing returning mutation_key`)[0];if(inserted)return null;const existing=(await transaction<Array<{operation:string;request_hash:string;resource_id:string|null;response_status:number|null;response_body:unknown}>>`select operation,request_hash,resource_id,response_status,response_body from admin_mutations where org_id=${orgId} and actor_id=${actorId} and operation=${operation} and mutation_key=${mutation.idempotencyKey} for update`)[0];if(!existing)throw new AdminConflict('idempotency record unavailable');assertReplay({operation:existing.operation,requestHash:existing.request_hash},{operation,requestHash:mutation.requestHash});if(!existing.resource_id||!existing.response_status||existing.response_body===null)throw new AdminConflict('idempotent request is still in progress');return existing.response_body;}
async function finishMutation(transaction:TenantTransaction,orgId:string,actorId:string,operation:string,mutation:MutationMetadata,resourceId:string,responseStatus:number,responseBody:unknown):Promise<void>{await transaction`update admin_mutations set resource_id=${resourceId},response_status=${responseStatus},response_body=${JSON.stringify(responseBody)}::jsonb where org_id=${orgId} and actor_id=${actorId} and operation=${operation} and mutation_key=${mutation.idempotencyKey} and resource_id is null`;}
async function loadUser(transaction:TenantTransaction,orgId:string,userId:string):Promise<AdminUser|null>{return(await transaction<AdminUser[]>`select u.id,u.org_id,u.display_name,u.account_state,u.admin_version as version,coalesce(array_agg(r.role order by r.role) filter(where r.role is not null),'{}')::text[] as roles from users u left join user_roles r on r.org_id=u.org_id and r.user_id=u.id where u.org_id=${orgId} and u.id=${userId} group by u.id`)[0]??null;}

export class PostgresAdminRepository implements AdminRepository {
  constructor(private readonly client: DatabaseClient,private readonly suppressionThreshold=DEFAULT_SUPPRESSION_THRESHOLD) {}

  async listUsers(orgId: string): Promise<Page<AdminUser>> {
    return withOrg(this.client, orgId, async transaction => page(await transaction<AdminUser[]>`
      select u.id, u.org_id, u.display_name, u.account_state, u.admin_version as version,
        coalesce(array_agg(r.role order by r.role) filter (where r.role is not null), '{}')::text[] as roles
      from users u left join user_roles r on r.org_id=u.org_id and r.user_id=u.id
      where u.org_id=${orgId} group by u.id order by u.display_name, u.id
    `));
  }

  async findUser(orgId:string,userId:string):Promise<AdminUser|null>{
    return withOrg(this.client,orgId,transaction=>loadUser(transaction,orgId,userId));
  }

  async updateUser(orgId: string, actorId: string, userId: string, patch: UserPatch, mutation:MutationMetadata): Promise<AdminUser | null> {
    return withOrg(this.client, orgId, async transaction => {
      const locked = (await transaction<Array<{id:string;version:number}>>`select id,admin_version as version from users where org_id=${orgId} and id=${userId} for update`)[0];
      if (!locked) return null;
      const replay=await beginMutation(transaction,orgId,actorId,'user.patch',mutation);if(replay)return replay as AdminUser;
      assertVersion(mutation.expectedVersion??0,locked.version);
      const current=await loadUser(transaction,orgId,userId);
      if (!current) throw new Error('locked user disappeared');
      const fields: string[] = [];
      if (patch.account_state !== undefined && patch.account_state !== current.account_state) {
        await transaction`update users set account_state=${patch.account_state} where org_id=${orgId} and id=${userId}`;
        fields.push('account_state');
        await audit(transaction, orgId, actorId, 'user.held_for_review', `user:${userId}`, ['account_state'], patch.account_state === 'held_for_review' ? 'account held for identity review' : 'account review hold released');
      }
      if (patch.roles !== undefined && [...patch.roles].sort().join('|') !== [...current.roles].sort().join('|')) {
        await transaction`delete from user_roles where org_id=${orgId} and user_id=${userId}`;
        for (const role of patch.roles) await transaction`insert into user_roles (org_id,user_id,role) values (${orgId},${userId},${role})`;
        fields.push('roles');
        await audit(transaction, orgId, actorId, 'user.role_changed', `user:${userId}`, ['roles'], 'operator changed account roles');
      }
      if(fields.length>0){const changed=(await transaction<Array<{version:number}>>`update users set admin_version=admin_version+1 where org_id=${orgId} and id=${userId} and admin_version=${locked.version} returning admin_version as version`)[0];if(!changed)throw new AdminConflict('stale version');}
      const result=await loadUser(transaction,orgId,userId);if(!result)throw new Error('updated user disappeared');await finishMutation(transaction,orgId,actorId,'user.patch',mutation,userId,200,result);return result;
    });
  }

  async listContentPages(orgId: string) { return withOrg(this.client, orgId, async tx => page(await tx<ContentPage[]>`
    select id,slug,version,critical from content_pages where org_id=${orgId} order by slug,id`)); }
  async createContentPage(orgId: string, actorId: string, input: ContentPageInput,mutation:MutationMetadata) { return withOrg(this.client, orgId, async tx => {
    const replay=await beginMutation(tx,orgId,actorId,'content-page.create',mutation);if(replay)return replay as ContentPage;
    const item=(await tx<ContentPage[]>`insert into content_pages(org_id,slug,critical,updated_by) values(${orgId},${input.slug},${input.critical ?? false},${actorId}) returning id,slug,version,critical`)[0];
    if(!item) throw new Error('content page write failed'); await audit(tx,orgId,actorId,'content.updated',`content_page:${item.id}`,['critical','slug','version'],'content page created');await finishMutation(tx,orgId,actorId,'content-page.create',mutation,item.id,201,item); return item; }); }
  async listFaqs(orgId: string) { return withOrg(this.client, orgId, async tx => page(await tx<Faq[]>`
    select id,question,answer,version from faqs where org_id=${orgId} order by question,id`)); }
  async createFaq(orgId: string, actorId: string, input: FaqInput,mutation:MutationMetadata) { return withOrg(this.client, orgId, async tx => {
    const replay=await beginMutation(tx,orgId,actorId,'faq.create',mutation);if(replay)return replay as Faq;
    const item=(await tx<Faq[]>`insert into faqs(org_id,question,answer,updated_by) values(${orgId},${input.question},${input.answer},${actorId}) returning id,question,answer,version`)[0];
    if(!item) throw new Error('FAQ write failed'); await audit(tx,orgId,actorId,'content.updated',`faq:${item.id}`,['answer','question','version'],'FAQ created');await finishMutation(tx,orgId,actorId,'faq.create',mutation,item.id,201,item); return item; }); }
  async listAnnouncements(orgId: string) { return withOrg(this.client, orgId, async tx => page(await tx<Announcement[]>`
    select id,title,publish_at::text,version from announcements where org_id=${orgId} order by publish_at desc,id`)); }
  async createAnnouncement(orgId: string, actorId: string, input: AnnouncementInput,mutation:MutationMetadata) { return withOrg(this.client, orgId, async tx => {
    const replay=await beginMutation(tx,orgId,actorId,'announcement.create',mutation);if(replay)return replay as Announcement;
    const item=(await tx<Announcement[]>`insert into announcements(org_id,title,publish_at,updated_by) values(${orgId},${input.title},${input.publish_at},${actorId}) returning id,title,publish_at::text,version`)[0];
    if(!item) throw new Error('announcement write failed'); await audit(tx,orgId,actorId,'content.updated',`announcement:${item.id}`,['publish_at','title','version'],'announcement created');await finishMutation(tx,orgId,actorId,'announcement.create',mutation,item.id,201,item); return item; }); }
  async listPartners(orgId: string) { return withOrg(this.client, orgId, async tx => page((await tx<Array<{id:string;name:string;categories:string[];contact:unknown;version:number}>>`
    select id,name,categories,contact,admin_version as version from partners where org_id=${orgId} order by name,id`).map(row=>({...row,contact:contactValue(row.contact)})))); }
  async createPartner(orgId: string, actorId: string, input: PartnerInput,mutation:MutationMetadata) { return withOrg(this.client, orgId, async tx => {
    const replay=await beginMutation(tx,orgId,actorId,'partner.create',mutation);if(replay)return replay as {id:string;name:string;categories:string[];contact:string;version:number};
    const rows=await tx<Array<{id:string;name:string;categories:string[];contact:unknown;version:number}>>`insert into partners(org_id,name,categories,contact) values(${orgId},${input.name},${input.categories ?? []},${JSON.stringify({value:input.contact})}::jsonb) returning id,name,categories,contact,admin_version as version`;
    const row=rows[0]; if(!row) throw new Error('partner write failed'); const result={...row,contact:input.contact};await audit(tx,orgId,actorId,'partner.updated',`partner:${row.id}`,['categories','contact','name','version'],'partner created');await finishMutation(tx,orgId,actorId,'partner.create',mutation,row.id,201,result); return result; }); }

  async analytics(orgId: string): Promise<AnalyticsTiles> {
    return withOrg(this.client, orgId, async tx => {
      const values=(await tx<Array<{as_of:string;users:number;content:number;partners:number;holds:number}>>`
        select statement_timestamp()::text as as_of,(select count(*)::int from users where org_id=${orgId}) users,
          ((select count(*) from content_pages where org_id=${orgId})+(select count(*) from faqs where org_id=${orgId})+(select count(*) from announcements where org_id=${orgId}))::int content,
          (select count(*)::int from partners where org_id=${orgId}) partners,
          (select count(*)::int from users where org_id=${orgId} and account_state='held_for_review') holds`)[0] ?? {as_of:new Date(0).toISOString(),users:0,content:0,partners:0,holds:0};
      return analyticsFromSnapshot({asOf:values.as_of,users:values.users,content:values.content,partners:values.partners,holds:values.holds},this.suppressionThreshold);
    });
  }
}
