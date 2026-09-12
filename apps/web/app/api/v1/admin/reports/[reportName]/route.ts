import {filtersFromUrl,reportingContext,reportingError,reportingRuntime} from '../_runtime';
export const dynamic='force-dynamic';export const runtime='nodejs';
export function createReportHandler(service=reportingRuntime,context=reportingContext){return async(request:Request,{params}:{params:Promise<{reportName:string}>})=>{try{const {reportName}=await params;const result=await service().report(await context(request),reportName,filtersFromUrl(new URL(request.url)));return Response.json(result,{headers:{'cache-control':'no-store'}});}catch(error){return reportingError(error);}};}
export const GET=createReportHandler();
