import { describe, expect, it, vi } from 'vitest';
import { createServicesService, ServiceValidationError } from '../../../packages/services/src/index.ts';
import type { LocalizedServiceInput, Service } from '../../../packages/services/src/index.ts';

const context = { orgId: '11111111-1111-4111-8111-111111111111', actorId: '11111111-1111-4111-8111-111111111101' };
const input: LocalizedServiceInput = {
  externalId: 'meal-1', categoryId: '11111111-1111-4111-8111-111111111141', nameEn: 'Meal delivery', nameEs: 'Entrega de comidas',
  sourceUpdatedAt: '2026-09-10T12:00:00Z', languages: ['en', 'es'], accessibility: ['wheelchair'],
};
const service: Service = {
  id: '11111111-1111-4111-8111-111111111151', org_id: context.orgId, category_id: input.categoryId,
  name: input.nameEn, description: '', eligibility_note: '', phone: '', languages: ['en', 'es'],
  accessibility: ['wheelchair'], source_updated_at: '2026-09-10T12:00:00.000Z',
};

describe('services application service', () => {
  // what_bug_this_catches: the application layer relabels an unexpected repository/audit outage as validation.
  it('preserves unexpected transactional errors', async () => {
    const repository = {
      listCategories: vi.fn(), get: vi.fn(), search: vi.fn(), update: vi.fn(), importRows: vi.fn(),
      create: vi.fn(async () => service),
    };
    await expect(createServicesService(repository).create(context, input, 'en')).resolves.toEqual(service);

    repository.create.mockRejectedValueOnce(new Error('rollback'));
    await expect(createServicesService(repository).create(context, input, 'en')).rejects.toThrow('rollback');
  });

  // what_bug_this_catches: rejected CSV rows are partially filled and written alongside valid rows without a reason.
  it('writes only fully accepted rows and reports create/update/rejection explicitly', async () => {
    const repository = {
      listCategories: vi.fn(), get: vi.fn(), search: vi.fn(), create: vi.fn(), update: vi.fn(),
      importRows: vi.fn(async (_orgId: string, _actorId: string, rows: readonly { row: number }[]) => ({
        importId: '11111111-1111-4111-8111-111111111190',
        imported: rows.map((row, index) => ({ row: row.row, id: service.id, outcome: index ? 'updated' as const : 'created' as const })),
        rejected: [],
      })),
    };
    const header = 'external_id,name_en,name_es,category_id,source_updated_at';
    const csv = `${header}\na,Meals,Comidas,${input.categoryId},2026-09-10T12:00:00Z\nb,=bad,Comidas,${input.categoryId},2026-09-10T12:00:00Z\nc,Rides,Viajes,${input.categoryId},2026-09-10T12:00:00Z`;
    const report = await createServicesService(repository).importCsv(context, new TextEncoder().encode(csv));
    expect(repository.importRows.mock.calls[0]?.[2]).toHaveLength(2);
    expect(report).toMatchObject({ created: 1, updated: 1, rejected: 1 });
    expect(report.rows[1]).toMatchObject({ outcome: 'rejected', reasons: ['name_en begins with a spreadsheet formula character'] });
  });

  // what_bug_this_catches: PATCH rewrites omitted fields and reports every possible field instead of the one edited.
  it('audits a phone-only partial patch with only the phone field', async () => {
    const repository = {
      listCategories: vi.fn(), get: vi.fn(), search: vi.fn(), create: vi.fn(), importRows: vi.fn(),
      update: vi.fn(async () => ({ service: { ...service, phone: '555-0110' }, changedFields: ['phone'], didWrite: true })),
    };
    const updated = await createServicesService(repository).update(context, service.id, { phone: '555-0110' }, 'en');
    expect(updated?.phone).toBe('555-0110');
    expect(repository.update).toHaveBeenCalledWith(context.orgId, context.actorId, service.id, { phone: '555-0110' }, 'en');
  });

  // what_bug_this_catches: API adapters cannot distinguish a safe 422 input failure from a database or audit outage.
  it('uses a typed error only for context and input validation', async () => {
    const repository = {
      listCategories: vi.fn(), get: vi.fn(), search: vi.fn(), create: vi.fn(), update: vi.fn(), importRows: vi.fn(),
    };
    const app = createServicesService(repository);
    await expect(app.create(context, { ...input, nameEs: '' }, 'en')).rejects.toBeInstanceOf(ServiceValidationError);
    await expect(app.importCsv({ ...context, actorId: 'not-a-uuid' }, new Uint8Array())).rejects.toBeInstanceOf(ServiceValidationError);
    expect(repository.create).not.toHaveBeenCalled();
    expect(repository.importRows).not.toHaveBeenCalled();
  });
});
