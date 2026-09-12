import { adminContext, adminResponse, adminRuntime, okay, type AdminService } from '../users/_shared';
export const dynamic='force-dynamic'; export const runtime='nodejs';
export function createAnalyticsHandler(service:()=>AdminService=adminRuntime,context=adminContext){return async(request:Request)=>{try{return okay(await service().analytics(await context(request)));}catch(error){return adminResponse(error);}};} export const GET=createAnalyticsHandler();
