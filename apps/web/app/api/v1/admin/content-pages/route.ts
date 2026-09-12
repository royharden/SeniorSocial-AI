import type { ContentPageInput } from '../../../../../../../packages/admin/src/index.ts';
import { adminContext, adminMutationContext, adminResponse, adminRuntime, idempotencyKey, jsonInput, okay, type AdminService } from '../users/_shared';
export const dynamic='force-dynamic'; export const runtime='nodejs';
export function createContentPagesHandlers(service:()=>AdminService=adminRuntime,context=adminContext){return {
  GET:async(request:Request)=>{try{return okay(await service().listContentPages(await context(request)));}catch(error){return adminResponse(error);}},
  POST:async(request:Request)=>{try{const actor=await adminMutationContext(request);return okay(await service().createContentPage(actor,await jsonInput<ContentPageInput>(request),idempotencyKey(request)),201);}catch(error){return adminResponse(error);}},
};} const handlers=createContentPagesHandlers(); export const GET=handlers.GET; export const POST=handlers.POST;
