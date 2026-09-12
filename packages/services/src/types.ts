export const serviceLocales = ['en', 'es'] as const;
export type ServiceLocale = (typeof serviceLocales)[number];

/** Public representation matching the locked Service contract. */
export interface Service {
  id: string;
  org_id: string;
  name: string;
  category_id: string;
  description: string;
  eligibility_note: string;
  phone: string;
  languages: string[];
  accessibility: string[];
  source_updated_at: string;
}

/** Public representation matching the locked ServiceCategory contract. */
export interface ServiceCategory { id: string; label_en: string; label_es: string }
export interface ServicePage { items: Service[]; meta: { next_cursor: string | null } }

export interface CreateServiceInput {
  externalId?: string;
  categoryId: string;
  nameEn: string;
  nameEs: string;
  descriptionEn?: string;
  descriptionEs?: string;
  eligibilityNoteEn?: string;
  eligibilityNoteEs?: string;
  phone?: string;
  languages?: readonly string[];
  accessibility?: readonly string[];
  sourceUpdatedAt: string;
}
/** Backwards-compatible name for staff POST and CSV complete rows. */
export type LocalizedServiceInput = CreateServiceInput;
export type PatchServiceInput = Partial<CreateServiceInput>;

export interface ServiceSearch {
  query?: string;
  categoryId?: string;
  language?: string;
  accessibility?: string;
  locale: ServiceLocale;
  cursor?: string;
  limit?: number;
}

export interface ServiceContext { orgId: string; actorId: string }
export interface ServiceMutationResult { service: Service; changedFields: string[]; didWrite: boolean }

export interface ServiceAuditIntent {
  actor: string;
  on_behalf_of: null;
  action: 'service.updated';
  target: string;
  org_id: string;
  outcome: 'allowed';
  reason: string;
  fields: string[];
}
export interface ServicesSql {
  query<T>(text: string, values: readonly (string | number | null)[]): Promise<T[]>;
  /** Persists through the same TenantTransaction; rejection must abort and roll back the domain write. */
  audit(intent: ServiceAuditIntent): Promise<void>;
}
/** Compatible with an adapter over packages/db withOrg; it resolves only after commit. */
export type OrgTransaction = <T>(orgId: string, work: (sql: ServicesSql) => Promise<T>) => Promise<T>;

export interface ImportRowResult {
  row: number;
  externalId: string | null;
  outcome: 'created' | 'updated' | 'rejected';
  reasons: string[];
  serviceId?: string;
}
export interface ImportReport {
  importId: string | null;
  created: number;
  updated: number;
  rejected: number;
  rows: ImportRowResult[];
}
