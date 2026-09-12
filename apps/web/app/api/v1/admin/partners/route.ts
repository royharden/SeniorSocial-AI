import type { PartnerInput } from '../../../../../../../packages/admin/src/index.ts';
import { adminContext, adminMutationContext, adminResponse, adminRuntime, idempotencyKey, jsonInput, okay, type AdminService } from '../users/_shared';
export const dynamic='force-dynamic'; export const runtime='nodejs';
export function createPartnerHandlers(service:()=>AdminService=adminRuntime,context=adminContext){return {
  GET:async(request:Request)=>{try{return okay(await service().listPartners(await context(request)));}catch(error){return adminResponse(error);}},
  POST:async(request:Request)=>{try{const actor=await adminMutationContext(request);return okay(await service().createPartner(actor,await jsonInput<PartnerInput>(request),idempotencyKey(request)),201);}catch(error){return adminResponse(error);}},
};} const handlers=createPartnerHandlers(); export const GET=handlers.GET; export const POST=handlers.POST;
