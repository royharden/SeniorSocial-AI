import type {SessionRecord} from '@seniorsocial/auth';
import {readCookie,SESSION_COOKIE,withAuthService} from '../../../../../(auth)/auth/_shared';
import type {AdminActor,UserPatch} from '../../../../../../../../packages/admin/src/index.ts';
import {publicServiceContext,requireSameOrigin,ServiceContextUnavailable,ServiceForbidden} from '../../../services/_context';
import {adminResponse,adminRuntime,jsonInput,okay,type AdminService} from '../_shared';
export const dynamic = 'force-dynamic'; export const runtime = 'nodejs';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
type SessionLookup=(orgId:string,token:string)=>Promise<SessionRecord|null>;
const productionSession:SessionLookup=(orgId,token)=>withAuthService(orgId,service=>service.session(orgId,token));
export function createTargetMutationContext(sessionLookup:SessionLookup=productionSession){return async(request:Request):Promise<AdminActor>=>{
  requireSameOrigin(request);const {orgId}=publicServiceContext();const token=readCookie(request,SESSION_COOKIE);if(!token)throw new ServiceForbidden('authenticated session required');
  let session:SessionRecord|null;try{session=await sessionLookup(orgId,token);}catch{throw new ServiceContextUnavailable('authentication service is unavailable');}
  if(!session||session.orgId!==orgId||!uuid.test(session.userId)||!Array.isArray(session.roles)||session.roles.some(role=>typeof role!=='string'))throw new ServiceForbidden('valid same-organization session required');
  return{id:session.userId,orgId:session.orgId,roles:session.roles};
};}
export const targetMutationContext=createTargetMutationContext();
export function createUpdateUserHandler(service: () => AdminService = adminRuntime, context = targetMutationContext) {
  return async (request: Request, route: { params: Promise<{ userId: string }> }) => { try {
    const actor=await context(request); const {userId}=await route.params; const value=await service().updateUser(actor,userId,await jsonInput<UserPatch>(request));
    return value ? okay(value) : okay({type:'about:blank',title:'Not found',status:404},404);
  } catch(error){ return adminResponse(error); } };
}
export const PATCH=createUpdateUserHandler();
