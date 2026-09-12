import type {
  ExportSection, ExportTable, IndividualExportRequest, IndividualExportSnapshot,
  JsonObject, ResolvedExportSelection,
} from './types.ts';
import { IndividualExportFault, exportSections } from './types.ts';

export const MAX_PLAINTEXT_BYTES = 5 * 1024 * 1024;
export const MAX_EXPLICIT_RESOURCES = 50;
export const ARTIFACT_LIFETIME_MS = 24 * 60 * 60 * 1000;

const tablesBySection: Readonly<Record<ExportSection, readonly ExportTable[]>> = {
  profile: ['profile'],
  requests: ['requests'],
  consents: ['consent_grants', 'consent_history', 'ai_recommendations'],
  audit: ['audit_events'],
  proposals: ['proposals'],
};

export function validateRequest(request: IndividualExportRequest): void {
  if (request.format !== 'json' && request.format !== 'csv') invalid('format is invalid');
  if (request.scope.length === 0 || request.scope.length > exportSections.length) invalid('scope is invalid');
  const unique = new Set(request.scope);
  if (unique.size !== request.scope.length || request.scope.some((value) => !exportSections.includes(value))) {
    invalid('scope is invalid');
  }
}

export function requestedTables(scope: readonly ExportSection[]): ExportTable[] {
  return scope.flatMap((section) => [...tablesBySection[section]]);
}

export function validateSelection(
  request: IndividualExportRequest,
  actorOrgId: string,
  selection: ResolvedExportSelection,
): void {
  if (selection.orgId !== actorOrgId || !validId(selection.subjectId)) mismatch();
  const expected: Readonly<Record<ExportSection, boolean>> = {
    profile: selection.profile === true,
    requests: selection.requestIds !== undefined,
    consents: selection.consents === true,
    audit: selection.auditResourceIds !== undefined,
    proposals: selection.proposalIds !== undefined,
  };
  for (const section of exportSections) {
    if (request.scope.includes(section) !== expected[section]) mismatch();
  }
  const ids = [
    ...(selection.requestIds ?? []),
    ...(selection.auditResourceIds ?? []),
    ...(selection.proposalIds ?? []),
  ];
  if (ids.length + Number(selection.profile === true) + Number(selection.consents === true) > MAX_EXPLICIT_RESOURCES) {
    throw new IndividualExportFault(422, 'resource_limit', `select at most ${MAX_EXPLICIT_RESOURCES} resources`);
  }
  if (ids.some((id) => !validId(id)) ||
      hasDuplicates(selection.requestIds) || hasDuplicates(selection.auditResourceIds) ||
      hasDuplicates(selection.proposalIds)) mismatch();
}

export function validateSnapshot(
  snapshot: IndividualExportSnapshot,
  tables: readonly ExportTable[],
  selection: ResolvedExportSelection,
): void {
  const admitted = new Set(tables);
  for (const table of tables) {
    const rows = snapshot.rows[table];
    if (!Array.isArray(rows) || snapshot.counts[table] !== rows.length) {
      throw new IndividualExportFault(409, 'incomplete_snapshot', 'snapshot rows and counts disagree');
    }
    const rowIds = rows.map((row: JsonObject) => row.id);
    if (rowIds.some((id) => typeof id !== 'string' || !validId(id)) ||
        new Set(rowIds).size !== rows.length) {
      throw new IndividualExportFault(409, 'incomplete_snapshot', 'snapshot row identities are invalid or duplicated');
    }
  }
  for (const [table, rows] of Object.entries(snapshot.rows) as [ExportTable, readonly JsonObject[]][]) {
    if (!admitted.has(table) && rows.length > 0) {
      throw new IndividualExportFault(409, 'overbroad_snapshot', 'snapshot returned an unrequested table');
    }
  }
  if (!snapshot.asOf || !snapshot.sourceVersion) {
    throw new IndividualExportFault(409, 'incomplete_snapshot', 'snapshot provenance is missing');
  }
  if (selection.profile === true) assertExactIds(snapshot.rows.profile, 'id', [selection.subjectId]);
  if (selection.requestIds !== undefined) assertExactIds(snapshot.rows.requests, 'id', selection.requestIds);
  if (selection.proposalIds !== undefined) assertExactIds(snapshot.rows.proposals, 'id', selection.proposalIds);
  if (selection.auditResourceIds !== undefined) {
    assertExactIds(snapshot.rows.audit_events, 'resource_id', selection.auditResourceIds);
  }
}

export interface CanonicalIndividualExport {
  readonly manifest: {
    readonly schema: 'seniorsocial.individual-export.v1';
    readonly subjectId: string;
    readonly scope: readonly ExportSection[];
    readonly includedTables: readonly ExportTable[];
    readonly excludedSections: readonly ExportSection[];
    readonly counts: Readonly<Partial<Record<ExportTable, number>>>;
    readonly asOf: string;
    readonly sourceVersion: string;
    readonly completeness: 'complete';
    readonly knownOmissions: readonly [];
  };
  readonly tables: Readonly<Partial<Record<ExportTable, readonly JsonObject[]>>>;
}

export function canonicalPayload(input: {
  request: IndividualExportRequest;
  selection: ResolvedExportSelection;
  snapshot: IndividualExportSnapshot;
  tables: readonly ExportTable[];
}): CanonicalIndividualExport {
  const counts: Partial<Record<ExportTable, number>> = {};
  const rows: Partial<Record<ExportTable, readonly JsonObject[]>> = {};
  for (const table of input.tables) {
    counts[table] = input.snapshot.counts[table];
    rows[table] = input.snapshot.rows[table];
  }
  return {
    manifest: {
      schema: 'seniorsocial.individual-export.v1',
      subjectId: input.selection.subjectId,
      scope: input.request.scope,
      includedTables: input.tables,
      excludedSections: exportSections.filter((section) => !input.request.scope.includes(section)),
      counts,
      asOf: input.snapshot.asOf,
      sourceVersion: input.snapshot.sourceVersion,
      completeness: 'complete',
      knownOmissions: [],
    },
    tables: rows,
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(
      ([key, child]) => [key, sortValue(child)],
    ));
  }
  return value;
}

function validId(value: string): boolean { return value.length > 0 && value.length <= 200; }
function hasDuplicates(values: readonly string[] | undefined): boolean {
  return values !== undefined && new Set(values).size !== values.length;
}
function assertExactIds(rows: readonly JsonObject[], field: string, selected: readonly string[]): void {
  if (rows.some((row) => typeof row[field] !== 'string')) {
    throw new IndividualExportFault(409, 'incomplete_snapshot', 'snapshot selector identity is missing');
  }
  const actual = new Set(rows.map((row) => row[field]).filter((value): value is string => typeof value === 'string'));
  const expected = new Set(selected);
  if (actual.size !== expected.size || [...actual].some((id) => !expected.has(id))) {
    throw new IndividualExportFault(409, 'incomplete_snapshot', 'snapshot does not exactly cover resolved selectors');
  }
}
function invalid(message: string): never { throw new IndividualExportFault(422, 'invalid_request', message); }
function mismatch(): never {
  throw new IndividualExportFault(422, 'selector_mismatch', 'selectors must exactly match requested sections');
}
