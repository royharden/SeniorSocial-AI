import type { FaqInput } from '../../../../../../../packages/admin/src/index.ts';
import { adminContext, adminMutationContext, adminResponse, adminRuntime, idempotencyKey, jsonInput, okay, type AdminService } from '../users/_shared';
export const dynamic='force-dynamic'; export const runtime='nodejs';
export function createFaqHandlers(service:()=>AdminService=adminRuntime,context=adminContext){return {
  GET:async(request:Request)=>{try{return okay(await service().listFaqs(await context(request)));}catch(error){return adminResponse(error);}},
  POST:async(request:Request)=>{try{const actor=await adminMutationContext(request);return okay(await service().createFaq(actor,await jsonInput<FaqInput>(request),idempotencyKey(request)),201);}catch(error){return adminResponse(error);}},
};} const handlers=createFaqHandlers(); export const GET=handlers.GET; export const POST=handlers.POST;
