import { parseServicesCsv } from './csv.ts';
import { ServiceValidationError } from './errors.ts';
import type { ServicesRepository } from './repository.ts';
import type {
  CreateServiceInput, ImportReport, PatchServiceInput, ServiceContext, ServiceLocale, ServiceSearch,
} from './types.ts';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const languageCode = /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/u;
const accessibilityCode = /^[a-z0-9][a-z0-9_-]{0,63}$/u;

function validateContext(context: ServiceContext): void {
  if (!uuid.test(context.orgId) || !uuid.test(context.actorId)) {
    throw new ServiceValidationError('Trusted service context requires UUID identifiers');
  }
}

function validateTagFields(input: PatchServiceInput): void {
  if ((input.languages ?? []).some(code => !languageCode.test(code))) throw new ServiceValidationError('languages contains an invalid code');
  if ((input.accessibility ?? []).some(code => !accessibilityCode.test(code))) throw new ServiceValidationError('accessibility contains an invalid code');
}

function validateTimestamp(timestamp: string | undefined): void {
  if (timestamp === undefined) return;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(timestamp)
    || Number.isNaN(Date.parse(timestamp))) {
    throw new ServiceValidationError('sourceUpdatedAt must be an RFC 3339 timestamp');
  }
}

function validateCreate(context: ServiceContext, input: CreateServiceInput): void {
  validateContext(context);
  if (!uuid.test(input.categoryId)) throw new ServiceValidationError('categoryId must be a UUID');
  if (!input.nameEn.trim() || !input.nameEs.trim()) throw new ServiceValidationError('English and Spanish names are required');
  validateTagFields(input);
  validateTimestamp(input.sourceUpdatedAt);
}

function validatePatch(context: ServiceContext, input: PatchServiceInput): void {
  validateContext(context);
  if (input.categoryId !== undefined && !uuid.test(input.categoryId)) throw new ServiceValidationError('categoryId must be a UUID');
  if (input.nameEn !== undefined && !input.nameEn.trim()) throw new ServiceValidationError('nameEn cannot be empty');
  if (input.nameEs !== undefined && !input.nameEs.trim()) throw new ServiceValidationError('nameEs cannot be empty');
  validateTagFields(input);
  validateTimestamp(input.sourceUpdatedAt);
}

export function createServicesService(repository: ServicesRepository) {
  return {
    listCategories: (orgId: string) => repository.listCategories(orgId),
    get: (orgId: string, id: string, locale: ServiceLocale) => repository.get(orgId, id, locale),
    search: (orgId: string, input: ServiceSearch) => repository.search(orgId, input),
    create: async (context: ServiceContext, input: CreateServiceInput, locale: ServiceLocale) => {
      validateCreate(context, input);
      const service = await repository.create(context.orgId, context.actorId, input, locale);
      if (!service) throw new Error('Service write failed');
      return service;
    },
    update: async (context: ServiceContext, id: string, input: PatchServiceInput, locale: ServiceLocale) => {
      validatePatch(context, input);
      const mutation = await repository.update(context.orgId, context.actorId, id, input, locale);
      if (!mutation) return null;
      return mutation.service;
    },
    importCsv: async (context: ServiceContext, source: Uint8Array): Promise<ImportReport> => {
      validateContext(context);
      const parsed = parseServicesCsv(source);
      const accepted = parsed.flatMap(row => row.input ? [{ row: row.row, input: row.input }] : []);
      for (const row of accepted) validateCreate(context, row.input);
      const committed = await repository.importRows(context.orgId, context.actorId, accepted, parsed.length - accepted.length);
      const byRow = new Map(committed.imported.map(item => [item.row, item]));
      const rejectedByRepository = new Map(committed.rejected.map(item => [item.row, item.reason]));
      const rows = parsed.map(row => {
        const item = byRow.get(row.row);
        return item
          ? { row: row.row, externalId: row.externalId, outcome: item.outcome, reasons: [], serviceId: item.id }
          : { row: row.row, externalId: row.externalId, outcome: 'rejected' as const,
              reasons: rejectedByRepository.has(row.row) ? [rejectedByRepository.get(row.row) ?? 'row rejected'] : row.reasons };
      });
      return {
        importId: committed.importId,
        created: rows.filter(row => row.outcome === 'created').length,
        updated: rows.filter(row => row.outcome === 'updated').length,
        rejected: rows.filter(row => row.outcome === 'rejected').length,
        rows,
      };
    },
  };
}
