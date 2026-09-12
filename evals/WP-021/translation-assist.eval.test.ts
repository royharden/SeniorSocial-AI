import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TranslationAiUnavailable, TranslationConflict, TranslationWorkflow, createTranslationAuthorizer, sourceHash, type TranslationDraft, type TranslationRepository, type TranslationSource } from '../../packages/i18n/src/index';

class EvalRepository implements TranslationRepository {
  sourceValue: TranslationSource | null = null; draftValue: TranslationDraft | null = null;
  list() { return Promise.resolve([]); }
  source(orgId: string, sourceId: string) { return Promise.resolve(this.sourceValue?.orgId===orgId && this.sourceValue.id===sourceId ? this.sourceValue : null); }
  draft(orgId: string, draftId: string) { return Promise.resolve(this.draftValue?.orgId===orgId && this.draftValue.id===draftId ? this.draftValue : null); }
  upsertSource(input: {orgId:string;key:string;text:string;hash:string;critical:boolean}) { this.sourceValue={id:randomUUID(),orgId:input.orgId,key:input.key,text:input.text,hash:sourceHash(input.text),version:1,critical:input.critical,updatedAt:new Date(0).toISOString()}; return Promise.resolve(this.sourceValue); }
  createDraft(input: {orgId:string;source:TranslationSource;text:string;provenance:'manual'|'machine';aiEventId:string|null;actorId:string}) { this.draftValue={id:randomUUID(),orgId:input.orgId,sourceId:input.source.id,sourceHash:input.source.hash,sourceVersion:input.source.version,text:input.text,provenance:input.provenance,machineGenerated:input.provenance==='machine',aiEventId:input.aiEventId,status:'draft',createdBy:input.actorId,createdAt:new Date(0).toISOString(),reviewedBy:null,reviewerQualification:null,reviewerNote:null,reviewedAt:null,publishedBy:null,publishedAt:null,publishable:false}; return Promise.resolve(this.draftValue); }
  approve() { return Promise.resolve(null); } publish() { return Promise.resolve(null); }
}

const monthNumber: Record<string,string>={january:'01',february:'02',march:'03',april:'04',may:'05',june:'06',july:'07',august:'08',september:'09',october:'10',november:'11',december:'12',enero:'01',febrero:'02',marzo:'03',abril:'04',mayo:'05',junio:'06',julio:'07',agosto:'08',septiembre:'09',octubre:'10',noviembre:'11',diciembre:'12'};
function fullDates(text:string): readonly string[] {
  const dates:string[]=[];
  for (const match of text.matchAll(/\b([A-Za-z]+)\s+(\d{1,2}),\s+(\d{4})\b/gu)) { const month=monthNumber[match[1]?.toLowerCase() ?? '']; if(month) dates.push(`${match[3]}-${month}-${match[2]?.padStart(2,'0')}`); }
  for (const match of text.matchAll(/\b(\d{1,2})\s+de\s+([A-Za-z]+)\s+de\s+(\d{4})\b/gu)) { const month=monthNumber[match[2]?.toLowerCase() ?? '']; if(month) dates.push(`${match[3]}-${month}-${match[1]?.padStart(2,'0')}`); }
  return dates.sort();
}
export function fidelityFailures(source:string,output:string): readonly string[] {
  const failures:string[]=[];
  const numbers=(value:string)=>[...value.matchAll(/\b\d+(?:-\d+)+|\b\d+\b/gu)].map(match=>match[0]).sort();
  const address=source.match(/\b\d+\s+[A-Za-z]+(?:\s+[A-Za-z]+){0,3}\s(?:Street|Avenue|Road|Boulevard|Drive)\b/u)?.[0];
  const sourceNegated=/\b(?:no|not|never)\b/iu.test(source); const outputNegated=/\b(?:no|not|never|nunca)\b/iu.test(output);
  if(JSON.stringify(numbers(source))!==JSON.stringify(numbers(output))) failures.push('numbers');
  if(JSON.stringify(fullDates(source))!==JSON.stringify(fullDates(output))) failures.push('full_date');
  if(address && !output.includes(address)) failures.push('address');
  if(sourceNegated!==outputNegated) failures.push('negation');
  return failures;
}

describe('WP-021 executable deterministic translation eval', () => {
  const actor={orgId:'11111111-1111-4111-8111-111111111111',userId:'11111111-1111-4111-8111-111111111101',roles:['staff']};
  const authorizer=createTranslationAuthorizer({resolve:()=>Promise.resolve({qualification:'Synthetic qualified reviewer',grantedBy:actor.userId})});

  it('executes AI-off manual drafting and critical machine hold behavior', async () => {
    // what_bug_this_catches: a fixture-only eval that never invokes the workflow transitions it claims to cover.
    const manualRepo=new EvalRepository(); const manual=new TranslationWorkflow(manualRepo,authorizer); const manualSource=await manual.updateSource(actor,{key:'office',text:'The office opens Monday.',critical:false});
    await expect(manual.draft(actor,{sourceId:manualSource.id,machine:true})).rejects.toBeInstanceOf(TranslationAiUnavailable);
    expect(await manual.draft(actor,{sourceId:manualSource.id,text:'La oficina abre el lunes.'})).toMatchObject({provenance:'manual',machineGenerated:false,status:'draft'});
    const machineRepo=new EvalRepository(); const gateway={translate:(request:{sourceVersion:string})=>Promise.resolve({outcome:'ok',text:'Llame al 911 ahora.',machineGenerated:true as const,sourceVersion:request.sourceVersion,eventId:randomUUID()})};
    const machine=new TranslationWorkflow(machineRepo,authorizer,gateway); const critical=await machine.updateSource(actor,{key:'danger',text:'Call 911 now.',critical:true}); const draft=await machine.draft(actor,{sourceId:critical.id,machine:true});
    expect(draft).toMatchObject({provenance:'machine',machineGenerated:true,status:'draft',publishable:false});
    await expect(machine.publish(actor,{draftId:draft.id,sourceHash:draft.sourceHash,sourceVersion:draft.sourceVersion})).rejects.toBeInstanceOf(TranslationConflict);
  });

  it('rejects adversarial translations that change or drop safety-critical facts', () => {
    // what_bug_this_catches: an eval rewarding fluent copy after it changes a phone, date, address, or negation.
    const source='Do not visit 125 Oak Street before September 18, 2026. Call 212-555-0198.';
    const good='No visite 125 Oak Street antes del 18 de septiembre de 2026. Llame al 212-555-0198.';
    expect(fidelityFailures(source,good)).toEqual([]);
    expect(fidelityFailures(source,good.replace('212-555-0198','212-555-0199'))).toContain('numbers');
    expect(fidelityFailures(source,good.replace('18 de septiembre de 2026','18 de 2026'))).toContain('full_date');
    expect(fidelityFailures(source,good.replace('125 Oak Street','125 Pine Street'))).toContain('address');
    expect(fidelityFailures(source,good.replace('No visite','Visite'))).toContain('negation');
  });
});
