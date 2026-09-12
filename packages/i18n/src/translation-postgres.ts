import { TranslationConflict, type QualifiedReviewerRegistry, type TranslationDraft, type TranslationProvenance, type TranslationRepository, type TranslationSource, type TranslationView } from './translation-workflow';

export interface TranslationSql { <T extends readonly Record<string, unknown>[]>(strings: TemplateStringsArray, ...values: readonly unknown[]): PromiseLike<T> }
type RuntimeRoleRow = { can_login: boolean; is_superuser: boolean; bypasses_rls: boolean; owns_translation_table: boolean; mutates_translation_table: boolean };
export async function assertTranslationRuntimeRole(sql: TranslationSql): Promise<void> {
  const rows = await sql<RuntimeRoleRow[]>`
    SELECT r.rolcanlogin AS can_login,r.rolsuper AS is_superuser,r.rolbypassrls AS bypasses_rls,
      EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN ('translation_sources','translation_qualified_reviewers','translation_reviewer_events','translation_drafts','translation_events') AND pg_get_userbyid(c.relowner)=current_user) AS owns_translation_table,
      EXISTS(SELECT 1 FROM (VALUES ('translation_sources'),('translation_qualified_reviewers'),('translation_reviewer_events'),('translation_drafts'),('translation_events')) AS t(name)
        WHERE has_table_privilege(current_user,'public.'||t.name,'INSERT') OR has_table_privilege(current_user,'public.'||t.name,'UPDATE') OR has_table_privilege(current_user,'public.'||t.name,'DELETE') OR has_table_privilege(current_user,'public.'||t.name,'TRUNCATE')) AS mutates_translation_table
    FROM pg_roles r WHERE r.rolname=current_user`;
  const role = rows[0];
  if (!role?.can_login || role.is_superuser || role.bypasses_rls || role.owns_translation_table || role.mutates_translation_table) throw new Error('translation runtime requires a constrained dedicated LOGIN role');
}
type SourceRow = { id: string; org_id: string; resource_key: string; source_text: string; source_hash: string; source_version: string | number; critical: boolean; updated_at: Date | string };
type DraftRow = { id: string; org_id: string; source_id: string; source_hash: string; source_version: string | number; translated_text: string; provenance: TranslationProvenance; machine_generated: boolean; ai_event_id: string | null; status: TranslationDraft['status']; created_by: string; created_at: Date | string; reviewed_by: string | null; reviewer_qualification: string | null; reviewer_note: string | null; reviewed_at: Date | string | null; published_by: string | null; published_at: Date | string | null };
const iso = (value: Date | string): string => value instanceof Date ? value.toISOString() : value;
const optionalIso = (value: Date | string | null): string | null => value === null ? null : iso(value);
function source(row: SourceRow): TranslationSource { return { id: row.id, orgId: row.org_id, key: row.resource_key, text: row.source_text, hash: row.source_hash, version: Number(row.source_version), critical: row.critical, updatedAt: iso(row.updated_at) }; }
function draft(row: DraftRow, siblingPublished = false): TranslationDraft {
  return { id: row.id, orgId: row.org_id, sourceId: row.source_id, sourceHash: row.source_hash, sourceVersion: Number(row.source_version), text: row.translated_text, provenance: row.provenance, machineGenerated: row.machine_generated, aiEventId: row.ai_event_id, status: row.status, createdBy: row.created_by, createdAt: iso(row.created_at), reviewedBy: row.reviewed_by, reviewerQualification: row.reviewer_qualification, reviewerNote: row.reviewer_note, reviewedAt: optionalIso(row.reviewed_at), publishedBy: row.published_by, publishedAt: optionalIso(row.published_at), publishable: row.status === 'approved' && row.published_at === null && !siblingPublished };
}

export class PostgresQualifiedReviewerRegistry implements QualifiedReviewerRegistry {
  constructor(private readonly sql: TranslationSql) {}
  async resolve(orgId: string, userId: string) {
    const rows = await this.sql<{ qualification: string; granted_by: string }[]>`SELECT qualification,granted_by FROM translation_qualified_reviewers WHERE org_id=${orgId} AND user_id=${userId} AND revoked_at IS NULL`;
    return rows[0] ? { qualification: rows[0].qualification, grantedBy: rows[0].granted_by } : null;
  }
}

export class PostgresTranslationRepository implements TranslationRepository {
  constructor(private readonly sql: TranslationSql) {}
  async list(orgId: string): Promise<readonly TranslationView[]> {
    const sources = await this.sql<SourceRow[]>`SELECT * FROM translation_sources WHERE org_id=${orgId} ORDER BY resource_key`;
    const drafts = await this.sql<DraftRow[]>`SELECT * FROM translation_drafts WHERE org_id=${orgId} ORDER BY source_id,created_at DESC`;
    const publishedSources = new Set(drafts.filter(item => item.status === 'approved' && item.published_at !== null).map(item => item.source_id));
    return sources.map(row => ({ source: source(row), history: drafts.filter(item => item.source_id === row.id).map(item => draft(item, publishedSources.has(row.id))) }));
  }
  async source(orgId: string, sourceId: string): Promise<TranslationSource | null> {
    const rows = await this.sql<SourceRow[]>`SELECT * FROM translation_sources WHERE org_id=${orgId} AND id=${sourceId}`; return rows[0] ? source(rows[0]) : null;
  }
  async draft(orgId: string, draftId: string): Promise<TranslationDraft | null> {
    const rows = await this.sql<DraftRow[]>`SELECT * FROM translation_drafts WHERE org_id=${orgId} AND id=${draftId}`; return rows[0] ? draft(rows[0]) : null;
  }
  async upsertSource(input: { orgId: string; key: string; text: string; hash: string; critical: boolean; actorId: string }): Promise<TranslationSource> {
    const rows = await this.sql<SourceRow[]>`SELECT * FROM wp021_upsert_translation_source(${input.orgId},${input.key},${input.text},${input.critical},${input.actorId})`;
    if (!rows[0]) throw new Error('source update failed'); return source(rows[0]);
  }
  async createDraft(input: { orgId: string; source: TranslationSource; text: string; provenance: TranslationProvenance; aiEventId: string | null; actorId: string }): Promise<TranslationDraft> {
    const rows = await this.sql<DraftRow[]>`SELECT * FROM wp021_create_translation_draft(${input.orgId},${input.source.id},${input.source.hash},${input.source.version},${input.text},${input.provenance},${input.aiEventId},${input.actorId})`;
    if (!rows[0]) throw new TranslationConflict('stale translation source'); return draft(rows[0]);
  }
  async approve(input: { orgId: string; draftId: string; sourceHash: string; sourceVersion: number; actorId: string; qualification: string; note: string }): Promise<TranslationDraft | null> {
    const rows = await this.sql<DraftRow[]>`SELECT * FROM wp021_approve_translation(${input.orgId},${input.draftId},${input.sourceHash},${input.sourceVersion},${input.actorId},${input.note})`;
    const row = rows[0]; if (!row) return null;
    const sibling = await this.sql<{ published: boolean }[]>`SELECT EXISTS(SELECT 1 FROM translation_drafts WHERE org_id=${input.orgId} AND source_id=${row.source_id} AND id<>${row.id} AND source_hash=${row.source_hash} AND source_version=${row.source_version} AND published_at IS NOT NULL) AS published`;
    return draft(row, sibling[0]?.published ?? true);
  }
  async publish(input: { orgId: string; draftId: string; sourceHash: string; sourceVersion: number; actorId: string; qualification: string }): Promise<TranslationDraft | null> {
    try {
      const rows = await this.sql<DraftRow[]>`SELECT * FROM wp021_publish_translation(${input.orgId},${input.draftId},${input.sourceHash},${input.sourceVersion},${input.actorId})`; return rows[0] ? draft(rows[0]) : null;
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') return null;
      throw error;
    }
  }
}
