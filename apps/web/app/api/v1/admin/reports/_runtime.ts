import { createDatabaseClient } from '@seniorsocial/db';
import { adminContext } from '../users/_shared';
import { PostgresReportingRepository,ReportingConflict,ReportingExpired,ReportingForbidden,ReportingInvalid,ReportingNotAcceptable,ReportingNotReady,ReportingUnavailable,createReportingService,type ReportingActor } from '../../../../../../../packages/reporting/src/index.ts';
let service:ReturnType<typeof createReportingService>|undefined;
function threshold():number{const raw=process.env.SENIORSOCIAL_ANALYTICS_K;if(raw===undefined)return 11;const value=Number(raw);if(!Number.isSafeInteger(value)||value<2||value>1000)throw new Error('invalid reporting threshold');return value;}
export function reportingRuntime(){service??=createReportingService(new PostgresReportingRepository(createDatabaseClient()),threshold());return service;}
export async function reportingContext(request:Request):Promise<ReportingActor>{return adminContext(request);}
export function reportingError(error:unknown):Response{const status=error instanceof ReportingForbidden?403:error instanceof ReportingNotAcceptable?406:error instanceof ReportingNotReady||error instanceof ReportingConflict?409:error instanceof ReportingExpired?410:error instanceof ReportingInvalid?422:error instanceof ReportingUnavailable?503:500;const title=status===403?'Forbidden':status===406?'Not Acceptable':status===409?'Conflict':status===410?'Gone':status===422?'Unprocessable Entity':'Service unavailable';return Response.json({type:'about:blank',title,status},{status,headers:{'cache-control':'no-store','content-type':'application/problem+json'}});}
export function filtersFromUrl(url:URL){return{from:url.searchParams.get('from'),to:url.searchParams.get('to'),channels:url.searchParams.getAll('channel')};}
