import {reportingError,reportingRuntime} from '../../reports/_runtime';
import {exportActor,exportContext,individualProblem,individualRuntime} from '../_individual';
export const dynamic='force-dynamic';export const runtime='nodejs';
const missing=()=>Response.json({type:'about:blank',title:'Not Found',status:404},{status:404,headers:{'cache-control':'no-store','content-type':'application/problem+json'}});
export function createGetExportHandler(service=reportingRuntime,context=exportContext,individual=individualRuntime){return async(request:Request,{params}:{params:Promise<{exportId:string}>})=>{try{const {exportId}=await params;const actor=await context(request);if(actor.roles.includes('admin')){const aggregate=await service().getExport(actor,exportId);if(aggregate)return Response.json(aggregate,{headers:{'cache-control':'no-store'}});}const result=await individual().get(exportActor(actor),exportId);return result?Response.json(result,{headers:{'cache-control':'no-store'}}):missing();}catch(error){return individualProblem(error)??reportingError(error);}};}
export const GET=createGetExportHandler();
