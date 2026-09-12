/* eslint-disable @typescript-eslint/unbound-method -- repository methods are Vitest spies */
import type {AuthRole,SessionRecord} from '../../../packages/auth/src/index.ts';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {createTargetMutationContext,createUpdateUserHandler} from '../../../apps/web/app/api/v1/admin/users/[userId]/route.ts';
import {AdminForbidden,AdminInvalid,createAdminService,type AdminActor,type AdminRepository,type AdminUser} from '../../../packages/admin/src/index.ts';

const orgA='10000000-0000-4000-8000-000000000019';
const orgB='20000000-0000-4000-8000-000000000019';
const actorId='30000000-0000-4000-8000-000000000019';
const sameOrgId='40000000-0000-4000-8000-000000000019';
const foreignId='50000000-0000-4000-8000-000000000019';
const unknownId='60000000-0000-4000-8000-000000000019';
const target:AdminUser={id:sameOrgId,org_id:orgA,display_name:'Same tenant user',roles:['senior'],account_state:'active',version:1};
const page={items:[],meta:{next_cursor:null,total_known:true}};
const actor=(roles:readonly string[]):AdminActor=>({id:actorId,orgId:orgA,roles});
const patch={account_state:'held_for_review' as const,expected_version:1};
const route=(userId:string)=>({params:Promise.resolve({userId})});
const request=(body:unknown=patch,headers:Record<string,string>={})=>new Request(`http://localhost/api/v1/admin/users/${foreignId}`,{method:'PATCH',headers:{'content-type':'application/json',origin:'http://localhost',cookie:'ss_session=server-session-token',...headers},body:typeof body==='string'?body:JSON.stringify(body)});
const session=(roles:readonly AuthRole[],overrides:Partial<SessionRecord>={}):SessionRecord=>({userId:actorId,orgId:orgA,roles:[...roles],expiresAt:new Date('2026-09-12T00:00:00.000Z'),isDemo:false,...overrides});
const context=(roles:readonly AuthRole[],overrides:Partial<SessionRecord>={})=>createTargetMutationContext(vi.fn((orgId,token)=>{expect(orgId).toBe(orgA);expect(token).toBe('server-session-token');return Promise.resolve(session(roles,overrides));}));

function repository(find:(orgId:string,userId:string)=>Promise<AdminUser|null>):AdminRepository{return{listUsers:vi.fn(()=>Promise.resolve(page)),findUser:vi.fn(find),updateUser:vi.fn((_orgId,_actorId,_userId,value)=>Promise.resolve({...target,...value,version:2} as AdminUser)),listContentPages:vi.fn(()=>Promise.resolve(page)),createContentPage:vi.fn(),listFaqs:vi.fn(()=>Promise.resolve(page)),createFaq:vi.fn(),listAnnouncements:vi.fn(()=>Promise.resolve(page)),createAnnouncement:vi.fn(),listPartners:vi.fn(()=>Promise.resolve(page)),createPartner:vi.fn(),analytics:vi.fn(()=>Promise.resolve({tiles:[],as_of:new Date(0).toISOString(),source_version:'test'}))};}

describe('WP-019 profile target concealment',()=>{
  beforeEach(()=>vi.stubEnv('SENIORSOCIAL_ORG_ID',orgA));afterEach(()=>vi.unstubAllEnvs());

  it.each(['senior','caregiver','staff','admin','partner','support'] as const)('returns the same opaque 404 to an org-A %s addressing a real org-B id',async role=>{
    const repo=repository((tenant,userId)=>{if(tenant!==orgA)throw new Error('cross-tenant lookup attempted');return Promise.resolve(userId===foreignId?null:target);});const service=createAdminService(repo);
    const response=await createUpdateUserHandler(()=>service,context([role]))(request(),route(foreignId));
    expect(response.status).toBe(404);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.json()).toEqual({type:'about:blank',title:'Not found',status:404});
    expect(repo.findUser).toHaveBeenCalledWith(orgA,foreignId);expect(repo.updateUser).not.toHaveBeenCalled();
  });

  it.each(['senior','caregiver','partner','support'] as const)('retains 403 for same-tenant %s without update authority',async role=>{
    const repo=repository(()=>Promise.resolve(target));const service=createAdminService(repo);const response=await createUpdateUserHandler(()=>service,context([role]))(request(),route(sameOrgId));
    expect(response.status).toBe(403);expect(response.headers.get('cache-control')).toBe('no-store');expect(await response.json()).toEqual({type:'about:blank',title:'Forbidden',status:403});expect(repo.updateUser).not.toHaveBeenCalled();
  });

  it('makes unknown same-tenant and known foreign targets publicly indistinguishable',async()=>{
    const repo=repository(()=>Promise.resolve(null));const service=createAdminService(repo);const handler=createUpdateUserHandler(()=>service,context(['admin']));
    const same=await handler(request(),route(unknownId));const foreign=await handler(request(),route(foreignId));
    expect(same.status).toBe(404);expect(foreign.status).toBe(404);expect(await same.text()).toBe(await foreign.text());expect(repo.updateUser).not.toHaveBeenCalled();
  });

  it('allows staff state updates and derives the tenant only from trusted context',async()=>{
    const repo=repository(()=>Promise.resolve(target));const service=createAdminService(repo);const body={...patch,org_id:orgB};
    const response=await createUpdateUserHandler(()=>service,context(['staff']))(request(body),route(sameOrgId));
    expect(response.status).toBe(200);expect(repo.findUser).toHaveBeenCalledWith(orgA,sameOrgId);expect(repo.updateUser).toHaveBeenCalledWith(orgA,actorId,sameOrgId,body,expect.any(Object));
  });

  it('allows admin role updates while retaining the staff role-edit restriction',async()=>{
    const repo=repository(()=>Promise.resolve(target));const service=createAdminService(repo);const rolePatch={roles:['senior','caregiver'],expected_version:1};
    await expect(service.updateUser(actor(['admin']),sameOrgId,rolePatch)).resolves.toMatchObject({roles:rolePatch.roles});
    await expect(service.updateUser(actor(['staff']),sameOrgId,rolePatch)).rejects.toBeInstanceOf(AdminInvalid);
    expect(repo.updateUser).toHaveBeenCalledTimes(1);
  });

  it('resolves the same-tenant target before disclosing insufficient privilege',async()=>{
    const order:string[]=[];const repo=repository(()=>{order.push('target');return Promise.resolve(target);});const service=createAdminService(repo);
    await expect(service.updateUser(actor(['senior']),sameOrgId,patch)).rejects.toBeInstanceOf(AdminForbidden);order.push('forbidden');expect(order).toEqual(['target','forbidden']);expect(repo.updateUser).not.toHaveBeenCalled();
  });

  it('authenticates before parsing the body and preserves missing-session and origin failures',async()=>{
    const repo=repository(()=>Promise.resolve(target));const service=createAdminService(repo);const lookup=vi.fn(()=>Promise.resolve(session(['admin'])));const handler=createUpdateUserHandler(()=>service,createTargetMutationContext(lookup));
    const missing=request('{',{cookie:''}),missingJson=vi.spyOn(missing,'json');const missingResponse=await handler(missing,route(sameOrgId));expect(missingResponse.status).toBe(403);expect(missingJson).not.toHaveBeenCalled();expect(lookup).not.toHaveBeenCalled();
    const crossOrigin=request(patch,{origin:'https://attacker.invalid'}),originJson=vi.spyOn(crossOrigin,'json');const originResponse=await handler(crossOrigin,route(sameOrgId));expect(originResponse.status).toBe(403);expect(originJson).not.toHaveBeenCalled();expect(lookup).not.toHaveBeenCalled();expect(repo.findUser).not.toHaveBeenCalled();
  });

  it.each([
    ['missing',null],
    ['wrong organization',session(['admin'],{orgId:orgB})],
    ['invalid user identity',session(['admin'],{userId:'not-a-uuid'})]
  ] as const)('rejects an authenticated but %s session before body parsing or target lookup',async(_label,invalidSession)=>{
    const repo=repository(()=>Promise.resolve(target));const service=createAdminService(repo);const malformed=request('{'),json=vi.spyOn(malformed,'json');const handler=createUpdateUserHandler(()=>service,createTargetMutationContext(vi.fn(()=>Promise.resolve(invalidSession))));const response=await handler(malformed,route(sameOrgId));
    expect(response.status).toBe(403);expect(json).not.toHaveBeenCalled();expect(repo.findUser).not.toHaveBeenCalled();
  });

  it('maps configured-org and authentication-service failures to the established unavailable response',async()=>{
    const repo=repository(()=>Promise.resolve(target));const service=createAdminService(repo);vi.stubEnv('SENIORSOCIAL_ORG_ID','not-a-uuid');const missingOrg=await createUpdateUserHandler(()=>service,createTargetMutationContext(vi.fn()))(request(),route(sameOrgId));expect(missingOrg.status).toBe(503);
    vi.stubEnv('SENIORSOCIAL_ORG_ID',orgA);const authDown=await createUpdateUserHandler(()=>service,createTargetMutationContext(vi.fn(()=>Promise.reject(new Error('down')))))(request(),route(sameOrgId));expect(authDown.status).toBe(503);expect(repo.findUser).not.toHaveBeenCalled();
  });
});
