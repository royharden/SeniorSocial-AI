export const DEFAULT_REPORT_SUPPRESSION_THRESHOLD = 11;
export const reportNames = ['channel-activity'] as const;
export const exportFormats = ['json', 'csv'] as const;
export type ReportName = typeof reportNames[number];
export type ExportFormat = typeof exportFormats[number];
export type Completeness = 'complete' | 'partial' | 'unknown';

export interface ReportingActor { id: string; orgId: string; roles: readonly string[] }
export interface ReportFilters { from: string | null; to: string | null; channels: readonly string[] }
export interface PublicReportFilters { from?:string;to?:string;channels?:readonly string[] }
export interface ActivityFact { period: string; channel: string; metric: string; count: number }
export interface ChannelCoverage { channel: string; completeness: Completeness; sourceVersion: string; evidence: string; coverageFrom:string|null;coverageTo:string|null;knownOmission: string | null; overlapUncertainty: string | null }
export interface AggregateSourceFact { period:string;channel:string;metric:string;count:number;evidence:string }
export interface AggregateSourceCoverage { channel:string;from:string;to:string;completeness:Completeness;evidence:string;knownOmission?:string|null;overlapUncertainty?:string|null }
export interface AggregateSourceImport { sourceVersion:string;facts:readonly AggregateSourceFact[];coverage:readonly AggregateSourceCoverage[] }
export interface NormalizedAggregateSourceImport { sourceVersion:string;facts:readonly AggregateSourceFact[];coverage:readonly Required<AggregateSourceCoverage>[] }
export type AggregateSourceImportResult='created'|'replayed';
export interface ReportSnapshot { asOf: string; facts: readonly ActivityFact[]; coverage: readonly ChannelCoverage[] }
export interface ReportRow { period: string; channel: string; metric: string; count: number | null; suppressed: boolean; suppression_reason: string | null }
export interface ReportMetadata {
  filters: PublicReportFilters;
  scope: 'tenant_aggregate';
  as_of: string;
  source_version: string;
  evidence: readonly string[];
  included_channels: readonly string[];
  completeness: Completeness;
  known_omissions: readonly string[];
  overlap_uncertainty: readonly string[];
  suppression_threshold: number;
}
export type CanonicalReport = { name:ReportName;generated_at:string;unit_definitions:Readonly<Record<string,string>>;known_gaps:readonly string[];rows:readonly ReportRow[] } & ReportMetadata;
export interface RenderedExport { format: ExportFormat; contentType: string; bytes: Uint8Array; report: CanonicalReport }
export interface AggregateExportRequest { report_name:'channel-activity';format:ExportFormat;filters:{from?:string|null;to?:string|null;channels?:readonly string[]} }
export interface ExportJob { id:string;state:'queued'|'running'|'ready'|'failed';report_name:'channel-activity';format:ExportFormat;filters:PublicReportFilters;as_of:string;source_version:string;included_channels:readonly string[];completeness:Completeness;known_omissions:readonly string[];overlap_uncertainty:readonly string[];row_count:number;content_digest:string;completeness_note:string;download_url:string|null;expires_at:string|null }
export interface ExportArtifact { job:ExportJob;contentType:string;bytes:Uint8Array }
export interface ReportingRepository {
  ingestSource(orgId:string,actorId:string,input:NormalizedAggregateSourceImport,requestHash:string):Promise<AggregateSourceImportResult>;
  snapshot(orgId: string, filters: ReportFilters): Promise<ReportSnapshot>;
  storeExport(input: { orgId:string;actorId:string;id:string;idempotencyKey:string;requestHash:string;format:ExportFormat;rendered:RenderedExport;expiresAt:string;contentDigest:string }): Promise<ExportJob>;
  findExport(orgId: string, id: string): Promise<ExportJob|null>;
  loadExport(orgId:string,id:string):Promise<ExportArtifact|null>;
  auditDownload(orgId:string,actorId:string,job:ExportJob):Promise<void>;
}
