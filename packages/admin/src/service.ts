import type { AdminActor, AdminRepository, AnnouncementInput, ContentPageInput, FaqInput, PartnerInput, UserPatch } from './types.ts';
import { mutationMetadata } from './mutation.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const roles = new Set(['senior', 'caregiver', 'staff', 'admin', 'partner', 'support']);
export class AdminForbidden extends Error {}
export class AdminInvalid extends Error {}
function authorize(actor: AdminActor): void {
  if (!uuid.test(actor.id) || !uuid.test(actor.orgId) || !actor.roles.some(role => role === 'staff' || role === 'admin')) throw new AdminForbidden();
}
function validateIdentity(actor:AdminActor):void{if(!uuid.test(actor.id)||!uuid.test(actor.orgId))throw new AdminForbidden();}
function required(value: string, name: string, max = 500): string {
  const clean = value.trim();
  if (!clean || clean.length > max || /[\r\n]/u.test(clean)) throw new AdminInvalid(`${name} is invalid`);
  return clean;
}
export function createAdminService(repository: AdminRepository) {
  return {
    listUsers: async (actor: AdminActor) => { authorize(actor); return repository.listUsers(actor.orgId); },
    updateUser: async (actor: AdminActor, id: string, patch: UserPatch) => {
      validateIdentity(actor);if(!uuid.test(id))throw new AdminInvalid('invalid user update');
      const target=await repository.findUser(actor.orgId,id);if(!target)return null;
      authorize(actor);if(id === actor.id && patch.account_state === 'held_for_review') throw new AdminInvalid('invalid user update');
      if (patch.account_state !== undefined && !['active', 'held_for_review'].includes(patch.account_state)) throw new AdminInvalid('invalid account state');
      if (patch.roles !== undefined && (!actor.roles.includes('admin') || patch.roles.length < 1 || new Set(patch.roles).size !== patch.roles.length || patch.roles.some(role => !roles.has(role)))) throw new AdminInvalid('roles are invalid');
      if(!Number.isSafeInteger(patch.expected_version)||patch.expected_version<1)throw new AdminInvalid('expected_version is invalid');
      return repository.updateUser(actor.orgId, actor.id, id, patch, mutationMetadata('user.patch',{id,patch},`user-patch.${id}.${patch.expected_version}`,patch.expected_version));
    },
    listContentPages: async (actor: AdminActor) => { authorize(actor); return repository.listContentPages(actor.orgId); },
    createContentPage: async (actor: AdminActor, input: ContentPageInput,idempotencyKey:string) => { authorize(actor); const slug=required(input.slug, 'slug', 100); if(!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug)) throw new AdminInvalid('slug is invalid'); const clean={...input,slug};return repository.createContentPage(actor.orgId, actor.id, clean,mutationMetadata('content-page.create',clean,idempotencyKey)); },
    listFaqs: async (actor: AdminActor) => { authorize(actor); return repository.listFaqs(actor.orgId); },
    createFaq: async (actor: AdminActor, input: FaqInput,idempotencyKey:string) => { authorize(actor); const clean={question:required(input.question,'question'),answer:required(input.answer,'answer',4000)};return repository.createFaq(actor.orgId,actor.id,clean,mutationMetadata('faq.create',clean,idempotencyKey)); },
    listAnnouncements: async (actor: AdminActor) => { authorize(actor); return repository.listAnnouncements(actor.orgId); },
    createAnnouncement: async (actor: AdminActor, input: AnnouncementInput,idempotencyKey:string) => { authorize(actor); if (Number.isNaN(Date.parse(input.publish_at))) throw new AdminInvalid('publish_at is invalid');const clean={title:required(input.title,'title'),publish_at:new Date(input.publish_at).toISOString()};return repository.createAnnouncement(actor.orgId,actor.id,clean,mutationMetadata('announcement.create',clean,idempotencyKey)); },
    listPartners: async (actor: AdminActor) => { authorize(actor); return repository.listPartners(actor.orgId); },
    createPartner: async (actor: AdminActor, input: PartnerInput,idempotencyKey:string) => { authorize(actor);const clean={name:required(input.name,'name'),contact:required(input.contact,'contact'),categories:[...new Set(input.categories??[])].map(value=>required(value,'category',100))};return repository.createPartner(actor.orgId,actor.id,clean,mutationMetadata('partner.create',clean,idempotencyKey)); },
    analytics: async (actor: AdminActor) => { authorize(actor); return repository.analytics(actor.orgId); },
  };
}
