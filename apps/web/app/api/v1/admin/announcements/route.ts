import type { AnnouncementInput } from '../../../../../../../packages/admin/src/index.ts';
import { adminContext, adminMutationContext, adminResponse, adminRuntime, idempotencyKey, jsonInput, okay, type AdminService } from '../users/_shared';
export const dynamic='force-dynamic'; export const runtime='nodejs';
export function createAnnouncementHandlers(service:()=>AdminService=adminRuntime,context=adminContext){return {
  GET:async(request:Request)=>{try{return okay(await service().listAnnouncements(await context(request)));}catch(error){return adminResponse(error);}},
  POST:async(request:Request)=>{try{const actor=await adminMutationContext(request);return okay(await service().createAnnouncement(actor,await jsonInput<AnnouncementInput>(request),idempotencyKey(request)),201);}catch(error){return adminResponse(error);}},
};} const handlers=createAnnouncementHandlers(); export const GET=handlers.GET; export const POST=handlers.POST;
