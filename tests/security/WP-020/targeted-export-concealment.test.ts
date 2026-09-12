/* eslint-disable @typescript-eslint/unbound-method -- injected dependencies are Vitest spies */
import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {createDownloadHandler} from '../../../apps/web/app/api/v1/admin/exports/[exportId]/download/route.ts';
import {createGetExportHandler} from '../../../apps/web/app/api/v1/admin/exports/[exportId]/route.ts';
import {createReportingService,type ExportArtifact,type ExportJob,type ReportingActor,type ReportingRepository} from '../../../packages/reporting/src/index.ts';

const exportId='20000000-0000-4000-8000-000000000020';
const orgId='10000000-0000-4000-8000-000000000020';
const otherOrgId='90000000-0000-4000-8000-000000000020';
const artifactBytes=new TextEncoder().encode('{"safe":true}\n');
const aggregateJob:ExportJob={id:exportId,state:'ready',report_name:'channel-activity',format:'json',filters:{},as_of:'2026-09-11T12:00:00.000Z',source_version:'wp-020-source',included_channels:['screen'],completeness:'complete',known_omissions:[],overlap_uncertainty:[],row_count:1,content_digest:createHash('sha256').update(artifactBytes).digest('hex'),completeness_note:'complete',download_url:`/api/v1/admin/exports/${exportId}/download`,expires_at:'2026-09-12T12:00:00.000Z'};
const individualJob={id:exportId,state:'ready' as const,scope:['profile'] as const,completeness_note:'complete',download_url:`/api/v1/admin/exports/${exportId}/download`,expires_at:'2026-09-12T12:00:00.000Z'};
const individualArtifact={bytes:new TextEncoder().encode('{"profile":{}}\n'),contentType:'application/json',filename:'resident-export.json'};
const actor=(id:string,roles:readonly string[],tenant=orgId):ReportingActor=>({id,orgId:tenant,roles});
const target={params:Promise.resolve({exportId})};

function repository(overrides:Partial<ReportingRepository>={}):ReportingRepository{return{ingestSource:vi.fn(),snapshot:vi.fn(),storeExport:vi.fn(),findExport:vi.fn(()=>Promise.resolve(null)),loadExport:vi.fn(()=>Promise.resolve(null)),auditDownload:vi.fn(),...overrides};}
function individual(getResult:typeof individualJob|null=null,downloadResult:typeof individualArtifact|null=null){return{create:vi.fn(),get:vi.fn(()=>Promise.resolve(getResult)),download:vi.fn(()=>Promise.resolve(downloadResult))};}

describe('WP-020 targeted export concealment',()=>{
  it.each([
    ['resident',actor('30000000-0000-4000-8000-000000000020',['senior'])],
    ['caregiver without exports.read',actor('30000000-0000-4000-8000-000000000021',['caregiver'])],
    ['staff clerk selector mismatch',actor('30000000-0000-4000-8000-000000000022',['staff'])],
    ['staff dispatcher with revoked authority',actor('30000000-0000-4000-8000-000000000023',['staff'])],
    ['demo reviewer targeting another organization',actor('30000000-0000-4000-8000-000000000024',['admin'],otherOrgId)]
  ] as const)('gives %s the identical opaque response for status and download when the target is unavailable',async(_label,requestActor)=>{
    const aggregate={getExport:vi.fn(()=>Promise.resolve(null)),downloadExport:vi.fn(()=>Promise.resolve(null))};
    const personal=individual();
    const context=vi.fn(()=>Promise.resolve(requestActor));
    const status=await createGetExportHandler((()=>aggregate) as never,context,()=>personal)(new Request(`http://localhost/api/v1/admin/exports/${exportId}`),target);
    const download=await createDownloadHandler((()=>aggregate) as never,context,()=>personal)(new Request(`http://localhost/api/v1/admin/exports/${exportId}/download`),target);
    for(const response of [status,download]){expect(response.status).toBe(404);expect(response.headers.get('cache-control')).toBe('no-store');expect(response.headers.get('content-disposition')).toBeNull();expect(await response.json()).toEqual({type:'about:blank',title:'Not Found',status:404});}
    expect(personal.get).toHaveBeenCalledOnce();expect(personal.download).toHaveBeenCalledOnce();
  });

  it('conceals aggregate targets from callers without aggregate authority before repository access or audit',async()=>{
    const repo=repository();const service=createReportingService(repo);
    const resident=actor('30000000-0000-4000-8000-000000000020',['senior']);
    await expect(service.getExport(resident,exportId)).resolves.toBeNull();
    await expect(service.downloadExport(resident,exportId,'application/json')).resolves.toBeNull();
    expect(repo.findExport).not.toHaveBeenCalled();expect(repo.loadExport).not.toHaveBeenCalled();expect(repo.auditDownload).not.toHaveBeenCalled();
  });

  it('keeps cross-organization aggregate lookup tenant-scoped and unaudited when absent',async()=>{
    const repo=repository();const service=createReportingService(repo);const reviewer=actor('30000000-0000-4000-8000-000000000024',['admin'],otherOrgId);
    await expect(service.getExport(reviewer,exportId)).resolves.toBeNull();await expect(service.downloadExport(reviewer,exportId,'application/json')).resolves.toBeNull();
    expect(repo.findExport).toHaveBeenCalledWith(otherOrgId,exportId);expect(repo.loadExport).toHaveBeenCalledWith(otherOrgId,exportId);expect(repo.auditDownload).not.toHaveBeenCalled();
  });

  it('preserves same-organization admin aggregate status and exact artifact release',async()=>{
    const aggregate={getExport:vi.fn(()=>Promise.resolve(aggregateJob)),downloadExport:vi.fn(()=>Promise.resolve({job:aggregateJob,contentType:'application/json; charset=utf-8',bytes:artifactBytes} satisfies ExportArtifact))};
    const personal=individual();const admin=actor('30000000-0000-4000-8000-000000000030',['admin']);const context=vi.fn(()=>Promise.resolve(admin));
    const status=await createGetExportHandler((()=>aggregate) as never,context,()=>personal)(new Request(`http://localhost/api/v1/admin/exports/${exportId}`),target);
    const download=await createDownloadHandler((()=>aggregate) as never,context,()=>personal)(new Request(`http://localhost/api/v1/admin/exports/${exportId}/download`,{headers:{accept:'application/json'}}),target);
    expect(status.status).toBe(200);expect(await status.json()).toEqual(aggregateJob);expect(download.status).toBe(200);expect(new Uint8Array(await download.arrayBuffer())).toEqual(artifactBytes);expect(personal.get).not.toHaveBeenCalled();expect(personal.download).not.toHaveBeenCalled();
  });

  it.each([
    ['resident',actor('30000000-0000-4000-8000-000000000040',['senior'])],
    ['authorized staff member',actor('30000000-0000-4000-8000-000000000041',['staff'])]
  ] as const)('preserves individually authorized %s status and download',async(_label,requestActor)=>{
    const aggregate={getExport:vi.fn(()=>Promise.resolve(null)),downloadExport:vi.fn(()=>Promise.resolve(null))};const personal=individual(individualJob,individualArtifact);const context=vi.fn(()=>Promise.resolve(requestActor));
    const status=await createGetExportHandler((()=>aggregate) as never,context,()=>personal)(new Request(`http://localhost/api/v1/admin/exports/${exportId}`),target);
    const download=await createDownloadHandler((()=>aggregate) as never,context,()=>personal)(new Request(`http://localhost/api/v1/admin/exports/${exportId}/download`),target);
    expect(status.status).toBe(200);expect(await status.json()).toEqual(individualJob);expect(download.status).toBe(200);expect(new Uint8Array(await download.arrayBuffer())).toEqual(individualArtifact.bytes);
  });
});
