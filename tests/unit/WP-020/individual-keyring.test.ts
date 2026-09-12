import {Buffer} from 'node:buffer';
import {describe,expect,it} from 'vitest';
import {EnvironmentExportKeys} from '../../../packages/reporting/src/index.ts';
import {InMemoryIndividualExportStore,IndividualExportService,type ExportActor,type IndividualExportSnapshot} from '../../../packages/individual-exports/src/index.ts';

const actor:ExportActor={orgId:'22222222-2222-4222-8222-222222222222',userId:'11111111-1111-4111-8111-111111111111',roles:['senior']};
const now=new Date('2026-09-11T12:00:00.000Z');
const snapshot:IndividualExportSnapshot={asOf:now.toISOString(),sourceVersion:'snapshot-v1',rows:{profile:[{id:actor.userId,display_name:'Resident'}],requests:[],consent_grants:[],consent_history:[],ai_recommendations:[],audit_events:[],proposals:[]},counts:{profile:1,requests:0,consent_grants:0,consent_history:0,ai_recommendations:0,audit_events:0,proposals:0}};
const authority={resolveSelection:()=>Promise.resolve({orgId:actor.orgId,subjectId:actor.userId,profile:true as const})};

describe('WP-020 retained export keyring',()=>{
  it('releases a v1 artifact after v2 becomes current while v1 remains retained',async()=>{const v1=Buffer.alloc(32,1).toString('base64'),v2=Buffer.alloc(32,2).toString('base64');const store=new InMemoryIndividualExportStore(()=>true,()=>now);const common={authority,snapshots:{readRepeatableReadSnapshot:()=>Promise.resolve(snapshot)},store,clock:{now:()=>now},ids:{next:()=> '33333333-3333-4333-8333-333333333333'}};const created=await new IndividualExportService({...common,keys:new EnvironmentExportKeys(`current=v1;v1=${v1}`)}).create(actor,{scope:['profile'],format:'json'});const released=await new IndividualExportService({...common,keys:new EnvironmentExportKeys(`current=v2;v1=${v1};v2=${v2}`)}).release(actor,created.id);expect(released.contentType).toBe('application/json');expect(new TextDecoder().decode(released.bytes)).toContain('Resident');});

  it.each([undefined,'current=v1','current=v1;v1=bad','current=v2;v1='+Buffer.alloc(32,1).toString('base64'),'current=v1;v1='+Buffer.alloc(32,1).toString('base64')+';v1='+Buffer.alloc(32,2).toString('base64')])('fails closed for malformed, missing-current, or duplicate keyring entries',value=>{expect(()=>new EnvironmentExportKeys(value)).toThrow(/keyring/iu);});
});
