import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import { buildCanonicalReport,normalizeFilters } from './canonical.ts';
import { renderReport } from './serialize.ts';
import { DEFAULT_REPORT_SUPPRESSION_THRESHOLD,exportFormats,reportNames,type AggregateExportRequest,type ReportFilters,type ReportingActor,type ReportingRepository } from './types.ts';
import {assertChannelActivityReport} from './validation.ts';
import {aggregateSourceRequestHash,normalizeAggregateSourceImport} from './source-import.ts';
import type {AggregateSourceImport} from './types.ts';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export class ReportingForbidden extends Error{}
export class ReportingInvalid extends Error{}
export class ReportingConflict extends Error{}
export class ReportingNotReady extends Error{}
export class ReportingExpired extends Error{}
export class ReportingNotAcceptable extends Error{}
export class ReportingUnavailable extends Error{}
function authorize(actor:ReportingActor):void{if(!uuid.test(actor.id)||!uuid.test(actor.orgId)||!actor.roles.includes('admin'))throw new ReportingForbidden();}
function mayReadTarget(actor:ReportingActor):boolean{return uuid.test(actor.id)&&uuid.test(actor.orgId)&&actor.roles.includes('admin');}
export function createReportingService(repository:ReportingRepository,threshold=DEFAULT_REPORT_SUPPRESSION_THRESHOLD,now=()=>new Date()){
  async function report(actor:ReportingActor,name:string,filters:ReportFilters){authorize(actor);if(!reportNames.includes(name as never))throw new ReportingInvalid('unknown report');let normalized;try{normalized=normalizeFilters(filters);}catch{throw new ReportingInvalid('invalid filters');}const snapshot=await repository.snapshot(actor.orgId,normalized);if(normalized.from&&(Date.parse(normalized.from)>=Date.parse(snapshot.asOf)||Date.parse(snapshot.asOf)-Date.parse(normalized.from)>366*86_400_000)||normalized.to&&Date.parse(normalized.to)>Date.parse(snapshot.asOf))throw new ReportingInvalid('report window exceeds available snapshot');const result=buildCanonicalReport(snapshot,normalized,threshold);assertChannelActivityReport(result);return result;}
  return{
    report,
    ingestSource:async(actor:ReportingActor,input:AggregateSourceImport)=>{authorize(actor);let normalized;try{normalized=normalizeAggregateSourceImport(input);}catch{throw new ReportingInvalid('invalid aggregate source import');}return repository.ingestSource(actor.orgId,actor.id,normalized,aggregateSourceRequestHash(normalized));},
    createExport:async(actor:ReportingActor,input:AggregateExportRequest,idempotencyKey:string)=>{authorize(actor);if(input.report_name!=='channel-activity'||!exportFormats.includes(input.format)||!idempotencyKey||idempotencyKey.length>160||!/^[A-Za-z0-9._~-]+$/u.test(idempotencyKey))throw new ReportingInvalid('invalid aggregate export request');let filters;try{filters=normalizeFilters({from:input.filters.from??null,to:input.filters.to??null,channels:input.filters.channels??[]});}catch{throw new ReportingInvalid('invalid filters');}const normalized={report_name:input.report_name,format:input.format,filters};const requestHash=createHash('sha256').update(JSON.stringify(normalized)).digest('hex');const canonical=await report(actor,input.report_name,filters);const rendered=renderReport(canonical,input.format);const contentDigest=createHash('sha256').update(rendered.bytes).digest('hex');const id=randomUUID();const expiresAt=new Date(now().valueOf()+24*60*60*1000).toISOString();return repository.storeExport({orgId:actor.orgId,actorId:actor.id,id,idempotencyKey,requestHash,format:rendered.format,rendered,expiresAt,contentDigest});},
    getExport:async(actor:ReportingActor,id:string)=>{if(!mayReadTarget(actor))return null;if(!uuid.test(id))throw new ReportingInvalid('invalid export id');return repository.findExport(actor.orgId,id);},
    downloadExport:async(actor:ReportingActor,id:string,accept:string|null)=>{if(!mayReadTarget(actor))return null;if(!uuid.test(id))throw new ReportingInvalid('invalid export id');const artifact=await repository.loadExport(actor.orgId,id);if(!artifact)return null;if(artifact.job.state!=='ready')throw new ReportingNotReady();if(artifact.job.expires_at&&new Date(artifact.job.expires_at)<=now())throw new ReportingExpired();const accepted=accept===null||accept==='*/*'||accept.split(',').some(value=>artifact.contentType.startsWith(value.trim().split(';')[0]??''));if(!accepted)throw new ReportingNotAcceptable();const actual=createHash('sha256').update(artifact.bytes).digest();const expected=Buffer.from(artifact.job.content_digest,'hex');if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw new ReportingNotReady('artifact digest mismatch');await repository.auditDownload(actor.orgId,actor.id,artifact.job);return artifact;}
  };
}
